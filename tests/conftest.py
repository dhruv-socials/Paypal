from decimal import Decimal
from pathlib import Path

import pytest

from app.catalog import LocalCatalog
from app.crypto import Identity
from app.gateway import MandateGateway
from app.ledger import Ledger
from app.models import Constraints
from app.paypal import MockPayPal

CATALOG = Path(__file__).resolve().parent.parent / "data" / "catalog.json"


def make_gateway(vault_enabled: bool = False) -> MandateGateway:
    return MandateGateway(
        ledger=Ledger(":memory:"),
        paypal=MockPayPal(),
        catalog=LocalCatalog(CATALOG),
        user=Identity.generate("user"),
        agent=Identity.generate("agent"),
        merchant_identity=Identity.generate("merchant"),
        vault_enabled=vault_enabled,
    )


@pytest.fixture
def gw() -> MandateGateway:
    return make_gateway()


@pytest.fixture
def constraints() -> Constraints:
    return Constraints(
        per_txn_max=Decimal("60"),
        total_max=Decimal("120"),
        step_up_above=Decimal("40"),
        allowed_categories=["groceries", "household"],
    )


@pytest.fixture
def mandate(gw, constraints) -> str:
    return gw.create_mandate("Kitchen restock", constraints)["mandate_id"]
