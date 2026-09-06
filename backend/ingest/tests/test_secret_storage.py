"""HMAC secrets at rest.

The old cipher was an unauthenticated HMAC keystream keyed from VE_JWT_SECRET, so
anyone who could write the column could flip bits in a stored secret, and rotating
the token secret silently broke every HMAC webhook.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import uuid

import pytest

from app.ingest.security import (
    decrypt_secret,
    encrypt_secret,
    hash_secret,
    store_secret,
    verify_secret,
)

TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()


def test_an_hmac_secret_round_trips():
    stored = encrypt_secret(TENANT_A, "shhh")
    assert stored != "shhh"
    assert stored.startswith("enc:v1:")
    assert decrypt_secret(TENANT_A, stored) == "shhh"


def test_one_tenants_key_does_not_open_anothers():
    """Per-tenant keys. The old cipher had one key for the whole platform."""
    stored = encrypt_secret(TENANT_A, "shhh")
    assert decrypt_secret(TENANT_B, stored) is None


def test_a_tampered_ciphertext_is_refused_not_silently_altered():
    """The point of an authenticated cipher. Under the keystream, flipping a bit of
    ciphertext flipped the same bit of the recovered secret."""
    stored = encrypt_secret(TENANT_A, "shhh")
    tampered = stored[:-4] + ("AAAA" if not stored.endswith("AAAA") else "BBBB")
    assert decrypt_secret(TENANT_A, tampered) is None


def _legacy_encrypt(plain: str) -> str:
    """The old cipher, reproduced so the compatibility path is tested against a
    real old value rather than an assumption about its shape."""
    from kernel.config import get_settings

    key = hashlib.sha256(get_settings().jwt_secret.encode()).digest()
    nonce = os.urandom(16)
    out = bytearray()
    counter = 0
    while len(out) < len(plain.encode()):
        out.extend(hmac.new(key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest())
        counter += 1
    ct = bytes(a ^ b for a, b in zip(plain.encode(), bytes(out)))
    return f"enc:{nonce.hex()}:{ct.hex()}"


def test_a_legacy_row_still_decrypts():
    """Existing deployments hold these. Breaking them takes every HMAC webhook
    offline at once, and the symptom would be 'bad signature' from senders that
    changed nothing."""
    legacy = _legacy_encrypt("old-secret")
    assert legacy.startswith("enc:") and not legacy.startswith("enc:v1:")
    assert decrypt_secret(TENANT_A, legacy) == "old-secret"


def test_nothing_stored_is_none():
    assert decrypt_secret(TENANT_A, None) is None
    assert decrypt_secret(TENANT_A, "") is None


def test_a_plain_value_is_not_treated_as_ciphertext():
    """A hashed secret must never be handed back as if it were a plaintext one."""
    assert decrypt_secret(TENANT_A, hash_secret("something")) is None


@pytest.mark.parametrize("auth_type", ["api_key", "basic", "bearer"])
def test_non_hmac_secrets_are_hashed_not_encrypted(auth_type):
    """Hashing where a one-way value suffices is stronger than encrypting. Do not
    'unify' this."""
    stored = store_secret(TENANT_A, auth_type, "s3cret")
    assert not stored.startswith("enc:")
    assert verify_secret("s3cret", stored)
    assert not verify_secret("wrong", stored)


def test_hmac_secrets_are_encrypted_because_verification_needs_them_back():
    stored = store_secret(TENANT_A, "hmac", "s3cret")
    assert stored.startswith("enc:v1:")
    assert decrypt_secret(TENANT_A, stored) == "s3cret"
