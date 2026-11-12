"""Deterministic policy engine. No LLM is involved in any decision here.

evaluate() compares a merchant-signed cart against the user-signed intent and the
budget already committed, and returns allow / deny / step_up with the rules that fired.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Literal

from .models import CartMandate, IntentMandate

Outcome = Literal["allow", "deny", "step_up"]


@dataclass
class Decision:
    outcome: Outcome
    reasons: list[str] = field(default_factory=list)
    rules: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"outcome": self.outcome, "reasons": self.reasons, "rules": self.rules}


def evaluate(
    intent: IntentMandate,
    cart: CartMandate,
    committed: Decimal,
    now: datetime,
) -> Decision:
    """committed = amount already captured or reserved under this mandate."""
    c = intent.constraints
    denies: list[tuple[str, str]] = []

    def deny(rule: str, reason: str) -> None:
        denies.append((rule, reason))

    if cart.intent_id != intent.id:
        deny("cart.intent_mismatch", "Cart was built for a different mandate.")
    if cart.currency != c.currency:
        deny("cart.currency", f"Cart currency {cart.currency} does not match mandate currency {c.currency}.")
    if now < intent.valid_from:
        deny("mandate.not_yet_valid", "Mandate is not valid yet.")
    if now > intent.valid_until:
        deny("mandate.expired", "Mandate has expired.")
    if now > cart.expires_at:
        deny("cart.expired", "Merchant cart offer has expired.")
    if not cart.items:
        deny("cart.empty", "Cart is empty.")

    computed_total = sum((item.line_total for item in cart.items), Decimal("0.00"))
    if computed_total != cart.total:
        deny("cart.total_mismatch", "Cart total does not equal the sum of its items.")
    if cart.total <= 0:
        deny("cart.non_positive", "Cart total must be positive.")

    for item in cart.items:
        if item.category in c.blocked_categories:
            deny("item.blocked_category", f"'{item.name}' is in blocked category '{item.category}'.")
        if c.allowed_categories and item.category not in c.allowed_categories:
            deny("item.category_not_allowed", f"'{item.name}' category '{item.category}' is not in the mandate.")
        if c.allowed_merchants and item.merchant_id not in c.allowed_merchants:
            deny("item.merchant_not_allowed", f"Merchant '{item.merchant_id}' is not allowed by the mandate.")
        if item.quantity > c.max_quantity_per_item:
            deny("item.quantity", f"Quantity {item.quantity} of '{item.name}' exceeds the limit of {c.max_quantity_per_item}.")

    if cart.total > c.per_txn_max:
        deny("budget.per_txn", f"Purchase of {cart.total} exceeds the per-purchase cap of {c.per_txn_max}.")
    remaining = c.total_max - committed
    if cart.total > remaining:
        deny("budget.total", f"Purchase of {cart.total} exceeds the remaining budget of {max(remaining, Decimal('0.00'))}.")

    if denies:
        return Decision("deny", [r for _, r in denies], [rule for rule, _ in denies])
    if cart.total > c.step_up_above:
        return Decision(
            "step_up",
            [f"Purchase of {cart.total} is above the step-up threshold of {c.step_up_above}; the user must approve on PayPal."],
            ["budget.step_up"],
        )
    return Decision("allow", ["Within every mandate constraint."], ["all_passed"])
