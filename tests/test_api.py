"""HTTP-level checks for the endpoints the web app depends on."""
import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PAYPAL_MODE", "mock")
    import app.config, app.container, app.main
    importlib.reload(app.config)
    importlib.reload(app.container)
    importlib.reload(app.main)
    return TestClient(app.main.app)


def _mandate(client) -> str:
    r = client.post("/api/mandates", json={
        "description": "Kitchen basics", "total_max": "120", "per_txn_max": "60",
        "step_up_above": "40", "allowed_categories": ["groceries", "household"],
    })
    assert r.status_code == 200
    return r.json()["mandate_id"]


def test_blocked_attempt_shows_in_state(client):
    m = _mandate(client)
    r = client.post("/api/purchase", json={"mandate_id": m, "product_id": "gc-visa-500", "quantity": 1})
    assert r.json()["status"] == "denied"
    denials = client.get("/api/state").json()["denials"]
    assert len(denials) == 1
    d = denials[0]
    assert d["product"] == "Visa Prepaid Gift Card, $500"
    assert d["amount"] == "500.00"
    assert "item.blocked_category" in d["rules"]


def test_approve_flow_over_http(client):
    m = _mandate(client)
    r = client.post("/api/purchase", json={"mandate_id": m, "product_id": "gro-rice-5kg", "quantity": 1}).json()
    assert r["status"] == "awaiting_approval"
    page = client.get(f"/mock-paypal/approve/{r['order_id']}")
    assert page.status_code == 200 and "Checkout simulator" in page.text
    done = client.post(f"/mock-paypal/approve/{r['order_id']}", data={"decision": "approve"}, follow_redirects=True)
    assert done.status_code == 200
    orders = client.get("/api/state").json()["orders"]
    assert orders[0]["status"] == "captured"
    ev = client.get(f"/api/evidence/{r['order_id']}").json()
    assert ev["hash_links"]["payment_mandate_id_matches"]


def test_mandate_validation(client):
    r = client.post("/api/mandates", json={"description": "x" * 5, "total_max": "50", "per_txn_max": "60", "step_up_above": "10"})
    assert r.status_code == 422
