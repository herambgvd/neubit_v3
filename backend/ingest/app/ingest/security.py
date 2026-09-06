"""Per-webhook secret hashing + inbound auth verification.

Most secrets (api_key token / basic password / bearer token) are stored HASHED,
never in plaintext: a salted SHA-256 (salt.hexdigest) — no shared encryption key
needed, and a DB leak never exposes usable credentials. Verification recomputes
the hash with the stored salt and compares in constant time.

HMAC webhooks are the exception: recomputing a GitHub-style ``X-Signature``
needs the original shared secret, so those are stored reversibly encrypted
(``enc:...``) with a stream cipher keyed off the kernel ``jwt_secret``. The model
column holds one opaque string either way — ``hash_secret`` / ``verify_secret``
for the hashed case, ``encrypt_secret`` / ``decrypt_secret`` for the reversible one.

The inbound verifier dispatches on ``auth_type`` and reads the credential off the
request. Any mismatch returns a generic failure that the route turns into a bare
401, so a caller can't tell "bad token" from "no such webhook".
"""

from __future__ import annotations

import time
from collections import OrderedDict

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
    """Encode a secret for storage per auth_type: hmac reversibly encrypted, since
    it needs the raw value back to recompute signatures, everything else hashed."""
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


#: Signatures seen recently, so an identical request is not accepted twice.
#: Per process, which is what this service runs; a second worker would each keep
#: their own. The timestamp window below is the protection that does not depend on
#: shared state, and it is the one to configure.
_SEEN: "OrderedDict[str, float]" = OrderedDict()
_SEEN_MAX = 10_000


def _already_seen(signature: str, window: float) -> bool:
    """True if this exact signature arrived within `window` seconds."""
    now = time.time()
    while _SEEN and next(iter(_SEEN.values())) < now - window:
        _SEEN.popitem(last=False)
    if signature in _SEEN:
        return True
    _SEEN[signature] = now
    while len(_SEEN) > _SEEN_MAX:
        _SEEN.popitem(last=False)
    return False


#: Dedup window when the webhook sets no explicit one. Long enough to catch a
#: retry storm, short enough that the cache stays small.
_DEFAULT_REPLAY_WINDOW_SEC = 300


def _verify_hmac(
    request: Request,
    secret_enc: str | None,
    raw_body: bytes,
    max_age_seconds: int | None = None,
) -> AuthResult:
    """HMAC-SHA256 over the body, or over "<timestamp>.<body>" when a window is set.

    The signature used to cover the body alone, so a captured request replayed
    forever and each replay produced a fresh accepted event.

    With `max_age_seconds` the sender must send X-Timestamp and sign it with the
    body, so a capture stops working once the window passes. Without it — the
    GitHub-style shape, which sends no timestamp — the best available protection is
    refusing a signature we have already seen, which is also a correct dedup for a
    genuine retry.
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
    sent = sent.lower()

    signed = raw_body
    if max_age_seconds:
        stamp = (request.headers.get("x-timestamp") or "").strip()
        if not stamp:
            return _fail("missing X-Timestamp header")
        try:
            sent_at = float(stamp)
        except ValueError:
            return _fail("bad X-Timestamp")
        drift = abs(time.time() - sent_at)
        if drift > max_age_seconds:
            return _fail("stale request")
        signed = stamp.encode("utf-8") + b"." + raw_body

    expected = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sent, expected.lower()):
        return _fail("bad signature")

    # Only after the signature is valid: an attacker must not be able to fill the
    # cache with guesses, and a wrong signature is already refused.
    if _already_seen(sent, float(max_age_seconds or _DEFAULT_REPLAY_WINDOW_SEC)):
        return _fail("replayed request")
    return _OK


def verify_inbound(
    request: Request,
    *,
    auth_type: str,
    auth_username: str | None,
    auth_secret_hash: str | None,
    raw_body: bytes = b"",
    hmac_max_age_seconds: int | None = None,
) -> AuthResult:
    """Dispatch to the right verifier based on the webhook's ``auth_type``.
    ``auth_secret_hash`` holds a salted hash for api_key/basic/bearer, and a
    reversibly-encrypted value (``enc:...``) for hmac."""
    if auth_type == "none":
        return _OK
    if auth_type == "api_key":
        return _verify_api_key(request, auth_secret_hash)
    if auth_type == "basic":
        return _verify_basic(request, auth_username, auth_secret_hash)
    if auth_type == "bearer":
        return _verify_bearer(request, auth_secret_hash)
    if auth_type == "hmac":
        return _verify_hmac(request, auth_secret_hash, raw_body, hmac_max_age_seconds)
    return _fail(f"unknown auth_type: {auth_type}")
