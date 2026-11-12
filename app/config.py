"""Runtime configuration, read from environment variables (see .env.example)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

try:  # optional: load a local .env if python-dotenv is installed
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover
    pass


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    paypal_mode: str = os.getenv("PAYPAL_MODE", "mock")  # "mock" or "sandbox"
    paypal_client_id: str = os.getenv("PAYPAL_CLIENT_ID", "")
    paypal_client_secret: str = os.getenv("PAYPAL_CLIENT_SECRET", "")
    paypal_base_url: str = os.getenv("PAYPAL_BASE_URL", "https://api-m.sandbox.paypal.com")
    # Saving the buyer's PayPal wallet requires "Save payment methods" to be enabled
    # for the sandbox app. Off by default: every order then goes through PayPal approval.
    vault_enabled: bool = _bool("VAULT_ENABLED", False)
    public_base_url: str = os.getenv("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")
    currency: str = os.getenv("CURRENCY", "USD")
    brand_name: str = os.getenv("BRAND_NAME", "Mandate Demo Store")

    anthropic_api_key: str = os.getenv("ANTHROPIC_API_KEY", "")
    anthropic_model: str = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5-5")
    agent_max_turns: int = int(os.getenv("AGENT_MAX_TURNS", "12"))
    hardened_prompt: bool = _bool("HARDENED_PROMPT", True)

    data_dir: Path = Path(os.getenv("DATA_DIR", "./var"))
    catalog_path: Path = Path(os.getenv("CATALOG_PATH", str(Path(__file__).resolve().parent.parent / "data" / "catalog.json")))


settings = Settings()
