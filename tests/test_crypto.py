import pytest

from app.crypto import Identity, SignatureError, b64url, b64url_decode, public_key_from_did, verify_jws


def test_sign_and_verify_roundtrip():
    alice = Identity.generate("alice")
    token = alice.sign({"hello": "world", "n": 1})
    payload, signer = verify_jws(token, expected_signer=alice.did)
    assert payload == {"hello": "world", "n": 1}
    assert signer == alice.did


def test_did_key_roundtrip():
    alice = Identity.generate("alice")
    assert alice.did.startswith("did:key:z6Mk")
    public_key_from_did(alice.did)  # does not raise


def test_tampered_payload_is_rejected():
    alice = Identity.generate("alice")
    h, p, s = alice.sign({"amount": "10.00"}).split(".")
    forged = f"{h}.{b64url(b64url_decode(p).replace(b'10.00', b'99.00'))}.{s}"
    with pytest.raises(SignatureError):
        verify_jws(forged)


def test_wrong_expected_signer_is_rejected():
    alice, bob = Identity.generate("alice"), Identity.generate("bob")
    with pytest.raises(SignatureError):
        verify_jws(alice.sign({"x": 1}), expected_signer=bob.did)


def test_kid_swap_is_rejected():
    """Claiming to be Bob while signing with Alice's key fails verification."""
    alice, bob = Identity.generate("alice"), Identity.generate("bob")
    token = alice.sign({"x": 1})
    h, p, s = token.split(".")
    fake_header = b64url(b64url_decode(h).replace(alice.did.encode(), bob.did.encode()))
    with pytest.raises(SignatureError):
        verify_jws(f"{fake_header}.{p}.{s}")


def test_malformed_token():
    with pytest.raises(SignatureError):
        verify_jws("not-a-jws")
