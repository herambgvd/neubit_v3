"""Password hashing, JWT tokens, and API-key generation — the crypto primitives.

- Passwords: argon2id (OWASP-recommended). Never store or log the plaintext.
- Tokens: short-lived ACCESS + long-lived REFRESH, signed HS256 with ``VE_JWT_SECRET``.
  Claims are minimal — sub (user id), type, iat, exp. Permissions are NOT baked into
  the token; they're loaded fresh from the user's role each request, so a permission
  change takes effect immediately (no stale token).
- API keys: high-entropy ``nbk_<id>_<secret>`` string; only its SHA-256 hash is
  stored, and the ``nbk_<id>`` prefix — which carries no secret material — is the
  handle used to look the row up.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import secrets as pysecrets
import struct
import time
import urllib.parse

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from ..core.config import get_settings
from ..core.errors import ValidationError

_ph = PasswordHasher()

REFRESH_TTL = dt.timedelta(days=30)

# Token audiences. The super-admin realm is isolated at the token level: the
# /admin API demands ``aud=neubit-admin``, so a tenant token can never reach it
# even if it carried is_superadmin. Derived from the user at mint time.
AUD_ADMIN = "neubit-admin"
AUD_TENANT = "neubit-tenant"


# --- Passwords -------------------------------------------------------------
def hash_password(plaintext: str) -> str:
    return _ph.hash(plaintext)


def verify_password(plaintext: str, hashed: str) -> bool:
    try:
        _ph.verify(hashed, plaintext)
        return True
    except VerifyMismatchError:
        return False


def validate_password(password: str) -> None:
    """Enforce the configured password policy; raise ValidationError if it fails."""
    s = get_settings()
    if len(password) < s.password_min_length:
        raise ValidationError(f"password must be at least {s.password_min_length} characters")
    if s.password_require_number and not any(c.isdigit() for c in password):
        raise ValidationError("password must contain at least one number")
    if s.password_require_letter and not any(c.isalpha() for c in password):
        raise ValidationError("password must contain at least one letter")


# --- JWT -------------------------------------------------------------------
def _encode(
    sub,
    token_type: str,
    ttl: dt.timedelta,
    jti: str | None = None,
    sid: str | None = None,
    extra: dict | None = None,
) -> str:
    now = dt.datetime.now(dt.timezone.utc)
    payload = {"sub": str(sub), "type": token_type, "iat": now, "exp": now + ttl}
    if jti is not None:
        payload["jti"] = jti  # ties a refresh token to a revocable DB row
    if sid is not None:
        payload["sid"] = sid  # ties an access token to its originating session
    if extra:
        payload.update(extra)
    return jwt.encode(payload, get_settings().jwt_secret, algorithm="HS256")


def create_access_token(
    user,
    sid: str | None = None,
    *,
    features: dict | None = None,
    limits: dict | None = None,
    license_state: str | None = None,
    tenant_status: str | None = None,
) -> str:
    ttl = dt.timedelta(minutes=get_settings().jwt_ttl_minutes)
    # The tenant/superadmin/permissions/features/limits claims are conveniences
    # for SATELLITE services, which authorize locally off the token instead of
    # calling core. Core ignores them and re-reads the User row and its role each
    # request (deps.get_current_user), so changes take effect immediately.
    # Entitlements are resolved by the caller (auth service / impersonation) and
    # passed in, so security.py stays DB-free.
    role = getattr(user, "role", None)
    if bool(getattr(user, "is_superadmin", False)):
        permissions = ["*"]
    elif role is not None and getattr(role, "permissions", None) is not None:
        permissions = list(role.permissions)
    else:
        permissions = []
    extra = {
        "tenant_id": str(user.tenant_id) if getattr(user, "tenant_id", None) else None,
        "is_superadmin": bool(getattr(user, "is_superadmin", False)),
        "permissions": permissions,
        # Lets a satellite resolve role-subject per-camera ACL grants (keyed
        # "role:<id>") without calling core. None for super-admins with no role.
        "role_id": str(user.role_id) if getattr(user, "role_id", None) else None,
        # Site access scope. Empty = unrestricted (all sites in the tenant);
        # non-empty confines the user to exactly these sites. Super-admins get [].
        "site_ids": list(getattr(user, "site_ids", None) or []),
        "features": dict(features or {}),
        "limits": dict(limits or {}),
        "license_state": license_state or "active",
        "tenant_status": tenant_status or "active",
        # WHO, in words. A satellite stamps the acting user onto the rows it
        # writes (a threat-level change, an SOP step execution) and had only the
        # uuid to stamp — so those screens printed a uuid at an operator, or
        # would have had to call core for a name on every write. It is the
        # holder's OWN name in their OWN token, so it discloses nothing they do
        # not already have; a rename shows the old name until the next login,
        # which is what a stamp-at-write-time field means anyway.
        "name": getattr(user, "full_name", None) or None,
        # Realm isolation: super-admins get the admin audience, everyone else the
        # tenant audience (impersonation mints a tenant-admin → tenant audience).
        "aud": AUD_ADMIN if bool(getattr(user, "is_superadmin", False)) else AUD_TENANT,
    }
    return _encode(user.id, "access", ttl, sid=sid, extra=extra)


def create_refresh_token(user, jti: str) -> str:
    return _encode(user.id, "refresh", REFRESH_TTL, jti=jti)


# --- Two-factor (TOTP, RFC 6238) + MFA challenge token ---------------------
MFA_CHALLENGE_TTL = dt.timedelta(minutes=5)


def create_mfa_challenge_token(user) -> str:
    """Short-lived token proving the first factor passed; exchanged for real
    tokens once the user submits a valid TOTP/recovery code."""
    return _encode(user.id, "mfa", MFA_CHALLENGE_TTL)


def generate_totp_secret() -> str:
    """A fresh base32 TOTP secret (160 bits, no padding) for an authenticator app."""
    return base64.b32encode(pysecrets.token_bytes(20)).decode().rstrip("=")


def totp_provisioning_uri(secret_b32: str, account: str, issuer: str) -> str:
    """otpauth:// URI the client renders as a QR code for Google Authenticator etc."""
    label = urllib.parse.quote(f"{issuer}:{account}")
    query = urllib.parse.urlencode(
        {"secret": secret_b32, "issuer": issuer, "algorithm": "SHA1", "digits": 6, "period": 30}
    )
    return f"otpauth://totp/{label}?{query}"


