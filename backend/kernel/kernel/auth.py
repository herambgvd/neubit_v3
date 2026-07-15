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
from fastapi import Depends, Header
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.sql import Select

from .config import get_settings
from .errors import ConflictError, ForbiddenError, NotFoundError, UnauthorizedError

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
    # Tenant entitlements baked into the token by core (empty for super-admins, who
    # bypass). ``features`` is {module_key: bool}; ``limits`` is {resource: number}.
    # ``license_state`` is "active" | "grace" | "expired" (super-admins/on missing
    # claim → "active", i.e. fail-open on license so a rollout never locks users out).
    features: dict = field(default_factory=dict)
    limits: dict = field(default_factory=dict)
    license_state: str = "active"
    tenant_status: str = "active"  # "active" | "suspended"

    def grants(self, permission: str) -> bool:
        return (
            self.is_superadmin
            or WILDCARD in self.permissions
            or permission in self.permissions
        )

    def feature_enabled(self, key: str) -> bool:
        """Whether the caller's tenant has module ``key`` enabled (super-admin → always)."""
        return self.is_superadmin or bool(self.features.get(key))

    def limit(self, name: str, default=None):
        """A tenant quota value (super-admin → ``default``, i.e. unlimited)."""
        return default if self.is_superadmin else self.limits.get(name, default)

    @property
    def license_expired(self) -> bool:
        """True only when the tenant's license is past its grace window (super-admin → never)."""
        return not self.is_superadmin and self.license_state == "expired"

    @property
    def tenant_suspended(self) -> bool:
        """True when the caller's tenant is suspended by a super-admin (super-admin → never)."""
        return not self.is_superadmin and self.tenant_status == "suspended"


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
        features=dict(payload.get("features") or {}),
        limits=dict(payload.get("limits") or {}),
        license_state=str(payload.get("license_state") or "active"),
        tenant_status=str(payload.get("tenant_status") or "active"),
    )


async def get_principal(
    cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
    x_tenant_id: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> Principal:
    """FastAPI dependency: the authenticated caller (Bearer JWT).

    Defense-in-depth: when the gateway's ForwardAuth injected a trusted
    ``X-Tenant-Id`` (strip-identity removes any client-supplied one first), it MUST
    match the JWT's tenant claim — a mismatch means header tampering and is rejected.
    The JWT stays the authority; the header is only an extra edge cross-check. A
    request with no such header (a direct/in-cluster call) is unaffected.
    """
    if cred is None:
        raise UnauthorizedError("missing bearer token")
    principal = verify_token(cred.credentials)
    if x_tenant_id and (
        principal.tenant_id is None or str(principal.tenant_id) != x_tenant_id
    ):
        raise UnauthorizedError("tenant header/token mismatch")
    return principal


def require_permission(*permissions: str):
    """Dependency factory: caller must be super-admin, hold '*', or grant ALL perms."""

    async def _dep(principal: Principal = Depends(get_principal)) -> Principal:
        missing = [p for p in permissions if not principal.grants(p)]
        if missing:
            raise ForbiddenError(f"missing permission(s): {', '.join(missing)}")
        return principal

    return _dep


# --- Entitlement enforcement (Phase 3) -------------------------------------
def require_feature(*keys: str):
    """Dependency factory: the caller's tenant must have ALL of ``keys`` enabled.

    Gate a whole service/router behind its module, e.g. on ``include_router``:

        app.include_router(r, dependencies=[Depends(require_feature("vms"))])

    Super-admins bypass. A tenant without the module gets 403 FEATURE_DISABLED.
    (Reads the token claim — a satellite authorises locally, no round-trip to core.)
    """

    async def _dep(principal: Principal = Depends(get_principal)) -> Principal:
        missing = [k for k in keys if not principal.feature_enabled(k)]
        if missing:
            raise ForbiddenError(
                f"the '{', '.join(missing)}' module is not enabled for this tenant",
                code="FEATURE_DISABLED",
            )
        return principal

    return _dep


def require_tenant_access():
    """Dependency: block when the caller's tenant can't operate — it is SUSPENDED by
    a super-admin, or its license is EXPIRED (past grace).

    ``grace`` is allowed (the UI warns). Suspended → 403 TENANT_SUSPENDED; expired →
    403 LICENSE_EXPIRED. Super-admins bypass. Core already blocks both at login; this
    closes the window where a token minted before the change keeps working. Apply
    alongside ``require_feature`` on a service's protected routers.
    """

    async def _dep(principal: Principal = Depends(get_principal)) -> Principal:
        if principal.tenant_suspended:
            raise ForbiddenError(
                "the tenant is suspended — contact support",
                code="TENANT_SUSPENDED",
            )
        if principal.license_expired:
            raise ForbiddenError(
                "the tenant's license has expired — renew to continue",
                code="LICENSE_EXPIRED",
            )
        return principal

    return _dep


# Back-compat alias: the gate now covers suspension too, but services wired it under
# the original name. Both resolve to the same combined tenant-access check.
require_active_license = require_tenant_access


def enforce_limit(principal: Principal, resource: str, current: int) -> None:
    """Raise CONFLICT if creating one more ``resource`` would exceed the tenant quota.

    Call before a create, passing the live count from the service's own DB:

        enforce_limit(principal, "max_cameras", await count_cameras(scope))

    A missing/negative limit means unlimited; super-admins are always unlimited.
    """
    cap = principal.limit(resource)
    if isinstance(cap, (int, float)) and cap >= 0 and current >= cap:
        raise ConflictError(
            f"{resource} quota reached ({int(cap)})",
            code="LIMIT_EXCEEDED",
        )


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
