"""Symmetric encryption for secrets stored in the DB (SMTP/FCM/S3 credentials).

Integration credentials are configured from the admin UI (not .env), so they live
in the database — and at rest they MUST be encrypted. We derive a Fernet key from
the app secret (``VE_SECRETS_KEY``); rotating that env var re-keys everything.

    token = encrypt_secret("smtp-password")   # store `token` in the DB
    raw   = decrypt_secret(token)             # read it back when sending mail

decrypt is lenient: if it receives a value that isn't a valid ciphertext (e.g. a
legacy plaintext row written before encryption existed), it returns it unchanged
so the app keeps working during migration.
"""

from __future__ import annotations

import base64
import hashlib
import hmac

from cryptography.fernet import Fernet, InvalidToken

from .config import get_settings


def _fernet() -> Fernet:
    # Fernet needs a 32-byte urlsafe-base64 key. Derive one deterministically from
    # the configured secret so the same secret always yields the same cipher.
    digest = hashlib.sha256(get_settings().secrets_key.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def _fernet_for(tenant_id: str) -> Fernet:
    """A PER-TENANT Fernet key, derived from the master secret + tenant id via
    HMAC-SHA256 (a KDF). Each tenant's secrets are encrypted under a distinct key, so
    one tenant's key never decrypts another's data — the STQC per-tenant-key /
    data-residency requirement. Rotating ``VE_SECRETS_KEY`` re-keys every tenant; a
    future per-tenant rotation can swap the KDF input for that tenant alone.
    """
    key = hmac.new(
        get_settings().secrets_key.encode(), f"tenant:{tenant_id}".encode(), hashlib.sha256
    ).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_secret_for(tenant_id: str, plaintext: str) -> str:
    """Encrypt a tenant's secret under its OWN key (see :func:`_fernet_for`)."""
    return _fernet_for(tenant_id).encrypt(plaintext.encode()).decode()


def decrypt_secret_for(tenant_id: str, ciphertext: str) -> str:
    """Decrypt a tenant's secret with its own key; lenient on legacy plaintext."""
    try:
        return _fernet_for(tenant_id).decrypt(ciphertext.encode()).decode()
    except InvalidToken:
        return ciphertext


def encrypt_secret(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt_secret(ciphertext: str) -> str:
    try:
        return _fernet().decrypt(ciphertext.encode()).decode()
    except InvalidToken:
        # Backward-compat: value was never encrypted (legacy plaintext) — pass through.
        return ciphertext


def encrypt_bytes(plaintext: bytes) -> bytes:
    """Encrypt an arbitrary blob (e.g. a biometric face crop) for storage at rest."""
    return _fernet().encrypt(plaintext)


def decrypt_bytes(ciphertext: bytes) -> bytes:
    """Decrypt a blob. Lenient: if the value isn't a valid ciphertext (a legacy
    plaintext file written before encryption was enabled), return it unchanged so
    existing objects keep serving during migration."""
    try:
        return _fernet().decrypt(ciphertext)
    except InvalidToken:
        return ciphertext
