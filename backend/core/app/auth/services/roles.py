"""Roles: the named bundles of permission keys an admin assigns.

Two rules here are enforced rather than documented. A key not in `PERMISSIONS` is
REJECTED on create and update, which is what makes the catalog authoritative — and
what made two whole products unreachable when their keys were missing from it. And
a role name is unique per TENANT since 0025, not across the platform: a global
unique let the first tenant to use "Analyst" take the name from everyone else and
answered CONFLICT about a row the caller could not see.
"""


from __future__ import annotations


import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.errors import ConflictError, NotFoundError, ValidationError
from ...tenancy.scope import Scope
from ..models import Role, User
from .. import dynamic_permissions
from ..permissions import WILDCARD
from ..schemas import CreateRoleIn, UpdateRoleIn

class RolesMixin:
    """Part of :class:`AuthService`; see `services/__init__.py`."""

    db: AsyncSession

    # --- roles (dynamic RBAC) ---------------------------------------------
    async def create_role(self, data: CreateRoleIn, scope: Scope | None = None) -> Role:
        # Static catalog PLUS whatever satellites registered — a per-dataset
        # dashboard permission is grantable exactly like a built-in one.
        unknown = await dynamic_permissions.unknown(self.db, data.permissions)
        if unknown:
            raise ValidationError(f"unknown permissions: {unknown}")
        if WILDCARD in data.permissions:
            raise ValidationError("wildcard '*' is reserved for the system Administrator role")
        # Unique per (tenant_id, name) since 0025 — two tenants may both have an
        # "Analyst". Within the caller's own view the name must still be
        # unambiguous, so this also refuses a name already held by a SHARED system
        # role: `roles_query` lists own-tenant and shared roles together, and two
        # entries reading "Viewer" is a role picker an operator cannot use.
        if await self._role_by_name(data.name, scope):
            raise ConflictError("a role with this name already exists")
        # A tenant-admin's roles are stamped with their tenant; a super-admin (no
        # scope, or a platform scope) creates a shared platform role (tenant_id NULL).
        tenant_id = None if scope is None or scope.is_platform else scope.tenant_id
        role = Role(
            name=data.name, description=data.description,
            permissions=list(data.permissions), tenant_id=tenant_id,
        )
        self.db.add(role)
        await self.db.commit()
        await self.db.refresh(role)
        return role

    async def update_role(self, role_id: uuid.UUID, data: UpdateRoleIn,
                          scope: Scope | None = None) -> Role:
        role = await self.db.get(Role, role_id)
        if role is None:
            raise NotFoundError("role not found")
        # Tenant isolation: a tenant-admin may only touch their own tenant's roles.
        # Shared system roles (tenant_id NULL) are read-only to tenant-admins anyway
        # (blocked by is_system below), and invisible-as-editable to other tenants.
        if scope is not None and not scope.is_platform and role.tenant_id != scope.tenant_id:
            raise NotFoundError("role not found")
        if role.is_system:
            raise ValidationError("the system Administrator role cannot be modified")
        if data.permissions is not None:
            unknown = await dynamic_permissions.unknown(self.db, data.permissions)
            if unknown:
                raise ValidationError(f"unknown permissions: {unknown}")
            if WILDCARD in data.permissions:
                raise ValidationError("wildcard '*' is reserved for the system role")
            role.permissions = list(data.permissions)
        if data.name is not None:
            role.name = data.name
        if data.description is not None:
            role.description = data.description
        await self.db.commit()
        await self.db.refresh(role)
        return role

    async def delete_role(self, role_id: uuid.UUID, scope: Scope | None = None) -> None:
        role = await self.db.get(Role, role_id)
        if role is None:
            raise NotFoundError("role not found")
        # A tenant-admin may only delete their own tenant's roles (a shared system
        # role has tenant_id NULL and is blocked by is_system regardless).
        if scope is not None and not scope.is_platform and role.tenant_id != scope.tenant_id:
            raise NotFoundError("role not found")
        if role.is_system:
            raise ValidationError("the system Administrator role cannot be deleted")
        in_use = await self.db.scalar(
            select(func.count()).select_from(User).where(User.role_id == role_id)
        )
        if in_use:
            raise ConflictError("role is assigned to users; reassign them first")
        await self.db.delete(role)
        await self.db.commit()

    def roles_query(self, scope: Scope | None = None):
        """Roles visible to the caller: their own tenant's roles + shared system
        roles (tenant_id NULL). Super-admins see every role."""
        stmt = select(Role).order_by(Role.name)
        if scope is not None and not scope.is_platform:
            # Own-tenant roles OR shared platform/system roles (NULL tenant).
            stmt = stmt.where(
                (Role.tenant_id == scope.tenant_id) | (Role.tenant_id.is_(None))
            )
        return stmt

    async def _role_by_name(self, name: str, scope: Scope | None = None) -> Role | None:
        """A role of this name the caller could actually be given.

        Scoped to the caller's own tenant plus the shared system roles, the same
        set `roles_query` lists. Unscoped it searched the whole platform, which was
        the reporting half of the global-unique-name problem 0025 removed: a tenant
        was told a name was taken by a row in a tenant it cannot see.
        """
        stmt = select(Role).where(Role.name == name)
        if scope is not None and not scope.is_platform:
            stmt = stmt.where(
                (Role.tenant_id == scope.tenant_id) | (Role.tenant_id.is_(None))
            )
        return (await self.db.execute(stmt.limit(1))).scalars().first()

    async def _require_role(self, role_id: uuid.UUID, scope: Scope | None = None) -> Role:
        role = await self.db.get(Role, role_id)
        if role is None:
            raise ValidationError("role_id does not reference an existing role")
        # A tenant-admin may only assign a role they can see: their own tenant's
        # roles or a shared system role (tenant_id NULL). Assigning another tenant's
        # role would leak/borrow its permissions, so it's rejected as invalid.
        if scope is not None and not scope.is_platform:
            if role.tenant_id is not None and role.tenant_id != scope.tenant_id:
                raise ValidationError("role_id does not reference an existing role")
        return role

    # --- roles: clone -----------------------------------------------------
    async def clone_role(self, role_id: uuid.UUID, name: str, scope: Scope | None = None) -> Role:
        """Copy a role's permissions + description under a new name (own tenant)."""
        src = await self.db.get(Role, role_id)
        if src is None:
            raise NotFoundError("role not found")
        if scope is not None and not scope.is_platform and src.tenant_id not in (None, scope.tenant_id):
            raise NotFoundError("role not found")
        # Same conflict rule as create_role: unique within the caller's own view.
        if await self._role_by_name(name, scope):
            raise ConflictError("a role with this name already exists")
        tenant_id = None if scope is None or scope.is_platform else scope.tenant_id
        # Never carry the wildcard into a custom clone (reserved for the system role).
        perms = [p for p in (src.permissions or []) if p != WILDCARD]
        role = Role(
            name=name,
            description=(src.description or None),
            permissions=perms,
            tenant_id=tenant_id,
        )
        self.db.add(role)
        await self.db.commit()
        await self.db.refresh(role)
        return role

