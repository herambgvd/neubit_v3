"""Pydantic request/response schemas for the billing API."""

from __future__ import annotations

import datetime as dt
import uuid

from pydantic import BaseModel, ConfigDict, Field


# --- Plans -------------------------------------------------------------------
class PlanOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    key: str
    name: str
    description: str = ""
    price_cents: int = 0
    currency: str = "USD"
    interval: str = "monthly"
    features: dict = {}
    limits: dict = {}
    is_active: bool = True
    sort_order: int = 0
    created_at: dt.datetime


class CreatePlanIn(BaseModel):
    key: str = Field(min_length=1, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    name: str = Field(min_length=1)
    description: str = ""
    price_cents: int = Field(0, ge=0)
    currency: str = "USD"
    interval: str = "monthly"  # monthly | yearly
    features: dict = {}
    limits: dict = {}
    is_active: bool = True
    sort_order: int = 0


class UpdatePlanIn(BaseModel):
    # PATCH semantics — only sent fields change.
    name: str | None = None
    description: str | None = None
    price_cents: int | None = Field(None, ge=0)
    currency: str | None = None
    interval: str | None = None
    features: dict | None = None
    limits: dict | None = None
    is_active: bool | None = None
    sort_order: int | None = None


# --- Subscriptions -----------------------------------------------------------
class SubscriptionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    tenant_id: uuid.UUID
    plan_key: str
    status: str
    current_period_start: dt.datetime | None = None
    current_period_end: dt.datetime | None = None
    canceled_at: dt.datetime | None = None
    created_at: dt.datetime
    updated_at: dt.datetime
    # Resolved plan snapshot for display (set by the router).
    plan: PlanOut | None = None


class SubscribeIn(BaseModel):
    """Assign or change a tenant's plan."""

    plan_key: str = Field(min_length=1)
    status: str = "active"
    current_period_start: dt.datetime | None = None
    current_period_end: dt.datetime | None = None
    # Copy the plan's features/limits onto the tenant so the operator console's
    # license reflects the commercial plan.
    apply_entitlements: bool = True


# --- Invoices ----------------------------------------------------------------
class InvoiceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    tenant_id: uuid.UUID
    number: str
    amount_cents: int
    currency: str = "USD"
    status: str
    period_start: dt.datetime | None = None
    period_end: dt.datetime | None = None
    issued_at: dt.datetime | None = None
    due_at: dt.datetime | None = None
    paid_at: dt.datetime | None = None
    notes: str | None = None
    created_at: dt.datetime
    # Tenant name resolved for the cross-tenant list (set by the router).
    tenant_name: str | None = None


class CreateInvoiceIn(BaseModel):
    amount_cents: int = Field(ge=0)
    currency: str = "USD"
    status: str = "issued"  # draft | issued | paid | overdue | void
    period_start: dt.datetime | None = None
    period_end: dt.datetime | None = None
    due_at: dt.datetime | None = None
    notes: str | None = None


class PagedInvoicesOut(BaseModel):
    items: list[InvoiceOut]
    total: int
    page: int
    page_size: int


class BillingSummaryOut(BaseModel):
    """Headline commercial metrics for the billing dashboard."""

    mrr_cents: int = 0            # normalized monthly recurring revenue
    currency: str = "USD"
    active_subscriptions: int = 0
    plan_count: int = 0
    outstanding_cents: int = 0    # sum of issued/overdue invoice amounts
    overdue_count: int = 0
    paid_last_30d_cents: int = 0
