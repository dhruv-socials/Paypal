"""Mandate data model, following the AP2 idea of three linked mandates.

IntentMandate  - signed by the user: what the agent may buy, how much, until when.
CartMandate    - signed by the merchant: the exact items and prices offered.
PaymentMandate - derived by the gateway: hash-links intent and cart; its hash is the
                 PayPal idempotency key, so a replayed cart can never be charged twice.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator

DEFAULT_BLOCKED_CATEGORIES = ["gift_cards", "crypto", "money_transfer", "prepaid_cards"]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Constraints(BaseModel):
    currency: str = "USD"
    per_txn_max: Decimal = Field(gt=0, description="Largest single purchase the agent may make")
    total_max: Decimal = Field(gt=0, description="Total budget across all purchases")
    step_up_above: Decimal = Field(ge=0, description="Purchases above this need the human to approve on PayPal")
    allowed_categories: list[str] = Field(default_factory=list, description="Empty means any category not blocked")
    blocked_categories: list[str] = Field(default_factory=lambda: list(DEFAULT_BLOCKED_CATEGORIES))
    allowed_merchants: list[str] = Field(default_factory=list, description="Empty means any merchant")
    max_quantity_per_item: int = Field(default=5, ge=1)

    @field_validator("per_txn_max", "total_max", "step_up_above")
    @classmethod
    def _two_places(cls, v: Decimal) -> Decimal:
        return v.quantize(Decimal("0.01"))


class IntentMandate(BaseModel):
    type: Literal["IntentMandate"] = "IntentMandate"
    id: str
    issuer: str  # user DID
    agent: str  # agent DID this mandate is delegated to
    description: str
    constraints: Constraints
    valid_from: datetime
    valid_until: datetime


class CartItem(BaseModel):
    product_id: str
    name: str
    category: str
    merchant_id: str
    unit_price: Decimal
    quantity: int = Field(ge=1)

    @property
    def line_total(self) -> Decimal:
        return (self.unit_price * self.quantity).quantize(Decimal("0.01"))


class CartMandate(BaseModel):
    type: Literal["CartMandate"] = "CartMandate"
    id: str
    intent_id: str
    merchant: str  # merchant DID
    items: list[CartItem]
    currency: str
    total: Decimal
    created_at: datetime
    expires_at: datetime


class PaymentMandate(BaseModel):
    type: Literal["PaymentMandate"] = "PaymentMandate"
    id: str  # sha256(intent_hash + cart_hash): also the PayPal-Request-Id
    intent_id: str
    intent_hash: str
    cart_id: str
    cart_hash: str
    agent: str
    amount: Decimal
    currency: str
    created_at: datetime


class PurchaseRequest(BaseModel):
    """What the agent signs when it asks to buy something."""

    mandate_id: str
    product_id: str
    quantity: int = Field(ge=1)
    nonce: str
    issued_at: datetime
    # Optional merchant-signed cart the agent received earlier. If absent, the gateway
    # asks the merchant for a fresh signed cart.
    cart_jws: str | None = None
