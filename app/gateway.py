"""The Mandate gateway: the only path from an agent to PayPal.

purchase() runs, in order:
  1. verify the agent's signed request (which agent, fresh, not replayed)
  2. verify the user's signed Intent Mandate (active, delegated to this agent)
  3. obtain and verify a merchant-signed Cart Mandate (prices come from the merchant)
  4. evaluate policy and reserve budget in one serialised transaction
  5. derive the Payment Mandate; its id is the PayPal idempotency key
  6. call PayPal: autonomous capture with the saved wallet, or a PayPal approval link
Every step lands in the hash-chained audit log.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from .catalog import LocalCatalog, Merchant, UnknownProduct
from .config import settings
from .crypto import Identity, SignatureError, canonical_json, sha256_hex, verify_jws
from .ledger import Ledger
from .models import CartMandate, Constraints, IntentMandate, PaymentMandate, PurchaseRequest, utcnow
from .paypal import PayPalClient, PayPalError
from .policy import Decision, evaluate

REQUEST_MAX_AGE = timedelta(minutes=5)


def _result(status: str, **kw: Any) -> dict:
    return {"status": status, **kw}


class MandateGateway:
    def __init__(
        self,
        ledger: Ledger,
        paypal: PayPalClient,
        catalog: LocalCatalog,
        user: Identity,
        agent: Identity,
        merchant_identity: Identity,
        vault_enabled: bool = False,
    ):
        self.ledger = ledger
        self.paypal = paypal
        self.catalog = catalog
        self.user = user
        self.agent = agent
        self.merchant = Merchant(catalog, merchant_identity)
        self.vault_enabled = vault_enabled

    # ------------------------------------------------------------------ mandates
    def create_mandate(self, description: str, constraints: Constraints, valid_days: int = 30, agent_did: str | None = None) -> dict:
        now = utcnow()
        intent = IntentMandate(
            id="im_" + uuid.uuid4().hex[:16],
            issuer=self.user.did,
            agent=agent_did or self.agent.did,
            description=description,
            constraints=constraints,
            valid_from=now,
            valid_until=now + timedelta(days=valid_days),
        )
        jws = self.user.sign(intent.model_dump(mode="json"))
        self.ledger.save_mandate(intent.id, jws)
        self.ledger.append_event("mandate.signed", {"intent": intent.model_dump(mode="json"), "intent_hash": sha256_hex(jws)}, intent.id)
        return {"mandate_id": intent.id, "jws": jws, "intent": intent.model_dump(mode="json")}

    def revoke_mandate(self, mandate_id: str) -> dict:
        row = self.ledger.get_mandate(mandate_id)
        if not row:
            raise KeyError(mandate_id)
        self.ledger.set_mandate_status(mandate_id, "revoked")
        self.ledger.append_event("mandate.revoked", {"by": self.user.did}, mandate_id)
        return {"mandate_id": mandate_id, "status": "revoked"}

    def load_intent(self, mandate_id: str) -> tuple[IntentMandate, dict]:
        row = self.ledger.get_mandate(mandate_id)
        if not row:
            raise KeyError(mandate_id)
        payload, _ = verify_jws(row["jws"], expected_signer=self.user.did)
        return IntentMandate.model_validate(payload), row

    def budget(self, mandate_id: str) -> dict:
        intent, row = self.load_intent(mandate_id)
        committed = self.ledger.committed(mandate_id)
        captured = self.ledger.captured(mandate_id)
        total = intent.constraints.total_max
        return {
            "total_max": str(total),
            "captured": str(captured),
            "committed": str(committed),
            "remaining": str(max(total - committed, Decimal("0.00"))),
            "status": row["status"],
            "wallet_saved": bool(row["vault_id"]),
        }

    # ------------------------------------------------------------------ agent side
    def sign_request(self, mandate_id: str, product_id: str, quantity: int, agent: Identity | None = None, cart_jws: str | None = None) -> str:
        """Helper used by the in-process agent: sign a purchase request with the agent key."""
        req = PurchaseRequest(
            mandate_id=mandate_id,
            product_id=product_id,
            quantity=quantity,
            nonce=uuid.uuid4().hex,
            issued_at=utcnow(),
            cart_jws=cart_jws,
        )
        return (agent or self.agent).sign(req.model_dump(mode="json"))

    def quote(self, mandate_id: str, product_id: str, quantity: int) -> dict:
        """Ask the merchant for a signed cart without buying (lets the agent check a price)."""
        intent, _ = self.load_intent(mandate_id)
        cart, cart_jws = self.merchant.build_cart(intent.id, product_id, quantity, intent.constraints.currency)
        return {"cart": cart.model_dump(mode="json"), "cart_jws": cart_jws}

    # ------------------------------------------------------------------ purchase
    def purchase(self, request_jws: str) -> dict:
        # 1. Agent identity and request freshness
        try:
            req_payload, agent_did = verify_jws(request_jws)
            req = PurchaseRequest.model_validate(req_payload)
        except (SignatureError, ValueError) as exc:
            self.ledger.append_event("purchase.rejected", {"rule": "request.signature", "error": str(exc)})
            return _result("denied", reasons=[f"Request signature invalid: {exc}"], rules=["request.signature"])

        mandate_id = req.mandate_id

        def reject(rule: str, reason: str, **extra: Any) -> dict:
            self.ledger.append_event("purchase.denied", {"rule": rule, "reason": reason, "agent": agent_did, "product_id": req.product_id, "quantity": req.quantity, **extra}, mandate_id)
            return _result("denied", reasons=[reason], rules=[rule])

        now = utcnow()
        if not (now - REQUEST_MAX_AGE <= req.issued_at <= now + timedelta(seconds=30)):
            return reject("request.stale", "Purchase request is too old or from the future.")

        # 2. User-signed intent
        try:
            intent, row = self.load_intent(mandate_id)
        except KeyError:
            return reject("mandate.unknown", f"No mandate {mandate_id}.")
        except SignatureError as exc:
            return reject("mandate.signature", f"Mandate signature invalid: {exc}")
        if row["status"] != "active":
            return reject("mandate.revoked", f"Mandate is {row['status']}.")
        if agent_did != intent.agent:
            return reject("agent.not_delegated", "This agent is not the one the user delegated the mandate to.")

        # 3. Merchant-signed cart
        try:
            if req.cart_jws:
                cart_payload, merchant_did = verify_jws(req.cart_jws, expected_signer=self.merchant.identity.did)
                cart = CartMandate.model_validate(cart_payload)
                cart_jws = req.cart_jws
                item = cart.items[0] if cart.items else None
                if len(cart.items) != 1 or item is None or item.product_id != req.product_id or item.quantity != req.quantity:
                    return reject("cart.request_mismatch", "Signed cart does not match the requested product and quantity.")
            else:
                cart, cart_jws = self.merchant.build_cart(intent.id, req.product_id, req.quantity, intent.constraints.currency)
        except UnknownProduct:
            return reject("product.unknown", f"Unknown product {req.product_id}.")
        except SignatureError as exc:
            return reject("cart.signature", f"Cart is not signed by the merchant: {exc}")

        intent_hash = sha256_hex(row["jws"])
        cart_hash = sha256_hex(cart_jws)
        pm = PaymentMandate(
            id=sha256_hex(intent_hash + cart_hash),
            intent_id=intent.id,
            intent_hash=intent_hash,
            cart_id=cart.id,
            cart_hash=cart_hash,
            agent=agent_did,
            amount=cart.total,
            currency=cart.currency,
            created_at=now,
        )

        # 4. Policy + reservation, atomically
        with self.ledger.transaction() as conn:
            existing = self.ledger.get_order_by_payment_mandate(pm.id, conn)
            if existing:
                # Same intent + same signed cart: idempotent replay, never a second charge.
                self.ledger.append_event("purchase.idempotent_replay", {"payment_mandate_id": pm.id}, mandate_id, existing["paypal_order_id"])
                return _result("duplicate", reasons=["This exact cart was already submitted; no new charge."], rules=["payment.idempotent"],
                               order_id=existing["paypal_order_id"], order_status=existing["status"], amount=existing["amount"])
            if not self.ledger.use_nonce(req.nonce, conn):
                decision = Decision("deny", ["Request nonce already used (replayed request)."], ["request.replay"])
            else:
                committed = self.ledger.committed(mandate_id, conn)
                decision = evaluate(intent, cart, committed, now)
            if decision.outcome == "deny":
                self.ledger.append_event("purchase.denied", {
                    "decision": decision.to_dict(), "agent": agent_did, "cart": cart.model_dump(mode="json"),
                }, mandate_id)
                return _result("denied", reasons=decision.reasons, rules=decision.rules, amount=str(cart.total),
                               product=cart.items[0].name if cart.items else None)
            self.ledger.insert_order(
                conn,
                payment_mandate_id=pm.id,
                mandate_id=mandate_id,
                amount=str(cart.total),
                currency=cart.currency,
                status="reserved",
                step_up=1 if decision.outcome == "step_up" else 0,
                cart_jws=cart_jws,
                request_jws=request_jws,
                decision=canonical_json(decision.to_dict()),
            )
            self.ledger.append_event("purchase.reserved", {
                "decision": decision.to_dict(), "payment_mandate": pm.model_dump(mode="json"), "cart": cart.model_dump(mode="json"),
            }, mandate_id, pm.id)

        # 5. PayPal
        use_vault = self.vault_enabled and decision.outcome == "allow" and bool(row["vault_id"])
        save_wallet = self.vault_enabled and decision.outcome == "allow" and not row["vault_id"]
        try:
            res = self.paypal.create_order(cart, pm.id, pm.id, vault_id=row["vault_id"] if use_vault else None, save_wallet=save_wallet)
            if use_vault and res.status != "COMPLETED":
                res = self.paypal.capture(res.order_id, pm.id)
        except PayPalError as exc:
            self.ledger.update_order(pm.id, status="failed")
            self.ledger.append_event("paypal.error", {"error": str(exc), "status": exc.status, "details": exc.details}, mandate_id, pm.id)
            return _result("error", reasons=[f"PayPal error: {exc}"], rules=["paypal.error"])

        product = cart.items[0].name
        if res.status == "COMPLETED":
            self.ledger.update_order(pm.id, paypal_order_id=res.order_id, status="captured", capture_id=res.capture_id)
            self.ledger.append_event("paypal.captured", {"order_id": res.order_id, "capture_id": res.capture_id, "amount": str(cart.total), "autonomous": True}, mandate_id, res.order_id)
            return _result("captured", order_id=res.order_id, capture_id=res.capture_id, amount=str(cart.total), product=product,
                           reasons=decision.reasons, rules=decision.rules, autonomous=True)

        self.ledger.update_order(pm.id, paypal_order_id=res.order_id, status="awaiting_approval", approve_url=res.approve_url)
        self.ledger.append_event("paypal.order_created", {"order_id": res.order_id, "status": res.status, "step_up": decision.outcome == "step_up"}, mandate_id, res.order_id)
        status = "step_up_required" if decision.outcome == "step_up" else "awaiting_approval"
        return _result(status, order_id=res.order_id, approve_url=res.approve_url, amount=str(cart.total), product=product,
                       reasons=decision.reasons, rules=decision.rules)

    # ------------------------------------------------------------------ approval
    def complete_approval(self, paypal_order_id: str) -> dict:
        order = self.ledger.get_order(paypal_order_id)
        if not order:
            raise KeyError(paypal_order_id)
        if order["status"] == "captured":
            return _result("captured", order_id=paypal_order_id, capture_id=order["capture_id"], amount=order["amount"])
        row = self.ledger.get_mandate(order["mandate_id"])
        if order["status"] != "awaiting_approval" or (row and row["status"] != "active"):
            self.ledger.update_order(order["payment_mandate_id"], status="cancelled")
            self.ledger.append_event("paypal.capture_refused", {"reason": "order no longer payable"}, order["mandate_id"], paypal_order_id)
            return _result("denied", reasons=["Order is no longer payable (mandate revoked or order cancelled)."], rules=["order.not_payable"])
        try:
            res = self.paypal.capture(paypal_order_id, order["payment_mandate_id"])
        except PayPalError as exc:
            self.ledger.append_event("paypal.error", {"error": str(exc), "status": exc.status, "details": exc.details}, order["mandate_id"], paypal_order_id)
            return _result("error", reasons=[f"PayPal error: {exc}"], rules=["paypal.error"])
        self.ledger.update_order(order["payment_mandate_id"], status="captured", capture_id=res.capture_id)
        if res.vault_id:
            self.ledger.set_vault_id(order["mandate_id"], res.vault_id)
            self.ledger.append_event("paypal.wallet_saved", {"vault_id_hash": sha256_hex(res.vault_id)}, order["mandate_id"], paypal_order_id)
        self.ledger.append_event("paypal.captured", {"order_id": paypal_order_id, "capture_id": res.capture_id, "amount": order["amount"], "autonomous": False}, order["mandate_id"], paypal_order_id)
        return _result("captured", order_id=paypal_order_id, capture_id=res.capture_id, amount=order["amount"])

    def cancel(self, paypal_order_id: str) -> dict:
        order = self.ledger.get_order(paypal_order_id)
        if not order:
            raise KeyError(paypal_order_id)
        if order["status"] in ("awaiting_approval", "reserved"):
            self.ledger.update_order(order["payment_mandate_id"], status="cancelled")
            self.ledger.append_event("paypal.cancelled", {"order_id": paypal_order_id}, order["mandate_id"], paypal_order_id)
        return _result("cancelled", order_id=paypal_order_id)

    # ------------------------------------------------------------------ evidence
    def evidence(self, paypal_order_id: str) -> dict:
        """Everything needed to settle a dispute about this payment, verifiable offline."""
        order = self.ledger.get_order(paypal_order_id)
        if not order:
            raise KeyError(paypal_order_id)
        mandate = self.ledger.get_mandate(order["mandate_id"])
        intent_payload, user_did = verify_jws(mandate["jws"], expected_signer=self.user.did)
        cart_payload, merchant_did = verify_jws(order["cart_jws"], expected_signer=self.merchant.identity.did)
        req_payload, agent_did = verify_jws(order["request_jws"])
        return {
            "paypal_order_id": paypal_order_id,
            "capture_id": order["capture_id"],
            "status": order["status"],
            "amount": order["amount"],
            "currency": order["currency"],
            "payment_mandate_id": order["payment_mandate_id"],
            "decision": json.loads(order["decision"]),
            "intent_mandate": {"signed_by": user_did, "jws": mandate["jws"], "payload": intent_payload},
            "cart_mandate": {"signed_by": merchant_did, "jws": order["cart_jws"], "payload": cart_payload},
            "agent_request": {"signed_by": agent_did, "jws": order["request_jws"], "payload": req_payload},
            "hash_links": {
                "intent_hash": sha256_hex(mandate["jws"]),
                "cart_hash": sha256_hex(order["cart_jws"]),
                "payment_mandate_id_matches": sha256_hex(sha256_hex(mandate["jws"]) + sha256_hex(order["cart_jws"])) == order["payment_mandate_id"],
            },
            "audit_events": self.ledger.events(ref=paypal_order_id) + self.ledger.events(ref=order["payment_mandate_id"]),
            "audit_chain": self.ledger.verify_chain(),
            "generated_at": utcnow().isoformat(),
        }
