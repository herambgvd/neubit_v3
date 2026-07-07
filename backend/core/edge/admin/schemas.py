"""Pydantic request/response schemas for the super-admin (tenant) API."""

from __future__ import annotations

import datetime as dt
import uuid

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class TenantOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    slug: str
    status: str
    plan: str | None
    features: dict = {}
    limits: dict = {}
    license_expires_at: dt.datetime | None = None
    grace_days: int = 0
    # Derived on the way out (active | grace | expired). Set by the router.
    license_state: str = "active"
    created_at: dt.datetime


class TenantWithCountOut(TenantOut):
    """List/detail view: tenant + a count of its users."""

    users: int = 0


class CreateTenantIn(BaseModel):
    """Create a tenant and its first tenant-admin user in one call."""

    name: str = Field(min_length=1)
    admin_email: EmailStr
    admin_password: str


class UpdateTenantIn(BaseModel):
    # All optional — only sent fields change (PATCH semantics).
    status: str | None = None       # 'active' | 'suspended'
    plan: str | None = None
    features: dict | None = None
    limits: dict | None = None


class LicenseIn(BaseModel):
    """Super-admin sets a tenant's license: tier + entitlements + term."""

    plan: str | None = None                       # tier label, e.g. "pro"
    features: dict | None = None                  # {"anpr": true, ...}
    limits: dict | None = None                    # {"max_users": 50, ...}
    license_expires_at: dt.datetime | None = None  # None = perpetual
    grace_days: int | None = None


class TenantAdminIn(BaseModel):
    """Provision an admin user inside a specific tenant."""

    email: EmailStr
    password: str
    full_name: str | None = None


class TenantAdminOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    email: str
    full_name: str | None = None
    is_active: bool = True
    created_at: dt.datetime


class TenantUsageOut(BaseModel):
    """Current usage vs. the tenant's limits (users now; more resources later)."""

    users: int = 0
    limits: dict = {}


class ImpersonateOut(BaseModel):
    """A short-lived access token that opens the tenant's operator console as its
    admin. Access-only (no refresh) — re-impersonate when it expires."""

    access_token: str
    tenant_id: uuid.UUID
    user_email: str


class PagedTenantsOut(BaseModel):
    items: list[TenantWithCountOut]
    total: int
    page: int
    page_size: int
