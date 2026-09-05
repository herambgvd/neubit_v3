"""Helpers shared by the auth route modules.

Kept in one place rather than duplicated per module: `_user_out` is the single
shape a user is serialised in, and two copies of it drift the day one grows a
field. `_user_from_mfa_token` is here rather than in `session.py` because the
enrolment routes and the login routes both resolve the same challenge token.
"""

from __future__ import annotations

import datetime as _dtmod

import uuid

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.errors import UnauthorizedError
from ...core.storage import get_storage
from ..models import User
from ..schemas import UserOut


def _now_utc() -> _dtmod.datetime:
    return _dtmod.datetime.now(_dtmod.timezone.utc)


async def _user_out(user: User, active_sessions: int = 0) -> UserOut:
    """Serialise a User, resolving its avatar_key → a fetchable avatar_url and
    deriving the ``locked`` flag from ``locked_until``.

    The DB holds a storage *key*; the client needs a *URL*. We resolve it here at
    response time via the storage backend (a stable local URL or a presigned S3
    link), exactly like branding does for its logo. No avatar => avatar_url None.
    The security-posture fields (failed_login_count, locked_until,
    password_changed_at, site_ids, totp_enabled) map straight off the model.
    """
    out = UserOut.model_validate(user)
    out.avatar_url = await get_storage().url(user.avatar_key) if user.avatar_key else None
    lu = user.locked_until
    if lu is not None and lu.tzinfo is None:
        lu = lu.replace(tzinfo=_dtmod.timezone.utc)
    out.locked = bool(lu and lu > _now_utc())
    out.active_sessions = active_sessions
    return out


def _client_ip(request: Request) -> str | None:
    """Best-effort client IP: first X-Forwarded-For hop if proxied, else peer."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else None


async def _user_from_mfa_token(mfa_token: str, db: AsyncSession) -> User:
    """Resolve the user behind a short-lived 'mfa' challenge token (raises 401)."""
    import jwt as _jwt

    from ..security import decode_token

    try:
        payload = decode_token(mfa_token)
    except _jwt.PyJWTError:
        raise UnauthorizedError("invalid or expired 2FA session")
    if payload.get("type") != "mfa":
        raise UnauthorizedError("not a 2FA enrollment token")
    user = await db.get(User, uuid.UUID(payload["sub"]))
    if user is None or not user.is_active:
        raise UnauthorizedError("2FA session is no longer valid")
    return user


