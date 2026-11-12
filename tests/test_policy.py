"""Policy unit tests plus a property test: no sequence of carts can breach a cap."""
from datetime import timedelta
from decimal import Decimal

from hypothesis import given, settings, strategies as st

from app.models import CartItem, CartMandate, Constraints, IntentMandate, utcnow
from app.policy import evaluate

NOW = utcnow()


def intent(**kw) -> IntentMandate:
    cons = Constraints(**{"per_txn_max": Decimal("60"), "total_max": Decimal("120"), "step_up_above": Decimal("40"),
                          "allowed_categories": ["groceries"], **kw})
    return IntentMandate(id="im_1", issuer="did:key:user", agent="did:key:agent", description="t", constraints=cons,
                         valid_from=NOW - timedelta(days=1), valid_until=NOW + timedelta(days=1))


def cart(price: str, qty: int = 1, category: str = "groceries", intent_id: str = "im_1") -> CartMandate:
    item = CartItem(product_id="p", name="Thing", category=category, merchant_id="m", unit_price=Decimal(price), quantity=qty)
    return CartMandate(id="c", intent_id=intent_id, merchant="did:key:m", items=[item], currency="USD", total=item.line_total,
                       created_at=NOW, expires_at=NOW + timedelta(minutes=10))


def test_allow_within_limits():
    assert evaluate(intent(), cart("10.00"), Decimal("0"), NOW).outcome == "allow"


def test_step_up_above_threshold():
    d = evaluate(intent(), cart("45.00"), Decimal("0"), NOW)
    assert d.outcome == "step_up"


def test_blocked_category_denied_even_if_allowed_list_empty():
    d = evaluate(intent(allowed_categories=[]), cart("5.00", category="gift_cards"), Decimal("0"), NOW)
    assert d.outcome == "deny" and "item.blocked_category" in d.rules


def test_category_not_allowed():
    d = evaluate(intent(), cart("5.00", category="electronics"), Decimal("0"), NOW)
    assert "item.category_not_allowed" in d.rules


def test_per_txn_cap():
    assert "budget.per_txn" in evaluate(intent(), cart("61.00"), Decimal("0"), NOW).rules


def test_total_budget():
    assert "budget.total" in evaluate(intent(), cart("30.00"), Decimal("100"), NOW).rules


def test_quantity_limit():
    assert "item.quantity" in evaluate(intent(), cart("1.00", qty=20), Decimal("0"), NOW).rules


def test_expired_mandate():
    assert "mandate.expired" in evaluate(intent(), cart("1.00"), Decimal("0"), NOW + timedelta(days=2)).rules


def test_cart_for_other_mandate():
    assert "cart.intent_mismatch" in evaluate(intent(), cart("1.00", intent_id="im_other"), Decimal("0"), NOW).rules


def test_total_mismatch_detected():
    c = cart("10.00")
    c.total = Decimal("1.00")
    assert "cart.total_mismatch" in evaluate(intent(), c, Decimal("0"), NOW).rules


@settings(max_examples=300, deadline=None)
@given(st.lists(st.tuples(st.decimals(min_value=Decimal("0.01"), max_value=Decimal("500"), places=2),
                          st.integers(min_value=1, max_value=8)), min_size=1, max_size=40))
def test_property_no_sequence_breaches_caps(purchases):
    """Whatever the agent tries, approved spend never exceeds per-purchase or total caps."""
    i = intent()
    committed = Decimal("0.00")
    for price, qty in purchases:
        c = cart(str(price), qty)
        d = evaluate(i, c, committed, NOW)
        if d.outcome != "deny":
            assert c.total <= i.constraints.per_txn_max
            assert qty <= i.constraints.max_quantity_per_item
            committed += c.total
        assert committed <= i.constraints.total_max
