"""PayPal Orders v2 client (sandbox) plus an offline mock with the same interface.

Real mode uses:
  POST /v1/oauth2/token                       client-credentials access token
  POST /v2/checkout/orders                    create order (PayPal-Request-Id = Payment Mandate id)
  POST /v2/checkout/orders/{id}/capture       capture after buyer approval
  GET  /v2/checkout/orders/{id}               read status / saved-wallet vault id

Saved wallet ("vault"): the first approved order can save the buyer's PayPal wallet
(store_in_vault=ON_SUCCESS). Later in-mandate purchases then pay with vault_id and need
no redirect. Purchases above the step-up threshold never use the vault, so the human
must approve them on PayPal. Saving wallets must be enabled for your sandbox app.
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Protocol

import httpx

from .config import settings
from .models import CartMandate


class PayPalError(Exception):
    def __init__(self, message: str, status: int | None = None, details: Any = None):
        super().__init__(message)
        self.status = status
        self.details = details


@dataclass
class OrderResult:
    order_id: str
    status: str  # PAYER_ACTION_REQUIRED | CREATED | APPROVED | COMPLETED | ...
    approve_url: str | None = None
    capture_id: str | None = None
    vault_id: str | None = None
    raw: dict | None = None


class PayPalClient(Protocol):
    mode: str

    def create_order(self, cart: CartMandate, request_id: str, custom_id: str, *, vault_id: str | None = None, save_wallet: bool = False) -> OrderResult: ...

    def capture(self, order_id: str, request_id: str) -> OrderResult: ...


def _money(v: Decimal, currency: str) -> dict:
    return {"currency_code": currency, "value": f"{v:.2f}"}


def build_order_body(cart: CartMandate, custom_id: str, *, vault_id: str | None, save_wallet: bool) -> dict:
    items = [
        {
            "name": item.name[:127],
            "sku": item.product_id[:127],
            "quantity": str(item.quantity),
            "unit_amount": _money(item.unit_price, cart.currency),
            "category": "PHYSICAL_GOODS",
        }
        for item in cart.items
    ]
    if vault_id:
        paypal_source: dict[str, Any] = {"vault_id": vault_id}
    else:
        paypal_source = {
            "experience_context": {
                "brand_name": settings.brand_name[:127],
                "user_action": "PAY_NOW",
                "shipping_preference": "NO_SHIPPING",
                "return_url": f"{settings.public_base_url}/paypal/return",
                "cancel_url": f"{settings.public_base_url}/paypal/cancel",
            }
        }
        if save_wallet:
            paypal_source["attributes"] = {
                "vault": {"store_in_vault": "ON_SUCCESS", "usage_type": "MERCHANT", "customer_type": "CONSUMER"}
            }
    return {
        "intent": "CAPTURE",
        "payment_source": {"paypal": paypal_source},
        "purchase_units": [
            {
                "reference_id": cart.id[:256],
                "custom_id": custom_id[:127],
                "description": f"Agent purchase under mandate {cart.intent_id}"[:127],
                "amount": {**_money(cart.total, cart.currency), "breakdown": {"item_total": _money(cart.total, cart.currency)}},
                "items": items,
            }
        ],
    }


def _parse_order(data: dict) -> OrderResult:
    approve = next((l["href"] for l in data.get("links", []) if l.get("rel") in ("payer-action", "approve")), None)
    capture_id = None
    for pu in data.get("purchase_units", []):
        for cap in (pu.get("payments") or {}).get("captures", []) or []:
            capture_id = cap.get("id")
    vault_id = (((data.get("payment_source") or {}).get("paypal") or {}).get("attributes") or {}).get("vault", {}).get("id")
    return OrderResult(order_id=data["id"], status=data.get("status", "UNKNOWN"), approve_url=approve, capture_id=capture_id, vault_id=vault_id, raw=data)


class SandboxPayPal:
    mode = "sandbox"

    def __init__(self, client_id: str, client_secret: str, base_url: str):
        if not client_id or not client_secret:
            raise PayPalError("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required in sandbox mode")
        self._auth = (client_id, client_secret)
        self._http = httpx.Client(base_url=base_url, timeout=30)
        self._token: str | None = None
        self._token_exp = 0.0
        self._lock = threading.Lock()

    def _access_token(self) -> str:
        with self._lock:
            if self._token and time.time() < self._token_exp - 60:
                return self._token
            r = self._http.post("/v1/oauth2/token", data={"grant_type": "client_credentials"}, auth=self._auth)
            if r.status_code != 200:
                raise PayPalError("PayPal auth failed", r.status_code, r.text)
            body = r.json()
            self._token = body["access_token"]
            self._token_exp = time.time() + int(body.get("expires_in", 300))
            return self._token

    def _request(self, method: str, path: str, request_id: str, json: dict | None = None) -> dict:
        headers = {
            "Authorization": f"Bearer {self._access_token()}",
            "Content-Type": "application/json",
            "PayPal-Request-Id": request_id[:108],
            "Prefer": "return=representation",
        }
        r = self._http.request(method, path, headers=headers, json=json if json is not None else {})
        if r.status_code >= 400:
            try:
                details = r.json()
            except ValueError:
                details = r.text
            raise PayPalError(f"PayPal {method} {path} failed", r.status_code, details)
        return r.json()

    def create_order(self, cart, request_id, custom_id, *, vault_id=None, save_wallet=False) -> OrderResult:
        body = build_order_body(cart, custom_id, vault_id=vault_id, save_wallet=save_wallet)
        return _parse_order(self._request("POST", "/v2/checkout/orders", request_id, body))

    def capture(self, order_id, request_id) -> OrderResult:
        return _parse_order(self._request("POST", f"/v2/checkout/orders/{order_id}/capture", f"cap-{request_id}"))


class MockPayPal:
    """Offline stand-in with the same behaviour shape. Idempotent on request_id."""

    mode = "mock"

    def __init__(self) -> None:
        self.orders: dict[str, dict] = {}
        self._by_request: dict[str, str] = {}
        self._lock = threading.Lock()

    def create_order(self, cart, request_id, custom_id, *, vault_id=None, save_wallet=False) -> OrderResult:
        with self._lock:
            if request_id in self._by_request:
                o = self.orders[self._by_request[request_id]]
                return OrderResult(o["id"], o["status"], o.get("approve_url"), o.get("capture_id"), o.get("vault_id"), dict(o))
            order_id = "MOCK-" + uuid.uuid4().hex[:12].upper()
            o = {"id": order_id, "amount": str(cart.total), "currency": cart.currency, "custom_id": custom_id, "save_wallet": save_wallet}
            if vault_id:
                o.update(status="COMPLETED", capture_id="CAP-" + uuid.uuid4().hex[:10].upper(), vault_id=vault_id)
            else:
                o.update(status="PAYER_ACTION_REQUIRED", approve_url=f"{settings.public_base_url}/mock-paypal/approve/{order_id}")
            self.orders[order_id] = o
            self._by_request[request_id] = order_id
            return OrderResult(order_id, o["status"], o.get("approve_url"), o.get("capture_id"), o.get("vault_id"), dict(o))

    def approve(self, order_id: str) -> None:
        with self._lock:
            o = self.orders[order_id]
            if o["status"] == "PAYER_ACTION_REQUIRED":
                o["status"] = "APPROVED"

    def capture(self, order_id, request_id) -> OrderResult:
        with self._lock:
            o = self.orders.get(order_id)
            if not o:
                raise PayPalError("order not found", 404)
            if o["status"] == "COMPLETED":  # idempotent
                return OrderResult(order_id, "COMPLETED", None, o["capture_id"], o.get("vault_id"), dict(o))
            if o["status"] != "APPROVED":
                raise PayPalError("ORDER_NOT_APPROVED", 422)
            o["status"] = "COMPLETED"
            o["capture_id"] = "CAP-" + uuid.uuid4().hex[:10].upper()
            if o.get("save_wallet"):
                o["vault_id"] = "VAULT-" + uuid.uuid4().hex[:8].upper()
            return OrderResult(order_id, "COMPLETED", None, o["capture_id"], o.get("vault_id"), dict(o))


def make_client() -> PayPalClient:
    if settings.paypal_mode == "sandbox":
        return SandboxPayPal(settings.paypal_client_id, settings.paypal_client_secret, settings.paypal_base_url)
    return MockPayPal()
