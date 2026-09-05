"""Symmetric encryption for credentials that services store in their OWN database.

WHY THIS IS IN kernel AND NOT COPIED INTO THE SERVICE THAT NEEDED IT

``core`` already solved this (``core/app/core/secrets.py``) and ``ingest`` already
solved the adjacent half of it (``ingest/app/ingest/security.py``). Workflow was
about to be the third, and three hand-rolled Fernet derivations is not three
implementations of one scheme — it is three schemes that agree today, drift on the
first bug fix, and leave an auditor asking which of them the STQC per-tenant-key
claim actually describes. So the derivation lives once, here, where every service
that carries the kernel can reach it.

WHAT THIS COSTS, SINCE kernel IS IMPORTED BY NINE SERVICES. Nothing at import
time and nothing at runtime for the eight that do not use it: this is a NEW module
that no existing module imports, so adding it cannot change any behaviour that is
running today. It adds NO dependency either — ``cryptography`` is already in every
kernel image via ``pyjwt[crypto]``. The one edit to shared code is a ``secrets_key``
field on ``kernel.config.Settings``, additive and with the same name, prefix and
default as core's, so a stack that already sets ``VE_SECRETS_KEY`` (deploy/.env
does) needs no config change and a stack that does not keeps booting.

WHAT IS DELIBERATELY NOT DONE HERE

 * core is NOT changed to import this. core's image deliberately does not carry the
   kernel (see core/pyproject.toml), so it cannot; and rewriting a module that is
   encrypting live tenant secrets, to gain nothing but tidiness, is a re-key risk
   taken for style. The derivation below is byte-identical to core's on purpose —
   same env var, same HMAC-SHA256 KDF, same Fernet — so the two are one scheme
   reachable from two places, not two schemes.
 * ingest is NOT changed to import this either. ingest's choice is a DIFFERENT
   choice, not a worse copy of this one: it HASHES the secrets it only ever needs
   to compare, and reversibly encrypts only the HMAC shared secrets it must
   recompute a signature from. Hashing where a one-way value suffices is stronger
   than what is here. Do not "unify" that away.

THE MARKER, AND WHY LENIENT DECRYPT IS NOT AN EXCEPTION HANDLER HERE

Ciphertext is stored as ``enc:v1:<fernet token>`` (the ``enc:`` convention ingest
already uses). Deployments have live rows written before encryption existed, and a
deploy that cannot read what it wrote yesterday is an outage — so a value WITHOUT
the marker is returned unchanged. core gets that same leniency by catching
``InvalidToken``, which cannot tell "this is legacy plaintext" from "this is
ciphertext I no longer hold the key for" and answers both by handing the caller the
raw ciphertext. The first is a migration; the second is an operator who rotated
``VE_SECRETS_KEY``, and quietly returning the ciphertext there means an SMTP
password of ``gAAAAAB...`` is presented to a mail server and the log says
"authentication failed". The marker separates the two: no marker is plaintext, a
marker that will not decrypt raises. Fail loudly on the case an operator can fix.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from typing import Any, Callable

from cryptography.fernet import Fernet, InvalidToken

from .config import get_settings

#: Storage marker. Versioned so a future KDF/cipher change is distinguishable at
#: rest instead of being a silent re-interpretation of existing rows.
ENC_PREFIX = "enc:v1:"

#: Key material for rows whose ``tenant_id`` is NULL (platform / system rows).
#: A literal, not the empty string, so it cannot collide with a real tenant id —
#: tenant ids are UUIDs and no UUID renders as this.
_GLOBAL_TENANT = "__platform__"


class SecretDecryptError(RuntimeError):
    """A value carried the ``enc:`` marker but would not decrypt under this key.

    Almost always ``VE_SECRETS_KEY`` changed (or the row was restored from another
    deployment's backup). The message deliberately carries NO part of the value.
    """


def _fernet_for(tenant_id: str | None) -> Fernet:
    """A PER-TENANT Fernet key: HMAC-SHA256(master secret, "tenant:<id>").

    Per-tenant and not one global key because the data being protected is
    per-tenant: one tenant's key must never decrypt another's credentials (the STQC
    per-tenant-key / data-residency requirement core states in its own copy).
    Rotating ``VE_SECRETS_KEY`` re-keys every tenant; swapping the KDF input for one
    tenant re-keys that tenant alone.
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

    The pass-through is what makes a partial update safe: an admin PATCHing a
    channel's host without retyping its password hands back the ciphertext it was
    shown, and re-encrypting that would produce a double-wrapped value that decrypts
    to ciphertext.
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
# The walkers are generic and the PREDICATE is the caller's, on purpose. Which key
# names hold a credential is domain knowledge that belongs with the domain (see
# workflow's notifications/secrets.py); which bytes get a cipher applied to them is
# not, and that is the half that must not be re-implemented per service.


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

    Selective and not a blob-encrypt of the whole document: a blob makes the
    non-secret half (SMTP host, webhook URL, port, TLS flag) unreadable to anyone
    debugging a channel and unsearchable to any query, and buys nothing — the
    attacker model is "can read the table", and the host was never the thing worth
    hiding.
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

    Not a mask of the tail (``…abc123``): for a shared API token the tail IS a
    usable identifier for an attacker correlating leaks, and there is no operator
    workflow here that needs to recognise a secret by sight.
    """
    if not data:
        return data
    return _walk(data, (), is_secret, lambda _s: placeholder)
