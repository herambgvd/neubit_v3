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

# Token audiences — the super-admin realm is isolated from tenant users at the token
# level (STQC "separate realm"): a super-admin's access token is stamped
# ``aud=neubit-admin`` and the /admin API demands it, so a tenant-context token
# (``aud=neubit-tenant``) can never reach cross-tenant admin even if it somehow
# carried is_superadmin. The audience is derived from the user at mint time.
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
    # Multi-tenancy claims: which tenant the caller is scoped to (None for
    # super-admins) and whether they hold the platform super-admin role. These
    # are convenience claims — authoritative scoping still re-reads the User row
    # each request (see auth/deps.get_current_user), so a tenant/role change
    # takes effect immediately without waiting for the token to expire.
    #
    # ``permissions`` is the caller's EFFECTIVE permission list, baked into the
    # token so SATELLITE services (ingest/workflow) can authorize locally without
    # a round-trip to core. Super-admins get the wildcard ["*"]; everyone else
    # gets their role's permission set. Core itself ignores this claim — it still
    # loads permissions fresh from the role each request (deps.require_permission),
    # so the additive claim never changes core's own behaviour.
    #
    # ``features``/``limits`` are the caller's tenant entitlements (empty for
    # super-admins, who bypass), baked in for the same reason: a satellite service
    # gates modules + quotas locally off the token. They are resolved by the caller
    # (auth service / impersonation) via tenancy.entitlements.token_entitlements and
    # passed in here — security.py stays DB-free.
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
        # ``role_id`` is the caller's role id, baked in like ``permissions`` so a
        # satellite service can resolve ROLE-subject per-camera ACL grants (keyed
        # on core subject ids "role:<id>") without a round-trip to core. Super-admins
        # may hold no role → None. Core itself ignores this claim.
        "role_id": str(user.role_id) if getattr(user, "role_id", None) else None,
        # ``site_ids`` is the caller's SITE ACCESS SCOPE: the site ids this user may
        # see. EMPTY = unrestricted (all sites in the tenant). Non-empty = the user
        # is confined to exactly these sites — baked in so satellite services (vision)
        # can filter camera/site-derived data locally off the token. Super-admins get
        # [] (unrestricted) and bypass regardless.
        "site_ids": list(getattr(user, "site_ids", None) or []),
        "features": dict(features or {}),
        "limits": dict(limits or {}),
        "license_state": license_state or "active",
        "tenant_status": tenant_status or "active",
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
    """Short-lived token proving the FIRST factor passed; exchanged for real
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

    ``verify_aud=False``: the ``aud`` claim is present on access tokens but is checked
    explicitly where it matters (the /admin API demands ``neubit-admin``), so generic
    decoding must not fail just because an audience is present.
    """
    return jwt.decode(
        token, get_settings().jwt_secret, algorithms=["HS256"], options={"verify_aud": False}
    )


# --- Service API keys ------------------------------------------------------
# A machine credential, and the reason it exists is worth stating where it is
# minted: until 2026-09-05 the only credential this platform could give a peer
# product was a USER'S EMAIL AND PASSWORD. DashForge holds one today
# (NEUBIT_BI_USER / NEUBIT_BI_PASSWORD) because ``kernel.auth.verify_token``
# accepts nothing but a login-minted access JWT. A password is the wrong shape
# for a machine: it opens the console UI, it cannot be narrowed to "read BI",
# revoking it means disabling a human account, and in the audit trail it is
# indistinguishable from a person sitting at a keyboard.
#
# KEY LAYOUT — ``nbk_<8 hex id>_<43 char secret>``
#
# The two segments are separated deliberately. ``prefix`` (``nbk_`` + the id, a
# fixed 12 characters) is stored in the clear, indexed, and shown in every
# listing, so it is the handle an operator uses to recognise a key. The SECRET is
# the rest and appears in no column: only ``sha256(whole key)`` is stored, so a
# database dump does not yield a working credential.
#
# The id is hex on purpose — ``token_urlsafe`` emits ``-`` and ``_``, so a
# variable-width split on the separator could cut inside a secret that happened
# to contain one. Both segments are fixed width and the prefix is taken by slice,
# never by ``split``.
API_KEY_PREFIX = "nbk_"
API_KEY_PREFIX_LEN = 12  # len("nbk_") + 8 hex id chars


def generate_api_key() -> tuple[str, str, str]:
    """Return (raw_key, prefix, sha256_hash). Show raw_key once; store the rest.

    The old format was ``vz_`` + secret with the first 11 characters kept as the
    prefix, i.e. the lookup handle was CARVED OUT OF THE SECRET and then printed
    in the key list. It is replaced rather than kept alongside: two live formats
    would mean two verification paths, and the branch that decides between them is
    exactly where a fail-open gets written.
    """
    raw = f"{API_KEY_PREFIX}{pysecrets.token_hex(4)}_{pysecrets.token_urlsafe(32)}"
    return raw, raw[:API_KEY_PREFIX_LEN], hash_api_key(raw)


def api_key_prefix(raw: str) -> str | None:
    """The lookup prefix of a presented key, or None if it is not one of ours.

    Refusing an unrecognised shape HERE is what keeps the verifier's query from
    ever running on attacker-chosen text, and it is the fail-closed half of the
    contract: a caller that presents something that is not a NeuBit key gets the
    same 401 as one that presents a wrong key, and no row is looked up at all.
    """
    if not raw or not raw.startswith(API_KEY_PREFIX):
        return None
    if len(raw) <= API_KEY_PREFIX_LEN or raw[API_KEY_PREFIX_LEN] != "_":
        return None
    return raw[:API_KEY_PREFIX_LEN]


def hash_api_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


# The audience of a key-derived token. It is the TENANT realm and never
# ``AUD_ADMIN``: a key is always bound to one tenant, so the cross-tenant /admin
# API is closed to it at the realm level as well as by its scopes.
def create_api_key_token(
    key,
    *,
    features: dict | None = None,
    limits: dict | None = None,
    license_state: str | None = None,
    tenant_status: str | None = None,
) -> tuple[str, int]:
    """Mint the short-lived access token an API key is exchanged for → (token, ttl_s).

    THE SHAPE IS THE POINT. This returns an ordinary access token, claim for
    claim, so every one of the nine services keeps verifying it with the code it
    already runs — ``kernel.auth.verify_token`` is not touched, and neither is any
    satellite. The key is a CORE-SIDE credential that buys a token; it is not a
    second thing for a satellite to learn how to check. That is what makes this
    additive: a service that never hears about API keys still enforces their
    scopes correctly, because the scopes arrive in the claim it already reads.

    Three claims differ from a login token, and each closes something:

      * ``sub`` is the KEY's id, not a user's. Core's ``get_current_user`` loads a
        ``users`` row by ``sub`` and 401s when there is none, so a key-derived
        token cannot reach ``/auth/me``, the session endpoints, or anything else
        on the interactive path. A key cannot sign in to the console because
        there is no person for it to be.
      * ``is_superadmin`` is hardcoded False and ``aud`` is hardcoded to the
        tenant realm. Neither is read off the creating admin, so a super-admin
        cannot mint a key that inherits their reach.
      * ``act`` = "apikey" marks the token as machine-driven. Core reads it to
        decide whether to resolve a key row, and it is what stamps
        ``actor_type='apikey'`` on an audit entry.

    ``permissions`` is the key's OWN scope list — never the creator's, never a
    role's live set. A scope removed from the key stops being granted at the next
    exchange; see ``AuthService.authenticate_api_key`` for the revocation window.
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
