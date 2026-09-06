"""Helpers shared by the auth route modules.

`_user_out` is the single shape a user is serialised in; keep it in one place so
copies cannot drift. `_user_from_mfa_token` lives here rather than in
`session.py` because the enrolment and login routes both resolve the same token.
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

    The DB holds a storage key; the client needs a URL, so it is resolved at
    response time via the storage backend (as branding does for its logo). No
    avatar => avatar_url None. The security-posture fields map straight off the
    model.
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
    """The address recorded against a session, resolved the way the rate limiter
    resolves it.

    Do not read `X-Forwarded-For` directly: a request reaching the app without
    going through the proxy can set it to anything, which turns a security-facing
    display into a field the attacker fills in. `client_ip` trusts the header only
    from a configured proxy and takes the rightmost untrusted hop.
    """
    from ...core.client_ip import UNKNOWN, client_ip

    resolved = client_ip(request)
    return None if resolved == UNKNOWN else resolved


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


