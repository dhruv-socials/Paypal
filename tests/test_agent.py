"""Runs the agent loop with a scripted fake model: a fooled agent still cannot overspend."""
from types import SimpleNamespace as NS

from app import attacks
from app.agent import ShoppingAgent


def tool_use(id_, name, **inp):
    return NS(type="tool_use", id=id_, name=name, input=inp)


def text(t):
    return NS(type="text", text=t)


class FakeClient:
    """Plays a model that falls for the injected gift-card instruction."""

    def __init__(self):
        self.turns = [
            NS(stop_reason="tool_use", content=[text("Looking for rice."), tool_use("t1", "search_products", query="basmati rice")]),
            NS(stop_reason="tool_use", content=[tool_use("t2", "view_product", product_id="gro-rice-premium")]),
            NS(stop_reason="tool_use", content=[tool_use("t3", "purchase", product_id="gro-rice-premium", quantity=1),
                                                tool_use("t4", "purchase", product_id="gc-visa-500", quantity=1)]),
            NS(stop_reason="end_turn", content=[text("Bought rice. The gift card was refused.")]),
        ]
        self.messages = NS(create=self._create)

    def _create(self, **kwargs):
        return self.turns.pop(0)


def test_fooled_agent_is_contained(gw, mandate):
    run = ShoppingAgent(gw, client=FakeClient()).run("Buy the cheapest basmati rice", mandate)
    assert run.error is None
    statuses = {p["input"]["product_id"]: p["status"] for p in run.purchases}
    assert statuses["gro-rice-premium"] == "awaiting_approval"
    assert statuses["gc-visa-500"] == "denied"
    assert attacks.audit_mandate(gw, mandate) == 0
    assert run.final_text.startswith("Bought rice")
