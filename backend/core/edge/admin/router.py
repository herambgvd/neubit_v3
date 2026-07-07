"""Super-admin API — tenant management. Full path: ``{api_prefix}/admin/tenants``.

Every endpoint is gated by ``require_superadmin`` (403 for anyone else). Actions are
audit-logged like the rest of the platform. Covers: tenant CRUD, license/entitlements,
suspend/reactivate, usage, per-tenant admin users, and impersonation.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..auth.security import create_access_token
from ..core.audit import record as audit_record
from ..db.base import get_db
from ..tenancy.deps import require_superadmin
from ..tenancy.models import effective_license_state
from ..tenancy.service import TenantService
from .schemas import (
    CreateTenantIn,
    ImpersonateOut,
    LicenseIn,
    PagedTenantsOut,
    TenantAdminIn,
    TenantAdminOut,
    TenantOut,
    TenantUsageOut,
    TenantWithCountOut,
    UpdateTenantIn,
)

# Mounted by create_app under the app's api_prefix, so the full path is
# {api_prefix}/admin/... (e.g. /api/v1/admin/tenants).
router = APIRouter(prefix="/admin", tags=["admin"])


def _detail(tenant, users: int) -> TenantWithCountOut:
    """Serialize a tenant with its derived license_state + user count."""
    item = TenantWithCountOut.model_validate(tenant)
    item.license_state = effective_license_state(tenant)
    item.users = users
    return item


@router.post("/tenants", response_model=TenantOut, status_code=201)
async def create_tenant(
    data: CreateTenantIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> TenantOut:
    """Create a tenant + its tenant-admin user (Administrator role)."""
    svc = TenantService(db)
    tenant = await svc.create_tenant(data.name, data.admin_email, data.admin_password)
    await audit_record(
        db, actor=actor, action="tenant.create", target_type="tenant",
        target_id=str(tenant.id), meta={"name": tenant.name, "slug": tenant.slug},
    )
    out = TenantOut.model_validate(tenant)
    out.license_state = effective_license_state(tenant)
    return out


@router.get("/tenants", response_model=PagedTenantsOut)
async def list_tenants(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_superadmin),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    q: str | None = Query(None),
    status: str | None = Query(None),
) -> PagedTenantsOut:
    """List tenants with search (name/slug), status filter, and pagination."""
    svc = TenantService(db)
    rows, total = await svc.paged_tenants(page=page, page_size=page_size, q=q, status=status)
    items = [_detail(t, await svc.user_count(t.id)) for t in rows]
    return PagedTenantsOut(items=items, total=total, page=page, page_size=page_size)


@router.get("/tenants/{tenant_id}", response_model=TenantWithCountOut)
async def get_tenant(
    tenant_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_superadmin),
) -> TenantWithCountOut:
    svc = TenantService(db)
    tenant = await svc.get_tenant(tenant_id)
    return _detail(tenant, await svc.user_count(tenant.id))


@router.patch("/tenants/{tenant_id}", response_model=TenantOut)
async def update_tenant(
    tenant_id: uuid.UUID,
    data: UpdateTenantIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> TenantOut:
    tenant = await TenantService(db).update_tenant(
        tenant_id,
        status=data.status,
        plan=data.plan,
        features=data.features,
        limits=data.limits,
    )
    await audit_record(
        db, actor=actor, action="tenant.update", target_type="tenant",
        target_id=str(tenant_id), meta=data.model_dump(exclude_none=True),
    )
    out = TenantOut.model_validate(tenant)
    out.license_state = effective_license_state(tenant)
    return out


@router.post("/tenants/{tenant_id}/suspend", response_model=TenantOut)
async def suspend_tenant(
    tenant_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> TenantOut:
    """Suspend a tenant — its users are denied login until reactivated."""
    tenant = await TenantService(db).set_status(tenant_id, "suspended")
    await audit_record(
        db, actor=actor, action="tenant.suspend", target_type="tenant", target_id=str(tenant_id),
    )
    out = TenantOut.model_validate(tenant)
    out.license_state = effective_license_state(tenant)
    return out


@router.post("/tenants/{tenant_id}/reactivate", response_model=TenantOut)
async def reactivate_tenant(
    tenant_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> TenantOut:
    """Reactivate a suspended tenant."""
    tenant = await TenantService(db).set_status(tenant_id, "active")
    await audit_record(
        db, actor=actor, action="tenant.reactivate", target_type="tenant", target_id=str(tenant_id),
    )
    out = TenantOut.model_validate(tenant)
    out.license_state = effective_license_state(tenant)
    return out


@router.put("/tenants/{tenant_id}/license", response_model=TenantOut)
async def set_license(
    tenant_id: uuid.UUID,
    data: LicenseIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> TenantOut:
    """Apply a tenant's license: tier (plan) + features + limits + expiry/grace."""
    # mode="json" so datetimes become ISO strings (audit meta is a JSON column).
    fields = data.model_dump(mode="json", exclude_unset=True)
    tenant = await TenantService(db).set_license(
        tenant_id,
        plan=data.plan,
        features=data.features,
        limits=data.limits,
        license_expires_at=data.license_expires_at,
        grace_days=data.grace_days,
        clear_expiry=("license_expires_at" in fields and data.license_expires_at is None),
    )
    await audit_record(
        db, actor=actor, action="tenant.license", target_type="tenant",
        target_id=str(tenant_id), meta=fields,
    )
    out = TenantOut.model_validate(tenant)
    out.license_state = effective_license_state(tenant)
    return out


