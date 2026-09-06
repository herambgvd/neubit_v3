"""Tenant scoping primitive — the one place row-level isolation is decided.

Every tenant-scoped surface routes its reads and its by-id lookups through these
helpers. Super-admin (tenant_id NULL, is_superadmin) sees and acts across all
tenants; anyone else is confined to their own tenant_id.

    scope = await get_scope(user)              # a FastAPI dependency
    stmt = scoped(select(Model), Model, scope) # add the tenant filter for reads
    assert_owned(obj, scope)                   # guard a by-id fetch before use

``scoped`` (the list side) and ``owns`` (the by-id side) must agree about what a
NULL ``tenant_id`` means, or a row is invisible in a listing and fetchable by id.
Both treat NULL as a tenancy like any other.
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
    """FastAPI dependency: the caller's scope, from the live DB user row.

    ``get_current_user`` loads the row rather than trusting token claims, so these
    values are authoritative.
    """
    return Scope(tenant_id=user.tenant_id, is_superadmin=bool(user.is_superadmin))


def scope_of(user: User) -> Scope:
    """Build a Scope directly from a User (for services that already hold one)."""
    return Scope(tenant_id=user.tenant_id, is_superadmin=bool(user.is_superadmin))


def scoped(stmt: Select, model: Any, scope: Scope) -> Select:
    """Constrain a SELECT to the caller's tenant.

    Super-admin gets the statement unchanged; anyone else gets
    ``WHERE model.tenant_id == scope.tenant_id``. ``model`` must have a
    ``tenant_id`` column. Platform-default (NULL) rows are not included — surfaces
    that want that fallback resolve it in their own service.
    """
    if scope.is_platform:
        return stmt
    return stmt.where(model.tenant_id == scope.tenant_id)


def owns(obj: Any, scope: Scope) -> bool:
    """Whether ``scope`` may act on ``obj`` (a row with a ``tenant_id``).

    Super-admin owns everything; everyone else owns a row iff its ``tenant_id``
    equals theirs, NULL included. A NULL ``users`` row is the platform super-admin,
    not a shared default, so treating NULL as readable-by-all would let any
    tenant-admin fetch and reset it.

    Do not widen this to "NULL is readable by all" — it also guards the mutation
    paths. Surfaces that want a platform-default fallback (settings, branding)
    resolve it in their own service instead. Covered by tests/test_tenant_isolation.py.
    """
    if scope.is_platform:
        return True
    return getattr(obj, "tenant_id", None) == scope.tenant_id


def assert_owned(obj: Any, scope: Scope, *, message: str = "not found") -> None:
    """Raise if ``scope`` may not access this by-id object.

    NOT_FOUND rather than FORBIDDEN on purpose: a tenant-admin must not learn
    whether an id exists in another tenant.
    """
    if obj is None or not owns(obj, scope):
        raise NotFoundError(message)
