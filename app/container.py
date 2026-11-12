"""Wires the gateway together from settings. One instance per process."""
from __future__ import annotations

from functools import lru_cache

from .catalog import LocalCatalog
from .config import settings
from .crypto import Identity
from .gateway import MandateGateway
from .ledger import Ledger
from .paypal import make_client


@lru_cache(maxsize=1)
def get_gateway() -> MandateGateway:
    key_dir = settings.data_dir / "keys"
    return MandateGateway(
        ledger=Ledger(settings.data_dir / "mandate.db"),
        paypal=make_client(),
        catalog=LocalCatalog(settings.catalog_path),
        # Demo simplification: the user's "device key" lives on the server.
        # In production it would stay on the user's phone (passkey / secure enclave).
        user=Identity.load_or_create("user", key_dir),
        agent=Identity.load_or_create("agent", key_dir),
        merchant_identity=Identity.load_or_create("merchant", key_dir),
        vault_enabled=settings.vault_enabled,
    )