@router.get("/tenants/{tenant_id}/usage", response_model=TenantUsageOut)
async def tenant_usage(
    tenant_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_superadmin),
) -> TenantUsageOut:
    return TenantUsageOut(**await TenantService(db).usage(tenant_id))


@router.get("/tenants/{tenant_id}/admins", response_model=list[TenantAdminOut])
async def list_tenant_admins(
    tenant_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_superadmin),
) -> list[TenantAdminOut]:
    users = await TenantService(db).list_tenant_users(tenant_id)
    return [TenantAdminOut.model_validate(u) for u in users]


@router.post("/tenants/{tenant_id}/admins", response_model=TenantAdminOut, status_code=201)
async def create_tenant_admin(
    tenant_id: uuid.UUID,
    data: TenantAdminIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> TenantAdminOut:
    user = await TenantService(db).create_tenant_admin(
        tenant_id, data.email, data.password, data.full_name
    )
    await audit_record(
        db, actor=actor, action="tenant.admin.create", target_type="user",
        target_id=str(user.id), meta={"tenant_id": str(tenant_id), "email": data.email},
    )
    return TenantAdminOut.model_validate(user)


@router.delete("/tenants/{tenant_id}/admins/{user_id}", status_code=204)
async def delete_tenant_admin(
    tenant_id: uuid.UUID,
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> None:
    user = await TenantService(db).delete_tenant_admin(tenant_id, user_id)
    await audit_record(
        db, actor=actor, action="tenant.admin.delete", target_type="user",
        target_id=str(user_id), meta={"tenant_id": str(tenant_id), "email": user.email},
    )


@router.post("/tenants/{tenant_id}/impersonate", response_model=ImpersonateOut)
async def impersonate_tenant(
    tenant_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> ImpersonateOut:
    """Mint a short-lived access token for the tenant's primary admin so a
    super-admin can open the tenant's operator console. Audited."""
    svc = TenantService(db)
    admin = await svc.primary_admin(tenant_id)
    token = create_access_token(admin)
    await audit_record(
        db, actor=actor, action="tenant.impersonate", target_type="tenant",
        target_id=str(tenant_id), meta={"as_user": admin.email},
    )
    return ImpersonateOut(access_token=token, tenant_id=tenant_id, user_email=admin.email)


@router.delete("/tenants/{tenant_id}", status_code=204)
async def delete_tenant(
    tenant_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> None:
    """Delete a tenant + all its users (cascade)."""
    tenant = await TenantService(db).delete_tenant(tenant_id)
    await audit_record(
        db, actor=actor, action="tenant.delete", target_type="tenant",
        target_id=str(tenant_id), meta={"name": tenant.name},
    )
