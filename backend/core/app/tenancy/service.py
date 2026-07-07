"""TenantService — tenant lifecycle + tenant-admin provisioning.

All DB writes commit explicitly (same contract as AuthService). Password hashing
and Administrator-role assignment reuse the auth layer so a tenant-admin is created
exactly like any other Administrator user, just scoped to a tenant_id.
"""

from __future__ import annotations

import datetime as dt
import re
import uuid

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import Role, User
from ..auth.permissions import WILDCARD
from ..auth.security import hash_password, validate_password
from ..auth.service import ADMIN_ROLE_NAME
from ..core.errors import ConflictError, NotFoundError, ValidationError
from .models import TENANT_STATUSES, Tenant


def slugify(name: str) -> str:
    """URL-safe lowercase slug: alnum runs joined by hyphens."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "tenant"


class TenantService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def _unique_slug(self, name: str) -> str:
        """Slugify ``name`` and append -2, -3, … until it's unique."""
        base = slugify(name)
        slug = base
        i = 2
        while (
            await self.db.execute(select(Tenant.id).where(Tenant.slug == slug))
        ).scalar_one_or_none() is not None:
            slug = f"{base}-{i}"
            i += 1
        return slug

    async def _admin_role(self) -> Role:
        """The built-in Administrator role (wildcard). Created if missing.

        Roles are shared across tenants in v1; a tenant-admin gets the same
        Administrator role but is scoped by its tenant_id. (Under DB-per-tenant
        each tenant DB would carry its own roles table.)
        """
        role = (
            await self.db.execute(select(Role).where(Role.name == ADMIN_ROLE_NAME))
        ).scalar_one_or_none()
        if role is None:
            role = Role(
                name=ADMIN_ROLE_NAME,
                description="Full access (system role)",
                permissions=[WILDCARD],
                is_system=True,
            )
            self.db.add(role)
            await self.db.commit()
            await self.db.refresh(role)
        return role

    async def create_tenant(
        self, name: str, admin_email: str, admin_password: str
    ) -> Tenant:
        """Create a Tenant + its first tenant-admin User (Administrator role)."""
        if (
            await self.db.execute(select(User).where(User.email == admin_email))
        ).scalar_one_or_none():
            raise ConflictError("admin_email already registered")
        validate_password(admin_password)

        tenant = Tenant(name=name, slug=await self._unique_slug(name), status="active")
        self.db.add(tenant)
        await self.db.flush()  # assign tenant.id before we reference it

        role = await self._admin_role()
        admin = User(
            email=admin_email,
            full_name=name + " Administrator",
            role_id=role.id,
            password_hash=hash_password(admin_password),
            is_active=True,
            tenant_id=tenant.id,
            is_superadmin=False,  # a TENANT admin, not a platform super-admin
            email_verified=True,  # provisioned by a trusted super-admin
        )
        self.db.add(admin)
        await self.db.commit()
        await self.db.refresh(tenant)
        return tenant

    async def get_tenant(self, tenant_id: uuid.UUID) -> Tenant:
        tenant = await self.db.get(Tenant, tenant_id)
        if tenant is None:
            raise NotFoundError("tenant not found")
        return tenant

    def tenants_query(self):
        return select(Tenant).order_by(Tenant.created_at.desc())

    async def paged_tenants(
        self, *, page: int = 1, page_size: int = 20, q: str | None = None,
        status: str | None = None,
    ) -> tuple[list[Tenant], int]:
        """Tenants list with search (name/slug) + status filter + pagination."""
        page = max(1, page)
        page_size = min(max(1, page_size), 100)
        stmt = select(Tenant)
        count_stmt = select(func.count()).select_from(Tenant)
        if q:
            like = f"%{q.strip().lower()}%"
            cond = or_(func.lower(Tenant.name).like(like), func.lower(Tenant.slug).like(like))
            stmt = stmt.where(cond)
            count_stmt = count_stmt.where(cond)
        if status:
            stmt = stmt.where(Tenant.status == status)
            count_stmt = count_stmt.where(Tenant.status == status)
        total = int(await self.db.scalar(count_stmt) or 0)
        stmt = stmt.order_by(Tenant.created_at.desc()).offset((page - 1) * page_size).limit(page_size)
        rows = (await self.db.execute(stmt)).scalars().all()
        return list(rows), total

    async def user_count(self, tenant_id: uuid.UUID) -> int:
        return int(
            await self.db.scalar(
                select(func.count()).select_from(User).where(User.tenant_id == tenant_id)
            )
            or 0
        )

    async def usage(self, tenant_id: uuid.UUID) -> dict:
        """Current resource usage vs. the tenant's limits (users now; more later)."""
        tenant = await self.get_tenant(tenant_id)
        return {"users": await self.user_count(tenant_id), "limits": tenant.limits or {}}

    async def update_tenant(
        self,
        tenant_id: uuid.UUID,
        *,
        status: str | None = None,
        plan: str | None = None,
        features: dict | None = None,
        limits: dict | None = None,
    ) -> Tenant:
        tenant = await self.get_tenant(tenant_id)
        if status is not None:
            if status not in TENANT_STATUSES:
                raise ValidationError(f"status must be one of {TENANT_STATUSES}")
            tenant.status = status
        if plan is not None:
            tenant.plan = plan
        if features is not None:
            tenant.features = features
        if limits is not None:
            tenant.limits = limits
        await self.db.commit()
        await self.db.refresh(tenant)
        return tenant

    async def set_status(self, tenant_id: uuid.UUID, status: str) -> Tenant:
        """Suspend / reactivate a tenant (login is gated on this in authenticate)."""
        if status not in TENANT_STATUSES:
            raise ValidationError(f"status must be one of {TENANT_STATUSES}")
        tenant = await self.get_tenant(tenant_id)
        tenant.status = status
        await self.db.commit()
        await self.db.refresh(tenant)
        return tenant

    async def set_license(
        self,
        tenant_id: uuid.UUID,
        *,
        plan: str | None = None,
        features: dict | None = None,
        limits: dict | None = None,
        license_expires_at: dt.datetime | None = None,
        grace_days: int | None = None,
        clear_expiry: bool = False,
    ) -> Tenant:
        """Apply a tenant's license: tier + entitlements + term.

        `clear_expiry=True` sets a perpetual license (NULL expiry). Otherwise a
        provided `license_expires_at` replaces it; omitted fields are unchanged.
        """
        tenant = await self.get_tenant(tenant_id)
        if plan is not None:
            tenant.plan = plan
        if features is not None:
            tenant.features = features
        if limits is not None:
            tenant.limits = limits
        if clear_expiry:
            tenant.license_expires_at = None
        elif license_expires_at is not None:
            tenant.license_expires_at = license_expires_at
        if grace_days is not None:
            tenant.grace_days = max(0, grace_days)
        await self.db.commit()
        await self.db.refresh(tenant)
        return tenant

    # --- per-tenant admin users ------------------------------------------------
    async def list_tenant_users(self, tenant_id: uuid.UUID) -> list[User]:
        await self.get_tenant(tenant_id)  # 404 if missing
        return list(
            (
                await self.db.execute(
                    select(User).where(User.tenant_id == tenant_id).order_by(User.created_at.desc())
                )
            ).scalars().all()
        )

    async def create_tenant_admin(
        self, tenant_id: uuid.UUID, email: str, password: str, full_name: str | None = None
    ) -> User:
        """Create an Administrator user scoped to this tenant (quota-checked)."""
        tenant = await self.get_tenant(tenant_id)
        if (await self.db.execute(select(User).where(User.email == email))).scalar_one_or_none():
            raise ConflictError("email already registered")
        validate_password(password)
        # Enforce max_users quota if the tenant's license sets one.
        max_users = (tenant.limits or {}).get("max_users")
        if isinstance(max_users, int) and max_users >= 0:
            if await self.user_count(tenant_id) >= max_users:
                raise ConflictError(f"user quota reached (max_users={max_users})")
        role = await self._admin_role()
        user = User(
            email=email,
            full_name=full_name or (tenant.name + " Administrator"),
            role_id=role.id,
            password_hash=hash_password(password),
            is_active=True,
            tenant_id=tenant_id,
            is_superadmin=False,
            email_verified=True,
        )
        self.db.add(user)
        await self.db.commit()
        await self.db.refresh(user)
        return user

    async def delete_tenant_admin(self, tenant_id: uuid.UUID, user_id: uuid.UUID) -> User:
        """Delete a user, but only if it belongs to this tenant (isolation guard)."""
        user = await self.db.get(User, user_id)
        if user is None or user.tenant_id != tenant_id:
            raise NotFoundError("user not found in this tenant")
        if await self.user_count(tenant_id) <= 1:
            raise ConflictError("cannot delete the tenant's last user")
        await self.db.delete(user)
        await self.db.commit()
        return user

    async def primary_admin(self, tenant_id: uuid.UUID) -> User:
        """The tenant's oldest user — used as the identity for impersonation."""
        user = (
            await self.db.execute(
                select(User).where(User.tenant_id == tenant_id).order_by(User.created_at.asc())
            )
        ).scalars().first()
        if user is None:
            raise NotFoundError("tenant has no users to impersonate")
        return user

    async def delete_tenant(self, tenant_id: uuid.UUID) -> Tenant:
        """Delete a tenant and all its users (users cascade via the FK)."""
        tenant = await self.get_tenant(tenant_id)
        await self.db.delete(tenant)
        await self.db.commit()
        return tenant
