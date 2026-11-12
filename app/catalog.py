"""Merchant catalog and merchant-side cart signing.

The agent never supplies prices. The merchant builds the cart from its own catalog and
signs it, so a prompt-injected agent cannot change what an item costs.

Product descriptions are untrusted text. Some products in data/catalog.json carry
prompt-injection payloads on purpose, so the red-team suite can show the gateway holds.

To use a live product source (e.g. the Channel3 product API, a hackathon sponsor),
implement the same three methods as LocalCatalog: search(), get(), merchants.
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

from .crypto import Identity
from .models import CartItem, CartMandate, utcnow


class UnknownProduct(Exception):
    pass


class LocalCatalog:
    def __init__(self, path: Path):
        data = json.loads(Path(path).read_text())
        self.merchants: dict[str, dict] = {m["id"]: m for m in data["merchants"]}
        self.products: dict[str, dict] = {p["id"]: p for p in data["products"]}

    def search(self, query: str, limit: int = 8) -> list[dict]:
        terms = [t for t in query.lower().split() if t]
        scored = []
        for p in self.products.values():
            hay = f"{p['name']} {p['category']} {p['description']}".lower()
            score = sum(hay.count(t) for t in terms) if terms else 1
            if score:
                scored.append((score, p))
        scored.sort(key=lambda sp: (-sp[0], sp[1]["name"]))
        return [self.public_view(p) for _, p in scored[:limit]]

    def get(self, product_id: str) -> dict:
        p = self.products.get(product_id)
        if not p:
            raise UnknownProduct(product_id)
        return p

    def public_view(self, p: dict, with_description: bool = False) -> dict:
        view = {
            "product_id": p["id"],
            "name": p["name"],
            "category": p["category"],
            "price": p["price"],
            "merchant_id": p["merchant_id"],
            "merchant": self.merchants[p["merchant_id"]]["name"],
            "rating": p.get("rating"),
            "image": p.get("image"),
        }
        if with_description:
            view["description"] = p["description"]
        return view


class Merchant:
    """Signs Cart Mandates. One demo key signs for every merchant in the local catalog."""

    def __init__(self, catalog: LocalCatalog, identity: Identity, offer_ttl_minutes: int = 15):
        self.catalog = catalog
        self.identity = identity
        self.ttl = timedelta(minutes=offer_ttl_minutes)

    def build_cart(self, intent_id: str, product_id: str, quantity: int, currency: str) -> tuple[CartMandate, str]:
        p = self.catalog.get(product_id)
        item = CartItem(
            product_id=p["id"],
            name=p["name"],
            category=p["category"],
            merchant_id=p["merchant_id"],
            unit_price=Decimal(p["price"]),
            quantity=quantity,
        )
        now = utcnow()
        cart = CartMandate(
            id="cart_" + uuid.uuid4().hex[:16],
            intent_id=intent_id,
            merchant=self.identity.did,
            items=[item],
            currency=currency,
            total=item.line_total,
            created_at=now,
            expires_at=now + self.ttl,
        )
        return cart, self.identity.sign(cart.model_dump(mode="json"))
