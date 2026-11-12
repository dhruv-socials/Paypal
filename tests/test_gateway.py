from decimal import Decimal

from app import attacks
from app.crypto import Identity
from tests.conftest import make_gateway


def test_in_limit_purchase_needs_paypal_approval_then_captures(gw, mandate):
    r = gw.purchase(gw.sign_request(mandate, "gro-rice-5kg", 1))
    assert r["status"] == "awaiting_approval"
    assert r["approve_url"]
    assert gw.budget(mandate)["committed"] == "14.99"

    gw.paypal.approve(r["order_id"])  # buyer approves in (mock) PayPal
    done = gw.complete_approval(r["order_id"])
    assert done["status"] == "captured"
    assert gw.budget(mandate)["captured"] == "14.99"


def test_step_up_above_threshold(gw, mandate):
    r = gw.purchase(gw.sign_request(mandate, "gro-rice-5kg", 3))  # 44.97 > 40
    assert r["status"] == "step_up_required"


def test_injected_gift_card_is_denied(gw, mandate):
    r = gw.purchase(gw.sign_request(mandate, "gc-visa-500", 1))
    assert r["status"] == "denied"
    assert "item.blocked_category" in r["rules"]
    assert gw.ledger.list_orders(mandate) == []


def test_rogue_agent_denied(gw, mandate):
    r = gw.purchase(gw.sign_request(mandate, "gro-rice-5kg", 1, agent=Identity.generate("rogue")))
    assert r["status"] == "denied" and r["rules"] == ["agent.not_delegated"]


def test_revoked_mandate_blocks_spend_and_pending_capture(gw, mandate):
    r = gw.purchase(gw.sign_request(mandate, "gro-dal-2kg", 1))
    gw.revoke_mandate(mandate)
    gw.paypal.approve(r["order_id"])
    assert gw.complete_approval(r["order_id"])["status"] == "denied"
    assert gw.purchase(gw.sign_request(mandate, "gro-dal-2kg", 1))["rules"] == ["mandate.revoked"]


def test_cancel_releases_budget(gw, mandate):
    r = gw.purchase(gw.sign_request(mandate, "gro-rice-5kg", 2))
    assert gw.budget(mandate)["committed"] == "29.98"
    gw.cancel(r["order_id"])
    assert gw.budget(mandate)["committed"] == "0.00"


def test_saved_wallet_allows_autonomous_capture_but_not_for_step_up():
    gw = make_gateway(vault_enabled=True)
    from app.models import Constraints
    m = gw.create_mandate("t", Constraints(per_txn_max=Decimal("60"), total_max=Decimal("200"), step_up_above=Decimal("40")))["mandate_id"]

    first = gw.purchase(gw.sign_request(m, "gro-rice-5kg", 1))
    assert first["status"] == "awaiting_approval"  # first purchase links the wallet
    gw.paypal.approve(first["order_id"])
    gw.complete_approval(first["order_id"])
    assert gw.budget(m)["wallet_saved"]

    second = gw.purchase(gw.sign_request(m, "gro-dal-2kg", 1))
    assert second["status"] == "captured" and second["autonomous"]

    big = gw.purchase(gw.sign_request(m, "gro-rice-5kg", 3))  # 44.97, above step-up
    assert big["status"] == "step_up_required"


def test_evidence_bundle_links_all_signatures(gw, mandate):
    r = gw.purchase(gw.sign_request(mandate, "gro-coffee-500g", 1))
    gw.paypal.approve(r["order_id"])
    gw.complete_approval(r["order_id"])
    ev = gw.evidence(r["order_id"])
    assert ev["intent_mandate"]["signed_by"] == gw.user.did
    assert ev["cart_mandate"]["signed_by"] == gw.merchant.identity.did
    assert ev["agent_request"]["signed_by"] == gw.agent.did
    assert ev["hash_links"]["payment_mandate_id_matches"]
    assert ev["audit_chain"]["valid"]


def test_audit_chain_detects_tampering(gw, mandate):
    gw.purchase(gw.sign_request(mandate, "gro-rice-5kg", 1))
    assert gw.ledger.verify_chain()["valid"]
    gw.ledger._conn.execute("UPDATE events SET payload = '{\"edited\":true}' WHERE seq = 2")
    result = gw.ledger.verify_chain()
    assert not result["valid"] and result["broken_at_seq"] == 2


def test_full_attack_suite_moves_no_money():
    gw = make_gateway()
    report = attacks.run_all(gw)
    failed = [a for a in report["attacks"] if not a["blocked"]]
    assert failed == [], failed
    assert report["money_outside_mandate"] == "0.00"
    assert report["audit_chain"]["valid"]
