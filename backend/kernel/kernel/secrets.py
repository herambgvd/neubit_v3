"""Symmetric encryption for credentials a service stores in its own database.

Ciphertext is stored as ``enc:v1:<fernet token>``. An unmarked value is legacy
plaintext and passes through unchanged; a marked value that will not decrypt
raises, because that means a rotated ``VE_SECRETS_KEY`` and an operator needs to
see it rather than get ``gAAAAAB...`` handed to an SMTP server.

Two services deliberately do not import this:

 * core keeps its own copy — its image does not carry the kernel, and rewriting a
   module encrypting live tenant secrets is a re-key risk for no gain. The
   derivation here is byte-identical (same env var, HMAC-SHA256 KDF, Fernet).
 * ingest made a different, stronger choice: it hashes the secrets it only ever
   compares, and encrypts only the HMAC secrets it must recompute from. Don't
   "unify" that away.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from typing import Any, Callable

from cryptography.fernet import Fernet, InvalidToken

from .config import get_settings

#: Storage marker. Versioned so a future KDF/cipher change is visible at rest
#: instead of silently re-interpreting existing rows.
ENC_PREFIX = "enc:v1:"

#: KDF input for rows with a NULL tenant_id. A literal rather than "" so it can
#: never collide with a real tenant id.
_GLOBAL_TENANT = "__platform__"


class SecretDecryptError(RuntimeError):
    """A marked value would not decrypt under this key — usually ``VE_SECRETS_KEY``
    rotated, or the row came from another deployment. The message carries no part
    of the value."""


def _fernet_for(tenant_id: str | None) -> Fernet:
    """A per-tenant Fernet key: HMAC-SHA256(master secret, "tenant:<id>").

    Per-tenant so one tenant's key never decrypts another's credentials (STQC
    requirement). Rotating ``VE_SECRETS_KEY`` re-keys everyone; changing the KDF
    input for one tenant re-keys that tenant alone.
    """
    tid = str(tenant_id) if tenant_id else _GLOBAL_TENANT
    key = hmac.new(
        get_settings().secrets_key.encode(), f"tenant:{tid}".encode(), hashlib.sha256
    ).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def is_encrypted(value: Any) -> bool:
    """True if ``value`` is a string this module wrote (carries the marker)."""
    return isinstance(value, str) and value.startswith(ENC_PREFIX)


def encrypt_secret_for(tenant_id: str | None, plaintext: str) -> str:
    """Encrypt under the tenant's own key. Already-encrypted input passes through.

    The pass-through keeps partial updates safe: an admin PATCHing a channel's host
    hands back the ciphertext they were shown, and re-encrypting it would
    double-wrap.
    """
    if is_encrypted(plaintext):
        return plaintext
    return ENC_PREFIX + _fernet_for(tenant_id).encrypt(plaintext.encode()).decode()


def decrypt_secret_for(tenant_id: str | None, value: str) -> str:
    """Decrypt a marked value; return an UNMARKED value unchanged (legacy plaintext)."""
    if not is_encrypted(value):
        return value
    try:
        return _fernet_for(tenant_id).decrypt(value[len(ENC_PREFIX):].encode()).decode()
    except InvalidToken as exc:
        raise SecretDecryptError(
            "stored secret will not decrypt under the current VE_SECRETS_KEY "
            "(key rotated, or the row came from another deployment)"
        ) from exc


# --- selective field encryption over a config blob ---------------------------
#
# The walkers are generic, the predicate is the caller's: which key names hold a
# credential is domain knowledge (see workflow's notifications/secrets.py), the
# ciphering is not.


def _walk(obj: Any, path: tuple[str, ...], is_secret, fn) -> Any:
    if isinstance(obj, dict):
        return {k: _walk(v, path + (str(k),), is_secret, fn) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_walk(v, path, is_secret, fn) for v in obj]
    if isinstance(obj, str) and path and is_secret(path):
        return fn(obj)
    return obj


def encrypt_fields(
    tenant_id: str | None, data: dict | None, is_secret: Callable[[tuple[str, ...]], bool]
) -> dict | None:
    """Return a copy of ``data`` with every string leaf ``is_secret`` selects encrypted.

    Selective rather than encrypting the whole document, so the non-secret half
    (host, URL, port, TLS flag) stays readable and queryable. The threat model is
    "can read the table", and the host was never worth hiding.
    """
    if not data:
        return data
    return _walk(data, (), is_secret, lambda s: encrypt_secret_for(tenant_id, s))


def decrypt_fields(
    tenant_id: str | None, data: dict | None, is_secret: Callable[[tuple[str, ...]], bool]
) -> dict | None:
    """Inverse of :func:`encrypt_fields`; legacy plaintext leaves pass through."""
    if not data:
        return data
    return _walk(data, (), is_secret, lambda s: decrypt_secret_for(tenant_id, s))


def redact_fields(
    data: dict | None, is_secret: Callable[[tuple[str, ...]], bool], placeholder: str = "********"
) -> dict | None:
    """Return a copy safe to log or serialise: every secret leaf replaced wholesale.

    Wholesale, not a ``…abc123`` tail mask — the tail identifies a shared token to
    anyone correlating leaks, and nothing here needs a secret recognisable by sight.
    """
    if not data:
        return data
    return _walk(data, (), is_secret, lambda _s: placeholder)
