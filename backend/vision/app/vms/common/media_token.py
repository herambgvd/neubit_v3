"""Short-lived signed **media token** — the live-stream hot-path credential.

vision mints one of these per playback session; the browser carries it as
``?token=<t>`` on every HLS segment / WHEP request, and Traefik ForwardAuth (P2-C)
calls ``GET /api/v1/vms/media/verify`` which validates it here before letting the
request reach MediaMTX. Because it gates EVERY segment it is:

  * **Stateless** — a plain HS256 JWT signed with the SAME kernel ``jwt_secret``
    the access tokens use (no new secret, no DB hit to verify). Distinguished from
    an access token by ``sub_type="media"`` (access tokens use ``type="access"``),
    so a media token can NEVER be used as an API token and vice-versa.
  * **Short-lived** — TTL ``VE_MEDIA_TOKEN_TTL_SEC`` (default 300s), renewable via
    the session ``/renew`` endpoint so long live views don't drop.

Claims: ``{sub_type:"media", tenant_id, camera_id, session_id, iat, exp}``.

Kept dependency-light (pyjwt only, already a kernel dep) and independent of the
kernel auth module so it can be imported on the hot path without pulling FastAPI
security wiring.
"""

from __future__ import annotations

import hashlib
import os
import time

import jwt

_ALG = "HS256"
_SUB_TYPE = "media"
_DEFAULT_TTL = 300


def media_token_ttl() -> int:
    """TTL (seconds) for a minted media token — ``VE_MEDIA_TOKEN_TTL_SEC`` (default 300)."""
    raw = os.environ.get("VE_MEDIA_TOKEN_TTL_SEC", "").strip()
    try:
        ttl = int(raw) if raw else _DEFAULT_TTL
    except ValueError:
        ttl = _DEFAULT_TTL
    return ttl if ttl > 0 else _DEFAULT_TTL


def _secret() -> str:
    # Lazy import avoids an import cycle + keeps the module cheap to import.
    from kernel.config import get_settings

    return get_settings().jwt_secret


def mint_media_token(
    *,
    tenant_id: str | None,
    camera_id: str,
    session_id: str,
    ttl_seconds: int | None = None,
    mode: str = "live",
) -> tuple[str, int]:
    """Mint a media token → ``(token, exp_epoch_seconds)``.

    ``tenant_id`` is stringified (or the reserved ``"platform"`` for a NULL-tenant /
    super-admin session) so the verify path can compare it to the camera's tenant.

    ``mode`` (``"live"`` default, ``"playback"`` for P4-A recorded playback) is
    carried as a claim so a token can be audited/scoped by what it gates. It does NOT
    change the signature/type — a ``mode:playback`` token is a normal media token and
    ``verify_media_token`` accepts it identically (it gates the same MediaMTX proxy).
    """
    ttl = ttl_seconds if (ttl_seconds and ttl_seconds > 0) else media_token_ttl()
    now = int(time.time())
    exp = now + ttl
    claims = {
        "sub_type": _SUB_TYPE,
        "tenant_id": tenant_id if tenant_id is not None else "platform",
        "camera_id": camera_id,
        "session_id": session_id,
        "mode": mode or "live",
        "iat": now,
        "exp": exp,
    }
    token = jwt.encode(claims, _secret(), algorithm=_ALG)
    # pyjwt<2 returns bytes; normalise to str.
    if isinstance(token, bytes):  # pragma: no cover - pyjwt>=2 returns str
        token = token.decode("utf-8")
    return token, exp


def verify_media_token(token: str) -> dict:
    """Decode + verify a media token → its claims dict.

    Raises ``jwt.PyJWTError`` (or ``ValueError``) on any signature/expiry/type
    problem — the caller maps that to a 401. Fast + stateless: a single HMAC verify,
    no DB.
    """
    if not token:
        raise ValueError("missing media token")
    payload = jwt.decode(token, _secret(), algorithms=[_ALG])
    if payload.get("sub_type") != _SUB_TYPE:
        raise ValueError("not a media token")
    if not payload.get("camera_id") or not payload.get("session_id"):
        raise ValueError("media token missing camera/session")
    return payload


def token_hash(token: str) -> str:
    """SHA-256 hex of a token — what we persist at rest (never the raw token)."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
