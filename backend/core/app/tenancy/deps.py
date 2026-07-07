"""Tenancy dependencies — the super-admin gate.

``require_superadmin`` is a FastAPI dependency that 403s unless the caller is a
platform super-admin (User.is_superadmin True). It builds on the existing
``get_current_user`` (bearer JWT → live User row), so the check is authoritative:
it reads the current DB row, not just a token claim.
"""

from __future__ import annotations

import uuid

import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.deps import get_current_user
from ..auth.models import User
from ..auth.security import decode_token
from ..core.errors import ForbiddenError
from ..db.base import get_db

_optional_bearer = HTTPBearer(auto_error=False)


async def require_superadmin(user: User = Depends(get_current_user)) -> User:
    """Allow only platform super-admins through (403 otherwise)."""
    if not user.is_superadmin:
        raise ForbiddenError("super-admin privileges required")
    return user


async def optional_tenant_id(
    cred: HTTPAuthorizationCredentials | None = Depends(_optional_bearer),
    db: AsyncSession = Depends(get_db),
) -> uuid.UUID | None:
    """Resolve the caller's tenant_id if a VALID bearer token is present, else None.

    Used by PUBLIC endpoints (GET /settings/public, GET /branding) so a signed-in
    tenant user gets THEIR tenant's values while an unauthenticated/invalid-token
    caller (the login page) still gets the platform default. Never raises — any
    problem (no header, bad/expired token, unknown or inactive user, super-admin)
    resolves to None → the platform default.
    """
    if cred is None:
        return None
    try:
        payload = decode_token(cred.credentials)
        if payload.get("type") != "access":
            return None
        user = await db.get(User, uuid.UUID(payload["sub"]))
    except (jwt.PyJWTError, ValueError, KeyError):
        return None
    if user is None or not user.is_active:
        return None
    return user.tenant_id
