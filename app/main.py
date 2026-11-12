"""FastAPI app: REST API, PayPal return/cancel handlers and the web UI."""
from __future__ import annotations

import html as htmllib
import json
from decimal import Decimal
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import attacks
from .agent import ShoppingAgent
from .demo_agent import SCRIPTS, ScriptedClient
from .config import settings
from .container import get_gateway
from .crypto import b64url_decode
from .models import Constraints
from .paypal import MockPayPal

STATIC = Path(__file__).parent / "static"

app = FastAPI(title="Mandate for PayPal", version="0.1.0",
              description="A signed spending mandate that keeps AI shopping agents inside the limits a user set, enforced before any PayPal call.")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


# ----------------------------------------------------------------------------- schemas
class MandateIn(BaseModel):
    description: str = Field(min_length=3, max_length=300)
    per_txn_max: Decimal = Field(gt=0)
    total_max: Decimal = Field(gt=0)
    step_up_above: Decimal = Field(ge=0)
    allowed_categories: list[str] = Field(default_factory=list)
    max_quantity_per_item: int = Field(default=5, ge=1, le=100)
    valid_days: int = Field(default=30, ge=1, le=365)


class AgentIn(BaseModel):
    mandate_id: str
    task: str = Field(min_length=3, max_length=1000)
    hardened: bool | None = None


class DemoIn(BaseModel):
    mandate_id: str
    script: str = "fooled_by_gift_card"


class PurchaseIn(BaseModel):
    mandate_id: str
    product_id: str
    quantity: int = Field(default=1, ge=1)


# ----------------------------------------------------------------------------- helpers
def _cart_summary(cart_jws: str) -> dict:
    payload = json.loads(b64url_decode(cart_jws.split(".")[1]))
    item = payload["items"][0]
    return {"product": item["name"], "product_id": item["product_id"], "quantity": item["quantity"],
            "category": item["category"], "merchant_id": item["merchant_id"]}


def _order_view(o: dict) -> dict:
    return {
        "paypal_order_id": o["paypal_order_id"],
        "payment_mandate_id": o["payment_mandate_id"],
        "mandate_id": o["mandate_id"],
        "amount": o["amount"],
        "currency": o["currency"],
        "status": o["status"],
        "step_up": bool(o["step_up"]),
        "approve_url": o["approve_url"] if o["status"] == "awaiting_approval" else None,
        "capture_id": o["capture_id"],
        "created_at": o["created_at"],
        **_cart_summary(o["cart_jws"]),
    }


# ----------------------------------------------------------------------------- UI
@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/healthz", include_in_schema=False)
def healthz() -> dict:
    return {"ok": True}


# ----------------------------------------------------------------------------- API
@app.get("/api/config")
def config() -> dict:
    gw = get_gateway()
    return {
        "paypal_mode": gw.paypal.mode,
        "vault_enabled": gw.vault_enabled,
        "agent_ready": bool(settings.anthropic_api_key),
        "model": settings.anthropic_model,
        "currency": settings.currency,
        "identities": {"user": gw.user.did, "agent": gw.agent.did, "merchant": gw.merchant.identity.did},
        "categories": sorted({p["category"] for p in gw.catalog.products.values()}),
    }


@app.get("/api/state")
def state() -> dict:
    gw = get_gateway()
    mandates = []
    for row in gw.ledger.list_mandates():
        try:
            intent, _ = gw.load_intent(row["id"])
        except Exception:  # noqa: BLE001
            continue
        if intent.description == "Red-team mandate":
            continue
        mandates.append({
            "id": intent.id,
            "description": intent.description,
            "constraints": intent.constraints.model_dump(mode="json"),
            "valid_until": intent.valid_until.isoformat(),
            "agent": intent.agent,
            "budget": gw.budget(intent.id),
        })
    visible = {m["id"] for m in mandates}
    orders = [_order_view(o) for o in gw.ledger.list_orders() if o["mandate_id"] in visible and o["paypal_order_id"]]
    events = [e for e in gw.ledger.events(limit=80) if e["mandate_id"] is None or e["mandate_id"] in visible]
    return {"mandates": mandates, "orders": orders, "denials": _denials(gw, visible),
            "events": events[:40], "chain": gw.ledger.verify_chain()}


