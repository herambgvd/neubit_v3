"""The permission catalog and the roles built from it.

A role is a name plus a subset of `PERMISSIONS`. The catalog is the authority on
what is grantable: `create_role` and `update_role` REJECT a key that is not in it,
which is why a permission enforced by a satellite but missing from
`app/auth/permissions.py` cannot be granted to anyone at all — see
`tests/test_permission_catalog.py`, which walks every `require_permission` literal
in the estate and fails on one the catalog does not hold.
"""

from __future__ import annotations

import uuid

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.audit import record as audit_record
from ...core.errors import ValidationError
from ...core.pagination import Page, PageParams, page_params, paginate
from ...db.base import get_db
from ...tenancy.scope import scope_of
from ..deps import require_permission, require_service_permission
from ..models import User
from .. import dynamic_permissions
from ..permissions import CorePerm
from ..schemas import CloneRoleIn, CreateRoleIn, RoleOut, UpdateRoleIn
from ..service import AuthService

from . import admin_router


# --- permission catalog (for the role editor UI) -----------------------------
@admin_router.get("/permissions")
async def permissions(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission(CorePerm.ROLE_READ)),
) -> dict:
    """The role editor's catalog: the static keys plus the ones services
    registered at runtime (see `dynamic_permissions`). A key that is enforced but
    not listed here can only ever be held by a wildcard admin, which is not a
    usable permission model — that was the `ingest.read` bug."""
    return {"groups": await dynamic_permissions.grouped(db)}


@admin_router.post("/permissions/registrations")
async def register_permissions(
    body: dict,
    db: AsyncSession = Depends(get_db),
    _: User | None = Depends(require_service_permission(CorePerm.PERMISSION_REGISTER)),
) -> dict:
    """Publish the permission keys a satellite enforces, so a role can grant them.

    Service-to-service (a short-lived superadmin service token), idempotent, and
    additive only: a registration can never redefine a key the static catalog
    already owns. The caller today is the reading-writer
    (``app/api/permsync.py``), pushing one key per dataset registered in
    ``neubit_reporting.dashboard_datasets`` — which is what makes "registration is
    data, not code" hold all the way through to the role editor. (This named "the
    dashboard builder" until 2026-09-03; that service is retired, the registry it
    read is not, and the reading-writer owns it.)
    """
    source = str(body.get("source") or "unknown")
    perms = body.get("permissions") or []
    if not isinstance(perms, list):
        raise ValidationError("permissions must be a list")
    written = await dynamic_permissions.register(db, source=source, permissions=perms)
    return {"registered": written}


# --- roles (dynamic RBAC) ----------------------------------------------------
@admin_router.post("/roles", response_model=RoleOut, status_code=201)
async def create_role(
    data: CreateRoleIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.ROLE_MANAGE)),
):
    role = await AuthService(db).create_role(data, scope_of(actor))
    await audit_record(
        db, actor=actor, action="role.create", target_type="role",
        target_id=str(role.id), meta={"name": role.name},
    )
    return role


@admin_router.get("/roles", response_model=Page[RoleOut])
async def list_roles(
    params: PageParams = Depends(page_params),
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.ROLE_READ)),
):
    # Tenant scoping: a tenant-admin sees their own roles + shared system roles;
    # super-admins see all. The shared Administrator role stays visible to everyone.
    return await paginate(
        db, AuthService(db).roles_query(scope_of(actor)), params, item_model=RoleOut
    )


@admin_router.patch("/roles/{role_id}", response_model=RoleOut)
async def update_role(
    role_id: uuid.UUID,
    data: UpdateRoleIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.ROLE_MANAGE)),
):
    role = await AuthService(db).update_role(role_id, data, scope_of(actor))
    await audit_record(
        db, actor=actor, action="role.update", target_type="role",
        target_id=str(role_id), meta={"name": role.name},
    )
    return role


@admin_router.delete("/roles/{role_id}", status_code=204)
async def delete_role(
    role_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.ROLE_MANAGE)),
) -> None:
    await AuthService(db).delete_role(role_id, scope_of(actor))
    await audit_record(
        db, actor=actor, action="role.delete", target_type="role", target_id=str(role_id),
    )


@admin_router.post("/roles/{role_id}/clone", response_model=RoleOut, status_code=201)
async def clone_role(
    role_id: uuid.UUID,
    data: CloneRoleIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.ROLE_MANAGE)),
) -> RoleOut:
    """Copy a role's permissions + description under a new name."""
    role = await AuthService(db).clone_role(role_id, data.name, scope_of(actor))
    await audit_record(
        db, actor=actor, action="role.clone", target_type="role",
        target_id=str(role.id), meta={"name": role.name, "cloned_from": str(role_id)},
    )
    return role