def _hotp(secret_b32: str, counter: int, digits: int = 6) -> str:
    key = base64.b32decode(secret_b32 + "=" * (-len(secret_b32) % 8))
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = (struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF) % (10**digits)
    return str(code).zfill(digits)


def verify_totp(secret_b32: str, code: str, *, window: int = 1, period: int = 30) -> bool:
    """Validate a 6-digit TOTP, tolerating +/- ``window`` steps of clock drift."""
    code = (code or "").strip().replace(" ", "")
    if not code.isdigit() or len(code) != 6:
        return False
    counter = int(time.time() // period)
    return any(
        hmac.compare_digest(_hotp(secret_b32, counter + drift), code)
        for drift in range(-window, window + 1)
    )


def normalize_recovery_code(code: str) -> str:
    return (code or "").strip().replace(" ", "").lower()


def generate_recovery_codes(n: int = 10) -> tuple[list[str], list[str]]:
    """Return (raw_codes, hashed_codes). Show raw once; store only the hashes."""
    raw = [f"{pysecrets.token_hex(2)}-{pysecrets.token_hex(2)}" for _ in range(n)]
    return raw, [hash_api_key(normalize_recovery_code(c)) for c in raw]


def generate_reset_token() -> tuple[str, str]:
    """Return (raw_token, sha256_hash). Email the raw; store the hash."""
    raw = pysecrets.token_urlsafe(32)
    return raw, hash_api_key(raw)


def decode_token(token: str) -> dict:
    """Decode + verify signature/expiry. Raises jwt.PyJWTError on failure.

    ``verify_aud=False`` because ``aud`` is checked explicitly where it matters
    (the /admin API demands ``neubit-admin``); generic decoding must not fail
    just because an audience is present.
    """
    return jwt.decode(
        token, get_settings().jwt_secret, algorithms=["HS256"], options={"verify_aud": False}
    )


# --- Service API keys ------------------------------------------------------
# Key layout: ``nbk_<8 hex id>_<43 char secret>``.
#
# The prefix (``nbk_`` + the id, a fixed 12 chars) is stored in the clear and
# shown in listings — it is the operator's handle. The secret appears in no
# column; only sha256(whole key) is stored, so a DB dump yields no credential.
#
# The id is hex on purpose: ``token_urlsafe`` emits ``-`` and ``_``, so splitting
# on the separator could cut inside a secret. Both segments are fixed width and
# the prefix is taken by slice, never by ``split``.
API_KEY_PREFIX = "nbk_"
API_KEY_PREFIX_LEN = 12  # len("nbk_") + 8 hex id chars


def generate_api_key() -> tuple[str, str, str]:
    """Return (raw_key, prefix, sha256_hash). Show raw_key once; store the rest.

    One format only — the old ``vz_`` keys carved the printed prefix out of the
    secret. Do not reintroduce a second format: the branch choosing between two
    verification paths is where a fail-open gets written.
    """
    raw = f"{API_KEY_PREFIX}{pysecrets.token_hex(4)}_{pysecrets.token_urlsafe(32)}"
    return raw, raw[:API_KEY_PREFIX_LEN], hash_api_key(raw)


def api_key_prefix(raw: str) -> str | None:
    """The lookup prefix of a presented key, or None if it is not one of ours.

    Rejecting an unrecognised shape here keeps the verifier's query from running
    on attacker-chosen text; a non-NeuBit string 401s without any row lookup.
    """
    if not raw or not raw.startswith(API_KEY_PREFIX):
        return None
    if len(raw) <= API_KEY_PREFIX_LEN or raw[API_KEY_PREFIX_LEN] != "_":
        return None
    return raw[:API_KEY_PREFIX_LEN]


def hash_api_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


# A key-derived token is always the tenant realm, never ``AUD_ADMIN``: the
# cross-tenant /admin API is closed to it by realm as well as by scopes.
def create_api_key_token(
    key,
    *,
    features: dict | None = None,
    limits: dict | None = None,
    license_state: str | None = None,
    tenant_status: str | None = None,
) -> tuple[str, int]:
    """Mint the short-lived access token an API key is exchanged for → (token, ttl_s).

    Deliberately an ordinary access token, claim for claim, so satellites keep
    verifying it with ``kernel.auth.verify_token`` unchanged and enforce a key's
    scopes without knowing keys exist. Three claims differ from a login token:

      * ``sub`` is the key's id, not a user's. ``get_current_user`` 401s when
        ``sub`` is not a users row, so a key cannot reach the interactive path.
      * ``is_superadmin`` is hardcoded False and ``aud`` hardcoded to the tenant
        realm, so a super-admin cannot mint a key that inherits their reach.
      * ``act="apikey"`` marks the token machine-driven; it stamps
        ``actor_type='apikey'`` on audit entries.

    ``permissions`` is the key's own scope list, never the creator's or a role's
    live set. See ``AuthService.authenticate_api_key`` for the revocation window.
    """
    ttl_minutes = get_settings().api_key_token_ttl_minutes
    ttl = dt.timedelta(minutes=ttl_minutes)
    extra = {
        "tenant_id": str(key.tenant_id) if getattr(key, "tenant_id", None) else None,
        "is_superadmin": False,
        "permissions": list(getattr(key, "scopes", None) or []),
        "role_id": None,
        "site_ids": [],
        "features": dict(features or {}),
        "limits": dict(limits or {}),
        "license_state": license_state or "active",
        "tenant_status": tenant_status or "active",
        "aud": AUD_TENANT,
        "act": "apikey",
    }
    return _encode(key.id, "access", ttl, extra=extra), int(ttl.total_seconds())
