"""Auth dependencies: resolve the caller and enforce PERMISSIONS (not role names).

Two credential types:
  - Bearer JWT  (human users, from /auth/login)     → get_current_user
  - X-API-Key   (machines: mobile app, integrations) → get_api_key

Access control is permission-based: ``require_permission("user.manage")``. A user's
permissions come from their (dynamic) role, loaded fresh each request.
"""

from __future__ import annotations

import uuid

import jwt
from fastapi import Depends, Header
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.errors import ForbiddenError, UnauthorizedError
from ..db.base import get_db
from .models import ApiKey, User
from .security import decode_token, hash_api_key

_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    if cred is None:
        raise UnauthorizedError("missing bearer token")
    try:
        payload = decode_token(cred.credentials)
    except jwt.PyJWTError:
        raise UnauthorizedError("invalid or expired token")
    if payload.get("type") != "access":
        raise UnauthorizedError("not an access token")
    user = await db.get(User, uuid.UUID(payload["sub"]))  # role selectin-loaded
    if user is None or not user.is_active:
        raise UnauthorizedError("user not found or inactive")
    return user


async def get_current_sid(
    cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str | None:
    """Return the session id (``sid``) claim from the caller's access token, or None.

    Lets an endpoint highlight which listed session is the one making the request.
    Never raises — a missing/legacy token (no sid) simply yields None.
    """
    if cred is None:
        return None
    try:
        return decode_token(cred.credentials).get("sid")
    except jwt.PyJWTError:
        return None


def require_permission(*permissions: str):
    """Dependency factory: caller's role must grant ALL of these permissions."""

    async def _dep(user: User = Depends(get_current_user)) -> User:
        missing = [p for p in permissions if not user.role.grants(p)]
        if missing:
            raise ForbiddenError(f"missing permission(s): {', '.join(missing)}")
        return user

    return _dep


def require_service_permission(*permissions: str):
    """Like ``require_permission``, but also accepts a SERVICE token.

    Every other satellite on this platform authorises locally by VERIFYING the
    core-minted JWT with the shared secret — there is no user row behind a
    background caller (`vision`'s `mint_service_token` is the worked example: a
    superadmin token with a fixed system `sub`). Core itself has always required a
    real `users` row, which is right for an operator surface and wrong for a
    service-to-service one: the reading-writer registering its dataset permissions
    has no user to be.

    So: a token that carries `is_superadmin` (or the permission itself) in its
    CLAIMS is accepted without a user lookup. The signature is the authority —
    minting one already requires the platform secret. A normal operator bearer
    still goes down the user path and is checked against their role.
    """

    async def _dep(
        cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
        db: AsyncSession = Depends(get_db),
    ) -> User | None:
        if cred is None:
            raise UnauthorizedError("missing bearer token")
        try:
            payload = decode_token(cred.credentials)
        except jwt.PyJWTError:
            raise UnauthorizedError("invalid or expired token")
        if payload.get("type") != "access":
            raise UnauthorizedError("not an access token")
        claims = payload.get("permissions") or []
        if payload.get("is_superadmin") or "*" in claims:
            return None
        user = await db.get(User, uuid.UUID(payload["sub"]))
        if user is None or not user.is_active:
            # Fall back to the claims themselves for a service principal that has
            # been granted the key explicitly rather than as a superadmin.
            if all(p in claims for p in permissions):
                return None
            raise UnauthorizedError("user not found or inactive")
        missing = [p for p in permissions if not user.role.grants(p)]
        if missing:
            raise ForbiddenError(f"missing permission(s): {', '.join(missing)}")
        return user

    return _dep


def user_has(user: User, permission: str) -> bool:
    return user.role.grants(permission)


async def get_api_key(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    db: AsyncSession = Depends(get_db),
) -> ApiKey:
    """Authenticate a machine caller via X-API-Key (role selectin-loaded)."""
    if not x_api_key:
        raise UnauthorizedError("missing X-API-Key")
    prefix = x_api_key[:11]
    result = await db.execute(
        select(ApiKey).where(ApiKey.prefix == prefix, ApiKey.is_active.is_(True))
    )
    key = result.scalar_one_or_none()
    if key is None or key.key_hash != hash_api_key(x_api_key):
        raise UnauthorizedError("invalid API key")
    return key
