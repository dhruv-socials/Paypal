"""Ed25519 keys, did:key identifiers and compact JWS (EdDSA) signing.

Every party in the flow has its own key:
  * the user signs the Intent Mandate (what the agent may buy),
  * the merchant signs the Cart Mandate (exact items and prices),
  * the agent signs each purchase request (which agent is asking).
A did:key embeds the public key, so any party can verify a signature offline.
"""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_ED25519_MULTICODEC = b"\xed\x01"


class SignatureError(Exception):
    """Raised when a JWS is malformed, tampered with, or signed by the wrong key."""


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _b58encode(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = _B58[r] + out
    pad = len(data) - len(data.lstrip(b"\0"))
    return "1" * pad + out


def _b58decode(text: str) -> bytes:
    n = 0
    for ch in text:
        idx = _B58.find(ch)
        if idx < 0:
            raise SignatureError(f"invalid base58 character {ch!r}")
        n = n * 58 + idx
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = len(text) - len(text.lstrip("1"))
    return b"\0" * pad + body


def canonical_json(obj: Any) -> str:
    """Deterministic JSON used for hashing and signing."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def sha256_hex(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()


def did_from_public_key(pub: Ed25519PublicKey) -> str:
    raw = pub.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return "did:key:z" + _b58encode(_ED25519_MULTICODEC + raw)


def public_key_from_did(did: str) -> Ed25519PublicKey:
    if not did.startswith("did:key:z"):
        raise SignatureError(f"unsupported DID: {did}")
    raw = _b58decode(did[len("did:key:z"):])
    if not raw.startswith(_ED25519_MULTICODEC) or len(raw) != 34:
        raise SignatureError("DID is not an Ed25519 did:key")
    return Ed25519PublicKey.from_public_bytes(raw[2:])


class Identity:
    """A named Ed25519 key pair with its did:key."""

    def __init__(self, name: str, private_key: Ed25519PrivateKey):
        self.name = name
        self._key = private_key
        self.did = did_from_public_key(private_key.public_key())

    @classmethod
    def generate(cls, name: str) -> "Identity":
        return cls(name, Ed25519PrivateKey.generate())

    @classmethod
    def load_or_create(cls, name: str, key_dir: Path) -> "Identity":
        key_dir.mkdir(parents=True, exist_ok=True)
        path = key_dir / f"{name}.pem"
        if path.exists():
            key = serialization.load_pem_private_key(path.read_bytes(), password=None)
            assert isinstance(key, Ed25519PrivateKey)
            return cls(name, key)
        key = Ed25519PrivateKey.generate()
        path.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        try:
            path.chmod(0o600)
        except OSError:  # pragma: no cover - e.g. Windows
            pass
        return cls(name, key)

    def sign(self, payload: dict[str, Any]) -> str:
        header = {"alg": "EdDSA", "typ": "JWT", "kid": self.did}
        signing_input = f"{b64url(canonical_json(header).encode())}.{b64url(canonical_json(payload).encode())}"
        signature = self._key.sign(signing_input.encode())
        return f"{signing_input}.{b64url(signature)}"


def verify_jws(token: str, expected_signer: str | None = None) -> tuple[dict[str, Any], str]:
    """Verify a compact JWS. Returns (payload, signer_did).

    If expected_signer is given, the token must be signed by that DID.
    """
    try:
        header_b64, payload_b64, sig_b64 = token.split(".")
        header = json.loads(b64url_decode(header_b64))
        payload = json.loads(b64url_decode(payload_b64))
        signature = b64url_decode(sig_b64)
    except Exception as exc:  # noqa: BLE001
        raise SignatureError(f"malformed JWS: {exc}") from exc
    if header.get("alg") != "EdDSA":
        raise SignatureError(f"unsupported alg {header.get('alg')!r}")
    signer = header.get("kid", "")
    if expected_signer is not None and signer != expected_signer:
        raise SignatureError("signed by an unexpected key")
    try:
        public_key_from_did(signer).verify(signature, f"{header_b64}.{payload_b64}".encode())
    except InvalidSignature as exc:
        raise SignatureError("signature does not verify") from exc
    return payload, signer
