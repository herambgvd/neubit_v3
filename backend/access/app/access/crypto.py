"""Reversible secret encryption for controller credentials.

An access controller's password / API key MUST be recoverable in plaintext at
call time (to auth the OData REST + SignalR connections), so — unlike ingest's
one-way-hashed webhook secrets — instance secrets are stored REVERSIBLY encrypted.

The exact stream-cipher construction is ported verbatim from ingest's
``security.py`` (``encrypt_secret`` / ``decrypt_secret``): an HMAC-SHA256
counter-mode keystream keyed off the kernel ``jwt_secret``. Stdlib only, no
``cryptography`` dependency, no plaintext at rest. Stored form: ``enc:<nonce>:<ct>``.

(v2 used a separate ``ACCESS_CONTROL_DDS_ENCRYPTION_KEY`` + a nonce/ciphertext/
key_version struct; v3 reuses the platform's existing jwt-secret-derived cipher so
no new env var is introduced — same approach the ingest service already uses for
its HMAC secrets.)
"""

from __future__ import annotations

import hashlib
import hmac
import os

_ENC_PREFIX = "enc:"


def _cipher_key() -> bytes:
    """Derive a 32-byte key from the kernel JWT secret (lazy — avoids import cycles)."""
    from kernel.config import get_settings

    return hashlib.sha256(get_settings().jwt_secret.encode("utf-8")).digest()


def _keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    """HMAC-SHA256 counter-mode keystream (stdlib only)."""
    out = bytearray()
    counter = 0
    while len(out) < length:
        block = hmac.new(key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest()
        out.extend(block)
        counter += 1
    return bytes(out[:length])


def encrypt_secret(plain: str) -> str:
    """Reversibly encrypt → ``"enc:<nonce_hex>:<ct_hex>"``."""
    key = _cipher_key()
    nonce = os.urandom(16)
    data = plain.encode("utf-8")
    ct = bytes(a ^ b for a, b in zip(data, _keystream(key, nonce, len(data))))
    return f"{_ENC_PREFIX}{nonce.hex()}:{ct.hex()}"


def decrypt_secret(stored: str | None) -> str:
    """Recover plaintext from an ``encrypt_secret`` value ("" if not decodable)."""
    if not stored or not stored.startswith(_ENC_PREFIX):
        return ""
    body = stored[len(_ENC_PREFIX):]
    if ":" not in body:
        return ""
    nonce_hex, _, ct_hex = body.partition(":")
    try:
        nonce = bytes.fromhex(nonce_hex)
        ct = bytes.fromhex(ct_hex)
    except ValueError:
        return ""
    key = _cipher_key()
    data = bytes(a ^ b for a, b in zip(ct, _keystream(key, nonce, len(ct))))
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return ""
