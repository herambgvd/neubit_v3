"""Per-webhook secret hashing + inbound auth verification.

Most secrets (api_key token / basic password / bearer token) are stored HASHED,
never in plaintext: a salted SHA-256 (salt.hexdigest) — no shared encryption key
needed, and a DB leak never exposes usable credentials. Verification recomputes
the hash with the stored salt and compares in constant time.

HMAC webhooks are the exception: verifying a GitHub-style ``X-Signature`` header
requires the ORIGINAL shared secret to recompute the signature, so a one-way hash
won't do. Those secrets are stored REVERSIBLY-ENCRYPTED (``enc:...``) with a
stream cipher keyed off the kernel ``jwt_secret`` (no new dependency, no
plaintext at rest). The auth field on the model still holds one opaque string;
``hash_secret`` / ``verify_secret`` handle the hashed case and
``encrypt_secret`` / ``decrypt_secret`` handle the reversible case.

The inbound verifier dispatches on the webhook's ``auth_type`` and reads the
credential straight off the request. On any mismatch it returns a generic
failure — the receiver route turns that into a bare 401 with no detail, so a
caller can't distinguish "bad token" from "no such webhook".
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


# --- reversible secret encryption (HMAC shared secrets need the raw value) -----

_ENC_PREFIX = "enc:"


def _cipher_key() -> bytes:
    """Derive a 32-byte key from the kernel JWT secret (lazy — avoids import cycles)."""
    from kernel.config import get_settings

    return hashlib.sha256(get_settings().jwt_secret.encode("utf-8")).digest()


def _keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    """HMAC-SHA256 counter-mode keystream (stdlib only, no cryptography dep)."""
    out = bytearray()
    counter = 0
    while len(out) < length:
        block = hmac.new(
            key, nonce + counter.to_bytes(4, "big"), hashlib.sha256
        ).digest()
        out.extend(block)
        counter += 1
    return bytes(out[:length])


def encrypt_secret(plain: str) -> str:
    """Reversibly encrypt a secret → ``"enc:<nonce_hex>:<ct_hex>"`` for storage."""
    key = _cipher_key()
    nonce = os.urandom(16)
    data = plain.encode("utf-8")
    ct = bytes(a ^ b for a, b in zip(data, _keystream(key, nonce, len(data))))
    return f"{_ENC_PREFIX}{nonce.hex()}:{ct.hex()}"


def decrypt_secret(stored: str | None) -> str | None:
    """Recover a plaintext from an ``encrypt_secret`` value (None if not encrypted)."""
    if not stored or not stored.startswith(_ENC_PREFIX):
        return None
    body = stored[len(_ENC_PREFIX):]
    if ":" not in body:
        return None
    nonce_hex, _, ct_hex = body.partition(":")
    try:
        nonce = bytes.fromhex(nonce_hex)
        ct = bytes.fromhex(ct_hex)
    except ValueError:
        return None
    key = _cipher_key()
    data = bytes(a ^ b for a, b in zip(ct, _keystream(key, nonce, len(ct))))
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def store_secret(auth_type: str, plain: str) -> str:
    """Encode a secret for storage per auth_type.

    hmac needs the raw value back (to recompute signatures) → reversible
    encryption; everything else is one-way hashed.
    """
    return encrypt_secret(plain) if auth_type == "hmac" else hash_secret(plain)


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


def _verify_bearer(request: Request, secret_hash: str | None) -> AuthResult:
    """``Authorization: Bearer <secret>`` checked against the stored hash."""
    if not secret_hash:
        return _fail("webhook has no bearer token configured")
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        return _fail("missing Bearer token")
    sent = header.split(" ", 1)[1].strip()
    if not sent:
        return _fail("missing Bearer token")
    return _OK if verify_secret(sent, secret_hash) else _fail("bad token")


def _verify_hmac(
    request: Request, secret_enc: str | None, raw_body: bytes
) -> AuthResult:
    """GitHub-style HMAC-SHA256 of the raw body vs ``X-Signature`` header.

    Needs the ORIGINAL secret (reversibly encrypted at rest), not a hash.
    """
    secret = decrypt_secret(secret_enc)
    if not secret:
        return _fail("webhook has no HMAC secret configured")
    sent = (
        request.headers.get("x-signature")
        or request.headers.get("x-hub-signature-256")
        or ""
    ).strip()
    if not sent:
        return _fail("missing X-Signature header")
    # Accept "sha256=<hex>" or bare hex.
    if "=" in sent:
        algo, _, hexsig = sent.partition("=")
        if algo.lower() != "sha256":
            return _fail(f"unsupported sig algo: {algo}")
        sent = hexsig
    expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return _OK if hmac.compare_digest(sent.lower(), expected.lower()) else _fail("bad signature")


def verify_inbound(
    request: Request,
    *,
    auth_type: str,
    auth_username: str | None,
    auth_secret_hash: str | None,
    raw_body: bytes = b"",
) -> AuthResult:
    """Dispatch to the right verifier based on the webhook's ``auth_type``.

    ``auth_secret_hash`` holds a SALTED HASH for api_key/basic/bearer and a
    REVERSIBLE-ENCRYPTED value (``enc:...``) for hmac.
    """
    if auth_type == "none":
        return _OK
    if auth_type == "api_key":
        return _verify_api_key(request, auth_secret_hash)
    if auth_type == "basic":
        return _verify_basic(request, auth_username, auth_secret_hash)
    if auth_type == "bearer":
        return _verify_bearer(request, auth_secret_hash)
    if auth_type == "hmac":
        return _verify_hmac(request, auth_secret_hash, raw_body)
    return _fail(f"unknown auth_type: {auth_type}")
