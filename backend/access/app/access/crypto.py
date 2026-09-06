"""Controller credentials at rest — per-tenant Fernet via kernel.secrets.

The connector needs the plaintext to authenticate, so these are reversibly
encrypted rather than hashed.

WHAT THIS REPLACED. This module used to be its own cipher: an HMAC-SHA256
keystream XORed over the plaintext, keyed from VE_JWT_SECRET, stored as
`enc:<nonce>:<ct>`. Three problems, none exotic:

  * Unauthenticated. A stream cipher with no MAC is malleable — flip a bit of
    ciphertext and the same bit of the recovered password flips.
  * Keyed from the JWT secret. Rotating the token secret, which is routine,
    silently re-keyed every stored controller credential.
  * A failed decrypt returned "". After a rotation every connector would
    authenticate with an empty password and the log would say "401".

kernel.secrets gives per-tenant keys derived from VE_SECRETS_KEY, Fernet
(AES-CBC + HMAC), and a decrypt that RAISES rather than guessing.

Legacy `enc:<nonce>:<ct>` rows still decrypt, under the old jwt-secret keystream,
so an existing deployment keeps working. They are re-encrypted in the new format
on the next write.
"""

from __future__ import annotations

import hashlib
import hmac
import uuid

from kernel.secrets import decrypt_secret_for, encrypt_secret_for

_LEGACY_PREFIX = "enc:"
_NEW_PREFIX = "enc:v1:"


def _tid(tenant_id: uuid.UUID | str | None) -> str | None:
    return str(tenant_id) if tenant_id else None


def _legacy_key() -> bytes:
    from kernel.config import get_settings

    return hashlib.sha256(get_settings().jwt_secret.encode("utf-8")).digest()


def _legacy_keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    out = bytearray()
    counter = 0
    while len(out) < length:
        out.extend(hmac.new(key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest())
        counter += 1
    return bytes(out[:length])


def _decrypt_legacy(stored: str) -> str:
    """Recover a value written by the old keystream cipher. "" if undecodable.

    Kept lenient on purpose: this path only ever sees rows that predate the
    change, and there is nothing an operator can do about a corrupt one.
    """
    body = stored[len(_LEGACY_PREFIX):]
    nonce_hex, _, ct_hex = body.partition(":")
    if not ct_hex:
        return ""
    try:
        nonce, ct = bytes.fromhex(nonce_hex), bytes.fromhex(ct_hex)
    except ValueError:
        return ""
    data = bytes(a ^ b for a, b in zip(ct, _legacy_keystream(_legacy_key(), nonce, len(ct))))
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return ""


def encrypt_secret(tenant_id: uuid.UUID | str | None, plain: str) -> str:
    """Encrypt under the owning tenant's key."""
    return encrypt_secret_for(_tid(tenant_id), plain)


def decrypt_secret(tenant_id: uuid.UUID | str | None, stored: str | None) -> str:
    """Decrypt a stored credential.

    Raises SecretDecryptError for a current-format value that will not decrypt —
    an operator rotated VE_SECRETS_KEY, and that must be visible rather than
    becoming a mystery 401 from the controller.
    """
    if not stored:
        return ""
    if stored.startswith(_NEW_PREFIX):
        return decrypt_secret_for(_tid(tenant_id), stored)
    if stored.startswith(_LEGACY_PREFIX):
        return _decrypt_legacy(stored)
    return stored
