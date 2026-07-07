"""Tenant ORM model (multi-tenancy control plane).

v1 = tenant_id row-scoping in a SHARED control DB. Every tenant-owned row carries a
tenant_id; super-admins (tenant_id NULL, is_superadmin True) manage tenants via the
/admin API. This is the testable first cut.

PRODUCTION HARDENING TARGET: DB-per-tenant — each tenant gets its own physical
database (hard isolation, easy per-tenant backup/restore/delete). When that lands,
the Tenant row would additionally hold a connection descriptor and get_db would
route by tenant; the tenant_id columns become the fallback for the shared control
DB only. Keeping the model here makes that migration incremental.

Uuid/JSON use SQLAlchemy's portable generic types so the same model runs on
Postgres and on SQLite (tests).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import JSON, DateTime, Integer, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db.base import Base

# Allowed tenant lifecycle states. 'suspended' tenants exist but their users are
# denied access (enforced at auth time — see AuthService.authenticate).
TENANT_STATUSES = ("active", "suspended")

# Effective license states derived from expiry + grace window.
LICENSE_STATES = ("active", "grace", "expired")


def effective_license_state(tenant: "Tenant", now: datetime | None = None) -> str:
    """Resolve a tenant's live license state from its expiry + grace window.

    - No expiry set  → 'active' (perpetual / trial-less).
    - now <= expiry  → 'active'.
    - within grace   → 'grace' (still allowed, but flag it in the UI).
    - past grace     → 'expired' (access denied at login).
    """
    exp = tenant.license_expires_at
    if exp is None:
        return "active"
    now = now or datetime.now(timezone.utc)
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    if now <= exp:
        return "active"
    if tenant.grace_days and now <= exp + timedelta(days=tenant.grace_days):
        return "grace"
    return "expired"


class Tenant(Base):
    """A customer/organization. Owns a set of users (and, later, all their data)."""

    __tablename__ = "tenants"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, nullable=False)
    # URL-safe unique handle derived from name (slugify). Used in links/routing.
    slug: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    # 'active' | 'suspended'. Kept a plain string (not a DB enum) for portability
    # and so states can be added without a type migration.
    status: Mapped[str] = mapped_column(String, nullable=False, default="active")
    # Commercial plan / tier label (e.g. "starter", "pro"). Free-form, nullable.
    plan: Mapped[str | None] = mapped_column(String, nullable=True)
    # Feature flags for this tenant, e.g. {"anpr": true, "reports": false}.
    features: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # Quota limits, e.g. {"max_users": 50, "max_cameras": 100}.
    limits: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # License expiry (NULL = perpetual) + a grace window (days) after expiry during
    # which access still works but the UI warns. Beyond grace, login is denied.
    license_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    grace_days: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
