"""Wires the gateway together from settings. One instance per process."""

from __future__ import annotations

import os
import threading
from pathlib import Path

from .catalog import LocalCatalog
from .config import settings
from .crypto import Identity
from .gateway import MandateGateway
from .ledger import Ledger
from .paypal import make_client

_gateway: MandateGateway | None = None
_lock = threading.Lock()


def get_gateway() -> MandateGateway:
    """Build the gateway once. The lock stops parallel first requests from racing."""
    global _gateway
    if _gateway is None:
        with _lock:
            if _gateway is None:
                _gateway = _build()
    return _gateway


def _build() -> MandateGateway:
    # Vercel has a read-only filesystem except for /tmp
    data_dir = Path("/tmp/app-data") if os.getenv("VERCEL") else settings.data_dir

    data_dir.mkdir(parents=True, exist_ok=True)

    key_dir = data_dir / "keys"

    return MandateGateway(
        ledger=Ledger(data_dir / "mandate.db"),
        paypal=make_client(),
        catalog=LocalCatalog(settings.catalog_path),
        # Demo simplification: the user's "device key" lives on the server.
        # In production it would stay on the user's phone (passkey / secure enclave).
        user=Identity.load_or_create("user", key_dir),
        agent=Identity.load_or_create("agent", key_dir),
        merchant_identity=Identity.load_or_create("merchant", key_dir),
        vault_enabled=settings.vault_enabled,
    )
