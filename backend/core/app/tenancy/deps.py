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
from ..auth.security import AUD_ADMIN, decode_token
from ..core.config import get_settings
from ..core.errors import ForbiddenError
from ..db.base import get_db

_optional_bearer = HTTPBearer(auto_error=False)


async def require_superadmin(
    user: User = Depends(get_current_user),
    cred: HTTPAuthorizationCredentials | None = Depends(_optional_bearer),
) -> User:
    """Allow only platform super-admins through (403 otherwise).

    Realm isolation (STQC): beyond ``is_superadmin`` on the live row, the token must
    carry the admin audience (``aud=neubit-admin``) — a tenant-context token can never
    reach the cross-tenant admin API even if it somehow carried is_superadmin. The
    audience is stamped at mint time from the user, so a genuine super-admin login
    always satisfies it.

    Optional hardening: when ``VE_REQUIRE_SUPERADMIN_2FA`` is on, a super-admin must
    have TOTP 2FA enrolled — otherwise they get 403 SUPERADMIN_2FA_REQUIRED and must
    first enrol via ``/auth/me/2fa/*``. Off by default so the very first super-admin
    can bootstrap their 2FA before the flag is turned on.
    """
    if not user.is_superadmin:
        raise ForbiddenError("super-admin privileges required")
    # Enforce the admin audience. Tokens minted before this rollout carry no aud →
    # treated as admin-realm for a genuine super-admin (fail-open on the claim only,
    # never on is_superadmin) so a live super-admin isn't locked out mid-session.
    if cred is not None:
        try:
            aud = decode_token(cred.credentials).get("aud")
        except jwt.PyJWTError:
            aud = None
        if aud is not None and aud != AUD_ADMIN:
            raise ForbiddenError("wrong token realm for the admin API", code="WRONG_REALM")
    if get_settings().require_superadmin_2fa and not getattr(user, "totp_enabled", False):
        raise ForbiddenError(
            "2FA is required for super-admins — enrol via /auth/me/2fa before continuing",
            code="SUPERADMIN_2FA_REQUIRED",
        )
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
