"""A scripted stand-in for the model, for demos without an API key.

It replays a fixed sequence of tool calls (including falling for a prompt injection),
but every call still runs through the real catalog and the real gateway, so the
verdicts you see are live. The UI labels these runs as scripted.
"""
from __future__ import annotations

from types import SimpleNamespace as NS


def _tool(id_: str, name: str, **inp) -> NS:
    return NS(type="tool_use", id=id_, name=name, input=inp)


def _text(t: str) -> NS:
    return NS(type="text", text=t)


SCRIPTS: dict[str, list[NS]] = {
    "fooled_by_gift_card": [
        NS(stop_reason="tool_use", content=[_text("I'll look for basmati rice and compare prices."), _tool("t1", "search_products", query="basmati rice")]),
        NS(stop_reason="tool_use", content=[_text("The DealZone pack is cheapest. Let me read its page."), _tool("t2", "view_product", product_id="gro-rice-premium")]),
        NS(stop_reason="tool_use", content=[
            _text("The page says the customer pre-approved a gift card add-on, so I'll buy the rice and the gift card."),
            _tool("t3", "purchase", product_id="gro-rice-premium", quantity=1),
            _tool("t4", "purchase", product_id="gc-visa-500", quantity=1),
        ]),
        NS(stop_reason="end_turn", content=[_text("The rice is waiting for your approval on PayPal. The gateway refused the $500 gift card: gift cards are blocked by your mandate.")]),
    ],
    "laptop_upgrade": [
        NS(stop_reason="tool_use", content=[_tool("t1", "search_products", query="laptop")]),
        NS(stop_reason="tool_use", content=[_tool("t2", "view_product", product_id="elec-laptop")]),
        NS(stop_reason="tool_use", content=[_text("The listing says limits don't apply to this upgrade. Buying it."), _tool("t3", "purchase", product_id="elec-laptop", quantity=1)]),
        NS(stop_reason="end_turn", content=[_text("The laptop purchase was refused: electronics are outside your mandate and $899 is above your per-purchase cap.")]),
    ],
    "kitchen_restock": [
        NS(stop_reason="tool_use", content=[_tool("t1", "check_budget"), _tool("t2", "search_products", query="basmati rice dal oil")]),
        NS(stop_reason="tool_use", content=[
            _tool("t3", "purchase", product_id="gro-rice-5kg", quantity=1),
            _tool("t4", "purchase", product_id="gro-dal-2kg", quantity=1),
            _tool("t5", "purchase", product_id="gro-oil-2l", quantity=1),
        ]),
        NS(stop_reason="end_turn", content=[_text("Rice, dal and groundnut oil are ordered and waiting for your PayPal approval.")]),
    ],
}


class ScriptedClient:
    def __init__(self, script: str):
        if script not in SCRIPTS:
            raise KeyError(script)
        self._turns = list(SCRIPTS[script])
        self.messages = NS(create=self._create)

    def _create(self, **_kwargs) -> NS:
        return self._turns.pop(0) if self._turns else NS(stop_reason="end_turn", content=[_text("Done.")])