def _denials(gw, visible: set[str], limit: int = 100) -> list[dict]:
    """Blocked purchase attempts on the user's own mandates, newest first."""
    out = []
    for e in gw.ledger.events(limit=2000):
        if e["type"] != "purchase.denied" or e["mandate_id"] not in visible:
            continue
        p = e["payload"]
        cart = p.get("cart") or {}
        item = (cart.get("items") or [{}])[0]
        product_id = item.get("product_id") or p.get("product_id")
        product = gw.catalog.products.get(product_id or "", {})
        quantity = item.get("quantity") or p.get("quantity") or 1
        amount = cart.get("total") or (str((Decimal(product["price"]) * int(quantity)).quantize(Decimal("0.01"))) if product else None)
        decision = p.get("decision") or {"reasons": [p.get("reason", "")], "rules": [p.get("rule", "")]}
        out.append({
            "seq": e["seq"],
            "ts": e["ts"],
            "mandate_id": e["mandate_id"],
            "product_id": product_id,
            "product": item.get("name") or product.get("name") or product_id,
            "quantity": quantity,
            "amount": amount,
            "reasons": decision.get("reasons", []),
            "rules": decision.get("rules", []),
        })
        if len(out) >= limit:
            break
    return out


@app.post("/api/mandates")
def create_mandate(body: MandateIn) -> dict:
    if body.step_up_above > body.per_txn_max:
        raise HTTPException(422, "The step-up threshold should not exceed the per-purchase cap.")
    if body.per_txn_max > body.total_max:
        raise HTTPException(422, "The per-purchase cap cannot exceed the total budget.")
    cons = Constraints(
        currency=settings.currency,
        per_txn_max=body.per_txn_max,
        total_max=body.total_max,
        step_up_above=body.step_up_above,
        allowed_categories=body.allowed_categories,
        max_quantity_per_item=body.max_quantity_per_item,
    )
    return get_gateway().create_mandate(body.description, cons, valid_days=body.valid_days)


@app.post("/api/mandates/{mandate_id}/revoke")
def revoke(mandate_id: str) -> dict:
    try:
        return get_gateway().revoke_mandate(mandate_id)
    except KeyError:
        raise HTTPException(404, "Mandate not found")


@app.get("/api/products")
def products(q: str = "") -> dict:
    gw = get_gateway()
    items = gw.catalog.search(q, limit=50) if q else [gw.catalog.public_view(p) for p in gw.catalog.products.values()]
    return {"products": items}


@app.post("/api/agent/run")
def run_agent(body: AgentIn) -> dict:
    gw = get_gateway()
    if not gw.ledger.get_mandate(body.mandate_id):
        raise HTTPException(404, "Mandate not found")
    run = ShoppingAgent(gw, hardened=body.hardened).run(body.task, body.mandate_id)
    gw.ledger.append_event("agent.run", {"task": body.task, "purchases": len(run.purchases), "error": run.error}, body.mandate_id)
    return run.to_dict()


@app.post("/api/agent/demo")
def run_demo_agent(body: DemoIn) -> dict:
    """Replays a scripted model through the real gateway (for demos without an API key)."""
    gw = get_gateway()
    if not gw.ledger.get_mandate(body.mandate_id):
        raise HTTPException(404, "Mandate not found")
    if body.script not in SCRIPTS:
        raise HTTPException(404, f"Unknown script. Options: {', '.join(SCRIPTS)}")
    run = ShoppingAgent(gw, client=ScriptedClient(body.script)).run(f"[scripted: {body.script}]", body.mandate_id)
    gw.ledger.append_event("agent.scripted_run", {"script": body.script, "purchases": len(run.purchases)}, body.mandate_id)
    return {**run.to_dict(), "scripted": True}


