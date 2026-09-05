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

``scoped`` (the list side) and ``owns`` (the by-id side) MUST agree about what a
NULL ``tenant_id`` means, or a row is invisible in a listing and fetchable by id.
They now both mean the same thing: NULL is a tenancy like any other, owned only by
a caller whose own tenant_id is NULL. ``owns`` carries the long version of why.
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

    Super-admin owns everything. Everyone else owns a row iff its ``tenant_id``
    equals theirs — **NULL included**: a NULL row is owned only by a caller whose
    own tenant_id is NULL.

    This is the same predicate ``scoped()`` applies, and that is the point. It used
    to return True for every NULL row on the reasoning that NULL means "shared
    platform default, readable by all". That reasoning is sound for the config
    singletons and wrong for everything else, and this one predicate was answering
    for both:

      * ``users`` — a NULL tenant_id is not a shared default, it is the PLATFORM
        SUPER-ADMIN (see tenancy/models.py). Any tenant-admin holding ``user.read``
        could fetch the super-admin row by id, and with ``user.manage`` reset its
        password through ``update_user`` — a tenant-to-platform privilege escalation.
        The by-id docstring in auth/router.py claimed the opposite.
      * ``sites`` / ``floors`` / ``zones`` / ``tags`` / ``api_keys`` / ``report_jobs``
        — a platform-scoped row was writable and deletable by every tenant.

    The config surfaces that genuinely want the NULL fallback (settings, branding,
    messaging channels, email templates) never called this. They resolve the default
    explicitly in their own service, deriving the write scope from the caller rather
    than from the row — see settings/service.py and branding/service.py. They were
    already correct and are unaffected.

    So the permissive branch had no legitimate caller and one escalating one. If you
    are about to add a surface that wants "NULL is readable by all", resolve it in
    that service the way settings does; do not widen this predicate, because it is
    also what guards the mutation paths.

    Regression test: ``tests/test_tenant_isolation.py`` — a tenant-admin against the
    super-admin row, both read and write.
    """
    if scope.is_platform:
        return True
    return getattr(obj, "tenant_id", None) == scope.tenant_id


def assert_owned(obj: Any, scope: Scope, *, message: str = "not found") -> None:
    """Raise if ``scope`` may not access this by-id object.

    Uses NOT_FOUND (not FORBIDDEN) on purpose: a tenant-admin must not be able to
    tell whether an id exists in another tenant. Super-admin always passes.
    """
    if obj is None or not owns(obj, scope):
        raise NotFoundError(message)
