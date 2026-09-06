"""Local JWT authorization + tenant scoping for satellite services.

Core is the only token issuer; every other service validates the token locally
(same HS256 secret VE_JWT_SECRET, same claims), so authorizing a request needs no
round-trip and no control DB.

Claims consumed (minted by core's ``create_access_token``):
    sub           user id (uuid str)
    type          "access"
    tenant_id     tenant uuid str, or null for platform super-admins
    is_superadmin bool
    permissions   list[str] effective permission keys ("*" for Administrator)
    role_id       caller's role uuid str, or null (e.g. super-admins with no role)

Usage in a service route:

    from kernel.auth import get_principal, require_permission, get_scope

    @router.get("/things")
    async def list_things(scope: Scope = Depends(get_scope)): ...

    @router.post("/things", dependencies=[Depends(require_permission("thing.create"))])
    async def create_thing(principal: Principal = Depends(get_principal)): ...

Unlike core, which re-reads the live user row each request, these services trust
the claims: a permission or tenant change takes effect on the next token refresh.
That is the deliberate cost of the DB-free path.
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
    # Opaque core subject id, not uuid-parsed. Lets us resolve role-subject ACL
    # grants statelessly. None for a role-less user or a token predating the claim.
    role_id: str | None = None
    # Tenant entitlements from core; empty for super-admins, who bypass.
    # features is {module_key: bool}, limits is {resource: number}.
    # license_state is "active" | "grace" | "expired"; a missing claim means
    # "active" so a rollout can't lock everyone out.
    features: dict = field(default_factory=dict)
    limits: dict = field(default_factory=dict)
    license_state: str = "active"
    tenant_status: str = "active"  # "active" | "suspended"
    # Site access scope: opaque core "site" subject ids. Empty means all sites in
    # the tenant. Super-admins ignore it.
    site_ids: list[str] = field(default_factory=list)

    def site_scoped(self) -> bool:
        """True when the caller is confined to a subset of sites, so the caller
        should apply a ``site_id IN site_ids`` restriction."""
        return not self.is_superadmin and bool(self.site_ids)

    def grants(self, permission: str) -> bool:
        return (
            self.is_superadmin
            or WILDCARD in self.permissions
            or permission in self.permissions
        )

    def subjects(self) -> list[str]:
        """Core subject ids this caller matches, for ACL resolution: always
        "user:<uuid>", plus "role:<uuid>" when the token carries a role_id."""
        subs = [f"user:{self.user_id}"]
        if self.role_id:
            subs.append(f"role:{self.role_id}")
        return subs

    def feature_enabled(self, key: str) -> bool:
        """Whether the tenant has module ``key`` enabled. Super-admin: always."""
        return self.is_superadmin or bool(self.features.get(key))

    def limit(self, name: str, default=None):
        """A tenant quota value. Super-admin: ``default``, i.e. unlimited."""
        return default if self.is_superadmin else self.limits.get(name, default)

    @property
    def license_expired(self) -> bool:
        """True past the grace window. Super-admin: never."""
        return not self.is_superadmin and self.license_state == "expired"

    @property
    def tenant_suspended(self) -> bool:
        """True when the tenant is suspended. Super-admin: never."""
        return not self.is_superadmin and self.tenant_status == "suspended"


def verify_token(token: str) -> Principal:
    """Decode and verify an access token (HS256, VE_JWT_SECRET) into a Principal.

    Raises UnauthorizedError on any signature, expiry or type problem.
    """
    try:
        payload = jwt.decode(
            token,
            get_settings().jwt_secret,
            algorithms=["HS256"],
            options={"verify_aud": False},  # aud is core's admin realm's business
        )
    except jwt.PyJWTError:
        raise UnauthorizedError("invalid or expired token")
    if payload.get("type") != "access":
        raise UnauthorizedError("not an access token")
    sub = payload.get("sub")
    if not sub:
        raise UnauthorizedError("token missing subject")
    tid = payload.get("tenant_id")
    # Optional and opaque; an older token just omits it.
    role_id = payload.get("role_id")
    return Principal(
        user_id=uuid.UUID(str(sub)),
        tenant_id=uuid.UUID(str(tid)) if tid else None,
        is_superadmin=bool(payload.get("is_superadmin", False)),
        permissions=list(payload.get("permissions") or []),
        role_id=str(role_id) if role_id else None,
        features=dict(payload.get("features") or {}),
        limits=dict(payload.get("limits") or {}),
        license_state=str(payload.get("license_state") or "active"),
        tenant_status=str(payload.get("tenant_status") or "active"),
        site_ids=[str(s) for s in (payload.get("site_ids") or [])],
    )


async def get_principal(
    cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
    x_tenant_id: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> Principal:
    """FastAPI dependency: the authenticated caller (Bearer JWT).

    If the gateway injected an ``X-Tenant-Id``, it must match the JWT's tenant
    claim; a mismatch means header tampering. The JWT stays the authority, the
    header is only a cross-check, and a request without one is unaffected.
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

    Gate a whole router behind its module:

        app.include_router(r, dependencies=[Depends(require_feature("vms"))])

    Super-admins bypass; a tenant without the module gets 403 FEATURE_DISABLED.
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
    """Dependency: block a suspended tenant (403 TENANT_SUSPENDED) or one whose
    license is past grace (403 LICENSE_EXPIRED). ``grace`` itself is allowed.

    Super-admins bypass. Core blocks both at login; this closes the window where a
    token minted before the change keeps working. Apply alongside
    ``require_feature`` on a service's protected routers.
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


# The gate covers suspension too now, but services wired it under the old name.
require_active_license = require_tenant_access


def enforce_limit(principal: Principal, resource: str, current: int) -> None:
    """Raise CONFLICT if one more ``resource`` would exceed the tenant quota.

    Call before a create, passing the live count from the service's own DB:

        enforce_limit(principal, "max_cameras", await count_cameras(scope))

    A missing or negative limit means unlimited, as does super-admin.
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


def owns(obj: Any, scope: Scope, *, allow_shared: bool = True) -> bool:
    """Whether ``scope`` may act on ``obj``. Super-admin owns everything; a tenant
    owns a row whose tenant_id matches.

    ``allow_shared`` decides what a NULL tenant_id means. It defaults True (NULL is
    a shared platform row) because nine services import this and flipping it would
    change all of them at once. Most tables want False: ``scoped()`` excludes NULL
    rows from listings, so a True default leaves a platform row invisible in lists
    but reachable by id — and the by-id path is also the write/delete path. The
    same predicate on core's ``users`` let a tenant-admin reset the super-admin's
    password (core 36a7798).

    Sites that want the permissive read deliberately — vision's shared platform
    media nodes — now pass ``allow_shared=True`` explicitly. A service that wants
    strict ownership passes False everywhere and pins it with a test (see access's
    ``tests/test_ownership_is_strict.py``). Once all of them do, the default flips.
    """
    if scope.is_platform:
        return True
    obj_tenant = getattr(obj, "tenant_id", None)
    if obj_tenant is None:
        return allow_shared
    return obj_tenant == scope.tenant_id


def assert_owned(
    obj: Any, scope: Scope, *, message: str = "not found", allow_shared: bool = True
) -> None:
    """Raise NotFound if ``scope`` may not access this by-id object.

    NOT_FOUND rather than FORBIDDEN so a tenant-admin can't probe for ids in
    another tenant. ``allow_shared`` is forwarded to :func:`owns` — read that
    docstring before leaving the default in a new call site.
    """
    if obj is None or not owns(obj, scope, allow_shared=allow_shared):
        raise NotFoundError(message)