@app.post("/api/purchase")
def manual_purchase(body: PurchaseIn) -> dict:
    """Make a purchase exactly as the agent would (signed with the agent key)."""
    gw = get_gateway()
    return gw.purchase(gw.sign_request(body.mandate_id, body.product_id, body.quantity))


@app.get("/api/attacks")
def list_attacks() -> dict:
    return {"attacks": [{"id": a[0], "name": a[1], "owasp": a[2], "description": a[4], "expected": a[5]} for a in attacks.ATTACKS]}


@app.post("/api/attacks/run")
def run_attacks() -> dict:
    return attacks.run_all(get_gateway())


@app.post("/api/attacks/{attack_id}")
def run_one_attack(attack_id: str) -> dict:
    try:
        return attacks.run_attack(get_gateway(), attack_id).to_dict()
    except KeyError:
        raise HTTPException(404, "Unknown attack")


@app.get("/api/evidence/{order_id}")
def evidence(order_id: str) -> JSONResponse:
    try:
        data = get_gateway().evidence(order_id)
    except KeyError:
        raise HTTPException(404, "Order not found")
    return JSONResponse(data, headers={"Content-Disposition": f'inline; filename="evidence-{order_id}.json"'})


@app.get("/api/ledger/verify")
def verify_ledger() -> dict:
    return get_gateway().ledger.verify_chain()


@app.post("/api/orders/{order_id}/cancel")
def cancel_order(order_id: str) -> dict:
    try:
        return get_gateway().cancel(order_id)
    except KeyError:
        raise HTTPException(404, "Order not found")


# ----------------------------------------------------------------------------- PayPal redirects
@app.get("/paypal/return", include_in_schema=False)
def paypal_return(token: str) -> RedirectResponse:
    """PayPal sends the buyer here after approval; `token` is the PayPal order id."""
    try:
        result = get_gateway().complete_approval(token)
    except KeyError:
        return RedirectResponse(f"/?paypal=unknown&order={token}", status_code=303)
    return RedirectResponse(f"/?paypal={result['status']}&order={token}", status_code=303)


@app.get("/paypal/cancel", include_in_schema=False)
def paypal_cancel(token: str) -> RedirectResponse:
    try:
        get_gateway().cancel(token)
    except KeyError:
        pass
    return RedirectResponse(f"/?paypal=cancelled&order={token}", status_code=303)


# ----------------------------------------------------------------------------- offline mock checkout
@app.get("/mock-paypal/approve/{order_id}", include_in_schema=False)
def mock_checkout(order_id: str) -> HTMLResponse:
    gw = get_gateway()
    if not isinstance(gw.paypal, MockPayPal) or order_id not in gw.paypal.orders:
        raise HTTPException(404, "Mock checkout is only available in PAYPAL_MODE=mock")
    order = gw.ledger.get_order(order_id)
    summary = _cart_summary(order["cart_jws"]) if order else {"product": "Unknown", "quantity": 1}
    html = (STATIC / "mock_checkout.html").read_text()
    fields = {
        "{{ORDER_ID}}": order_id,
        "{{PRODUCT}}": summary["product"],
        "{{QUANTITY}}": str(summary["quantity"]),
        "{{AMOUNT}}": (("$" if (order or {}).get("currency", settings.currency) == "USD" else "") + (order["amount"] if order else "0.00")),
        "{{CURRENCY}}": order["currency"] if order else settings.currency,
    }
    for key, value in fields.items():
        html = html.replace(key, htmllib.escape(value))
    return HTMLResponse(html)


@app.post("/mock-paypal/approve/{order_id}", include_in_schema=False)
async def mock_checkout_decide(order_id: str, request: Request) -> RedirectResponse:
    gw = get_gateway()
    if not isinstance(gw.paypal, MockPayPal):
        raise HTTPException(404)
    form = await request.form()
    if form.get("decision") == "approve":
        gw.paypal.approve(order_id)
        return RedirectResponse(f"/paypal/return?token={order_id}", status_code=303)
    return RedirectResponse(f"/paypal/cancel?token={order_id}", status_code=303)
