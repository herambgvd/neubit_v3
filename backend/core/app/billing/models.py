"""Billing ORM models: Plan (tier catalog) + Subscription + Invoice.

All tenant-linked rows carry a ``tenant_id`` FK (CASCADE) so deleting a tenant
cleans up its commercial records. Portable generic types (Uuid/JSON/String) keep
the same models on Postgres and SQLite (tests).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from ..db.base import Base

# Subscription lifecycle states.
SUBSCRIPTION_STATUSES = ("active", "trialing", "past_due", "canceled")
# Invoice lifecycle states.
INVOICE_STATUSES = ("draft", "issued", "paid", "overdue", "void")
# Billing intervals a plan can be priced on.
PLAN_INTERVALS = ("monthly", "yearly")


class Plan(Base):
    """A commercial tier in the catalog (Starter / Pro / Enterprise …)."""

    __tablename__ = "billing_plans"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # Stable machine key referenced by subscriptions (e.g. "pro").
    key: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(String, nullable=False, default="")
    # Price stored in minor units (cents) to avoid float drift. 0 = free.
    price_cents: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    currency: Mapped[str] = mapped_column(
        String, nullable=False, default="USD", server_default=text("'USD'")
    )
    # "monthly" | "yearly".
    interval: Mapped[str] = mapped_column(
        String, nullable=False, default="monthly", server_default=text("'monthly'")
    )
    # Entitlements this plan grants — copied onto the tenant on subscribe (opt-in).
    features: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    limits: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    # Display order in the catalog UI.
    sort_order: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Subscription(Base):
    """A tenant's current plan assignment (one active row per tenant)."""

    __tablename__ = "billing_subscriptions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), unique=True, index=True, nullable=False
    )
    # Soft reference to Plan.key (kept as a string so deleting a plan doesn't
    # cascade-destroy history; the UI resolves the plan for display).
    plan_key: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(
        String, nullable=False, default="active", server_default=text("'active'")
    )
    current_period_start: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    current_period_end: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    canceled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Invoice(Base):
    """One billing invoice for a tenant, tracked through its lifecycle."""

    __tablename__ = "billing_invoices"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # Human-facing invoice number, e.g. "INV-2026-0001". Indexed for lookup.
    number: Mapped[str] = mapped_column(String, index=True, nullable=False)
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    currency: Mapped[str] = mapped_column(
        String, nullable=False, default="USD", server_default=text("'USD'")
    )
    # "draft" | "issued" | "paid" | "overdue" | "void".
    status: Mapped[str] = mapped_column(
        String, nullable=False, default="issued", server_default=text("'issued'"), index=True
    )
    period_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    notes: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
