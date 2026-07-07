"""Per-webhook secret hashing + inbound auth verification.

Secrets (api_key token / basic password) are stored HASHED, never in plaintext:
a salted SHA-256 (salt.hexdigest) — no shared encryption key needed, and a DB
leak never exposes usable credentials. Verification recomputes the hash with the
stored salt and compares in constant time.

The inbound verifier dispatches on the webhook's ``auth_type`` and reads the
credential straight off the request (Authorization header). On any mismatch it
returns a generic failure — the receiver route turns that into a bare 401 with
no detail, so a caller can't distinguish "bad token" from "no such webhook".
"""

from __future__ import annotations

import hashlib
import hmac
import os
from dataclasses import dataclass

from starlette.requests import Request


# --- secret hashing (config side) ------------------------------------------


def hash_secret(plain: str) -> str:
    """Salted SHA-256 of a secret → ``"<salt_hex>.<digest_hex>"`` for storage."""
    salt = os.urandom(16)
    digest = hashlib.sha256(salt + plain.encode("utf-8")).hexdigest()
    return f"{salt.hex()}.{digest}"


def verify_secret(plain: str, stored: str | None) -> bool:
    """Constant-time check of ``plain`` against a ``hash_secret`` value."""
    if not stored or "." not in stored:
        return False
    salt_hex, _, digest_hex = stored.partition(".")
    try:
        salt = bytes.fromhex(salt_hex)
    except ValueError:
        return False
    candidate = hashlib.sha256(salt + plain.encode("utf-8")).hexdigest()
    return hmac.compare_digest(candidate, digest_hex)


# --- inbound auth verification (receiver side) -----------------------------


@dataclass(frozen=True)
class AuthResult:
    ok: bool
    reason: str = ""


def _fail(reason: str) -> AuthResult:
    return AuthResult(False, reason)


_OK = AuthResult(True)


def _verify_api_key(request: Request, secret_hash: str | None) -> AuthResult:
    """Bearer token OR ``X-API-Key`` header, checked against the stored hash."""
    if not secret_hash:
        return _fail("webhook has no api key configured")
    header = request.headers.get("authorization", "")
    sent = ""
    if header.lower().startswith("bearer "):
        sent = header.split(" ", 1)[1].strip()
    if not sent:
        sent = (request.headers.get("x-api-key") or "").strip()
    if not sent:
        return _fail("missing api key")
    return _OK if verify_secret(sent, secret_hash) else _fail("bad api key")


def _verify_basic(
    request: Request, username: str | None, secret_hash: str | None
) -> AuthResult:
    import base64

    header = request.headers.get("authorization", "")
    if not header.lower().startswith("basic "):
        return _fail("missing Basic credentials")
    try:
        decoded = base64.b64decode(header[6:].strip()).decode("utf-8")
    except Exception:
        return _fail("invalid base64 in Basic header")
    if ":" not in decoded:
        return _fail("malformed Basic credentials")
    sent_user, _, sent_pass = decoded.partition(":")
    if not hmac.compare_digest(sent_user, (username or "").strip()):
        return _fail("bad credentials")
    return _OK if verify_secret(sent_pass, secret_hash) else _fail("bad credentials")


def verify_inbound(
    request: Request,
    *,
    auth_type: str,
    auth_username: str | None,
    auth_secret_hash: str | None,
) -> AuthResult:
    """Dispatch to the right verifier based on the webhook's ``auth_type``."""
    if auth_type == "none":
        return _OK
    if auth_type == "api_key":
        return _verify_api_key(request, auth_secret_hash)
    if auth_type == "basic":
        return _verify_basic(request, auth_username, auth_secret_hash)
    return _fail(f"unknown auth_type: {auth_type}")
