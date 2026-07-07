"""Tenant scoping primitive — the one place row-level isolation is decided.

Every leaking surface (audit, reports, roles, api_keys, users, and the per-tenant
config singletons) routes its reads and its by-id lookups through the helpers here
so the isolation rule lives in ONE place:

  * SUPER-ADMIN  (tenant_id NULL, is_superadmin True) → sees/acts across ALL tenants
    (no filter, no ownership check).
  * TENANT-ADMIN (a tenant_id set)                    → confined to their own tenant
    (rows are filtered to their tenant_id; a by-id object from another tenant is
    treated as not-found / forbidden).

Usage:

    scope = await get_scope(user)              # a FastAPI dependency
    stmt = scoped(select(Model), Model, scope) # add the tenant filter for reads
    assert_owned(obj, scope)                   # guard a by-id fetch before use

``scoped`` and ``assert_owned`` deliberately DON'T know about super-admin-vs-tenant
beyond the Scope flag, so callers can't accidentally forget the bypass.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from fastapi import Depends
from sqlalchemy.sql import Select

from ..auth.deps import get_current_user
from ..auth.models import User
from ..core.errors import NotFoundError


@dataclass(frozen=True)
class Scope:
    """The caller's tenancy scope, resolved from their live user row."""

    tenant_id: uuid.UUID | None
    is_superadmin: bool

    @property
    def is_platform(self) -> bool:
        """True for a super-admin: no tenant filter, no ownership checks."""
        return self.is_superadmin


async def get_scope(user: User = Depends(get_current_user)) -> Scope:
    """FastAPI dependency: the caller's scope from the fresh (DB-loaded) user row.

    ``get_current_user`` already loads the live row (not just token claims), so the
    tenant_id / is_superadmin here are authoritative.
    """
    return Scope(tenant_id=user.tenant_id, is_superadmin=bool(user.is_superadmin))


def scope_of(user: User) -> Scope:
    """Build a Scope directly from a User (for services that already hold one)."""
    return Scope(tenant_id=user.tenant_id, is_superadmin=bool(user.is_superadmin))


def scoped(stmt: Select, model: Any, scope: Scope) -> Select:
    """Constrain a SELECT to the caller's tenant.

    * Super-admin → returned unchanged (sees every tenant's rows).
    * Tenant-admin → ``WHERE model.tenant_id == scope.tenant_id`` is appended.

    ``model`` must expose a ``tenant_id`` column. Only the caller's own tenant rows
    are returned — the platform-default (tenant_id NULL) rows are NOT included by
    this helper; surfaces that want the NULL fallback (the config singletons) handle
    it explicitly in their service.
    """
    if scope.is_platform:
        return stmt
    return stmt.where(model.tenant_id == scope.tenant_id)


def owns(obj: Any, scope: Scope) -> bool:
    """Whether ``scope`` may act on ``obj`` (a row with a ``tenant_id``).

    Super-admin owns everything. A tenant-admin owns a row iff its tenant_id matches
    theirs. A row with tenant_id NULL (a shared/platform-default row) is treated as
    owned by everyone for READ purposes — callers that must block a tenant-admin from
    MUTATING a shared row check that separately.
    """
    if scope.is_platform:
        return True
    obj_tenant = getattr(obj, "tenant_id", None)
    if obj_tenant is None:
        return True  # shared/system/platform-default row — visible to all tenants
    return obj_tenant == scope.tenant_id


def assert_owned(obj: Any, scope: Scope, *, message: str = "not found") -> None:
    """Raise if ``scope`` may not access this by-id object.

    Uses NOT_FOUND (not FORBIDDEN) on purpose: a tenant-admin must not be able to
    tell whether an id exists in another tenant. Super-admin always passes.
    """
    if obj is None or not owns(obj, scope):
        raise NotFoundError(message)
