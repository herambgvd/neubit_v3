"""Local JWT authorization + tenant scoping for satellite services.

The platform core is the ONLY token issuer (login / refresh). Every other service
validates the core-minted access token LOCALLY (no round-trip to core): same
HS256 secret (VE_JWT_SECRET), same claims. The core now bakes an effective
``permissions`` list into the access token, so a service can authorize a request
without querying the control DB.

Claims consumed (minted by core's ``create_access_token``):
    sub           user id (uuid str)
    type          "access"
    tenant_id     tenant uuid str, or null for platform super-admins
    is_superadmin bool
    permissions   list[str] effective permission keys ("*" for Administrator)

Usage in a service route:

    from kernel.auth import get_principal, require_permission, get_scope

    @router.get("/things")
    async def list_things(scope: Scope = Depends(get_scope)): ...

    @router.post("/things", dependencies=[Depends(require_permission("thing.create"))])
    async def create_thing(principal: Principal = Depends(get_principal)): ...

Authoritative note: unlike core (which re-reads the live user row each request),
these services trust the token claims — a permission/tenant change takes effect
when the short-lived access token is refreshed. That's the deliberate trade for a
DB-free authorization path in the satellite services.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.sql import Select

from .config import get_settings
from .errors import ForbiddenError, NotFoundError, UnauthorizedError

WILDCARD = "*"

_bearer = HTTPBearer(auto_error=False)


# --- Principal (who the caller is, from the JWT) ---------------------------
@dataclass(frozen=True)
class Principal:
    """The authenticated caller, decoded from the access token."""

    user_id: uuid.UUID
    tenant_id: uuid.UUID | None
    is_superadmin: bool
    permissions: list[str] = field(default_factory=list)

    def grants(self, permission: str) -> bool:
        return (
            self.is_superadmin
            or WILDCARD in self.permissions
            or permission in self.permissions
        )


def verify_token(token: str) -> Principal:
    """Decode + verify the access token (HS256, VE_JWT_SECRET) → Principal.

    Raises UnauthorizedError on any signature/expiry/type problem.
    """
    try:
        payload = jwt.decode(token, get_settings().jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise UnauthorizedError("invalid or expired token")
    if payload.get("type") != "access":
        raise UnauthorizedError("not an access token")
    sub = payload.get("sub")
    if not sub:
        raise UnauthorizedError("token missing subject")
    tid = payload.get("tenant_id")
    return Principal(
        user_id=uuid.UUID(str(sub)),
        tenant_id=uuid.UUID(str(tid)) if tid else None,
        is_superadmin=bool(payload.get("is_superadmin", False)),
        permissions=list(payload.get("permissions") or []),
    )


async def get_principal(
    cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> Principal:
    """FastAPI dependency: the authenticated caller (Bearer JWT)."""
    if cred is None:
        raise UnauthorizedError("missing bearer token")
    return verify_token(cred.credentials)


def require_permission(*permissions: str):
    """Dependency factory: caller must be super-admin, hold '*', or grant ALL perms."""

    async def _dep(principal: Principal = Depends(get_principal)) -> Principal:
        missing = [p for p in permissions if not principal.grants(p)]
        if missing:
            raise ForbiddenError(f"missing permission(s): {', '.join(missing)}")
        return principal

    return _dep


# --- Tenant scope (copied from core tenancy/scope.py semantics) ------------
@dataclass(frozen=True)
class Scope:
    """The caller's tenancy scope, resolved from the JWT Principal."""

    tenant_id: uuid.UUID | None
    is_superadmin: bool

    @property
    def is_platform(self) -> bool:
        """True for a super-admin: no tenant filter, no ownership checks."""
        return self.is_superadmin


async def get_scope(principal: Principal = Depends(get_principal)) -> Scope:
    """FastAPI dependency: the caller's tenancy scope from the token claims."""
    return Scope(tenant_id=principal.tenant_id, is_superadmin=principal.is_superadmin)


def scope_of(principal: Principal) -> Scope:
    """Build a Scope directly from a Principal (for services that already hold one)."""
    return Scope(tenant_id=principal.tenant_id, is_superadmin=principal.is_superadmin)


def scoped(stmt: Select, model: Any, scope: Scope) -> Select:
    """Constrain a SELECT to the caller's tenant.

    * Super-admin → returned unchanged (sees every tenant's rows).
    * Tenant-admin → ``WHERE model.tenant_id == scope.tenant_id`` is appended.
    """
    if scope.is_platform:
        return stmt
    return stmt.where(model.tenant_id == scope.tenant_id)


def owns(obj: Any, scope: Scope) -> bool:
    """Whether ``scope`` may act on ``obj`` (a row with a ``tenant_id``).

    Super-admin owns everything. A tenant-admin owns a row iff its tenant_id
    matches theirs. A row with tenant_id NULL (shared/platform-default) is owned
    by everyone for READ purposes.
    """
    if scope.is_platform:
        return True
    obj_tenant = getattr(obj, "tenant_id", None)
    if obj_tenant is None:
        return True
    return obj_tenant == scope.tenant_id


def assert_owned(obj: Any, scope: Scope, *, message: str = "not found") -> None:
    """Raise NotFound if ``scope`` may not access this by-id object.

    NOT_FOUND (not FORBIDDEN) on purpose: a tenant-admin must not be able to tell
    whether an id exists in another tenant. Super-admin always passes.
    """
    if obj is None or not owns(obj, scope):
        raise NotFoundError(message)
