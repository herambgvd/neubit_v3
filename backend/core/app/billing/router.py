"""Billing API — super-admin subscription & invoice management.

Full paths under ``{api_prefix}/admin/billing/...``. Every endpoint is gated by
``require_superadmin`` (403 otherwise) and mutations are audit-logged.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..core.audit import record as audit_record
from ..core.errors import ConflictError, NotFoundError, ValidationError
from ..db.base import get_db
from ..tenancy.deps import require_superadmin
from ..tenancy.models import Tenant
from . import service
from .models import (
    INVOICE_STATUSES,
    PLAN_INTERVALS,
    SUBSCRIPTION_STATUSES,
    Invoice,
    Plan,
    Subscription,
)
from .schemas import (
    BillingSummaryOut,
    CreateInvoiceIn,
    CreatePlanIn,
    InvoiceOut,
    PagedInvoicesOut,
    PlanOut,
    SubscribeIn,
    SubscriptionOut,
    UpdatePlanIn,
)

# Mounted under the app's api_prefix → /api/v1/admin/billing/...
router = APIRouter(prefix="/admin/billing", tags=["admin", "billing"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --- Plans -------------------------------------------------------------------
@router.get("/plans", response_model=list[PlanOut])
async def list_plans(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_superadmin),
) -> list[PlanOut]:
    """The plan catalog, ordered for display."""
    rows = (
        await db.execute(select(Plan).order_by(Plan.sort_order, Plan.created_at))
    ).scalars().all()
    return [PlanOut.model_validate(p) for p in rows]


@router.post("/plans", response_model=PlanOut, status_code=201)
async def create_plan(
    data: CreatePlanIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> PlanOut:
    if data.interval not in PLAN_INTERVALS:
        raise ValidationError(f"interval must be one of {PLAN_INTERVALS}")
    exists = await db.scalar(select(Plan).where(Plan.key == data.key))
    if exists is not None:
        raise ConflictError(f"a plan with key '{data.key}' already exists")
    plan = Plan(**data.model_dump())
    db.add(plan)
    await db.commit()
    await db.refresh(plan)
    await audit_record(
        db, actor=actor, action="billing.plan.create", target_type="plan",
        target_id=plan.key, meta={"name": plan.name, "price_cents": plan.price_cents},
    )
    return PlanOut.model_validate(plan)


@router.patch("/plans/{key}", response_model=PlanOut)
async def update_plan(
    key: str,
    data: UpdatePlanIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> PlanOut:
    plan = await db.scalar(select(Plan).where(Plan.key == key))
    if plan is None:
        raise NotFoundError("plan not found")
    fields = data.model_dump(exclude_unset=True)
    if "interval" in fields and fields["interval"] not in PLAN_INTERVALS:
        raise ValidationError(f"interval must be one of {PLAN_INTERVALS}")
    for k, v in fields.items():
        setattr(plan, k, v)
    await db.commit()
    await db.refresh(plan)
    await audit_record(
        db, actor=actor, action="billing.plan.update", target_type="plan",
        target_id=plan.key, meta=fields,
    )
    return PlanOut.model_validate(plan)


@router.delete("/plans/{key}", status_code=204)
async def delete_plan(
    key: str,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> None:
    plan = await db.scalar(select(Plan).where(Plan.key == key))
    if plan is None:
        raise NotFoundError("plan not found")
    in_use = await db.scalar(
        select(func.count()).select_from(Subscription).where(Subscription.plan_key == key)
    )
    if in_use:
        raise ConflictError(f"{in_use} tenant(s) are subscribed to this plan — reassign them first")
    await db.delete(plan)
    await db.commit()
    await audit_record(
        db, actor=actor, action="billing.plan.delete", target_type="plan", target_id=key,
    )


# --- Subscriptions -----------------------------------------------------------
def _sub_out(sub: Subscription, plan: Plan | None) -> SubscriptionOut:
    out = SubscriptionOut.model_validate(sub)
    out.plan = PlanOut.model_validate(plan) if plan is not None else None
    return out


@router.get("/tenants/{tenant_id}/subscription", response_model=SubscriptionOut | None)
async def get_subscription(
    tenant_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_superadmin),
) -> SubscriptionOut | None:
    """The tenant's current subscription (or null if none)."""
    sub = await db.scalar(select(Subscription).where(Subscription.tenant_id == tenant_id))
    if sub is None:
        return None
    plan = await db.scalar(select(Plan).where(Plan.key == sub.plan_key))
    return _sub_out(sub, plan)


@router.put("/tenants/{tenant_id}/subscription", response_model=SubscriptionOut)
async def subscribe(
    tenant_id: uuid.UUID,
    data: SubscribeIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> SubscriptionOut:
    """Assign or change a tenant's plan (upsert). Optionally applies the plan's
    entitlements onto the tenant."""
    if data.status not in SUBSCRIPTION_STATUSES:
        raise ValidationError(f"status must be one of {SUBSCRIPTION_STATUSES}")
    tenant = await db.get(Tenant, tenant_id)
    if tenant is None:
        raise NotFoundError("tenant not found")
    plan = await db.scalar(select(Plan).where(Plan.key == data.plan_key))
    if plan is None:
        raise NotFoundError("plan not found")

    sub = await db.scalar(select(Subscription).where(Subscription.tenant_id == tenant_id))
    if sub is None:
        sub = Subscription(tenant_id=tenant_id)
        db.add(sub)
    sub.plan_key = data.plan_key
    sub.status = data.status
    sub.current_period_start = data.current_period_start
    sub.current_period_end = data.current_period_end
    sub.canceled_at = None
    sub.updated_at = _now()

    if data.apply_entitlements:
        service.apply_plan_entitlements(tenant, plan)

    await db.commit()
    await db.refresh(sub)
    await audit_record(
        db, actor=actor, action="billing.subscribe", target_type="tenant",
        target_id=str(tenant_id),
        meta={"plan": data.plan_key, "status": data.status, "applied": data.apply_entitlements},
    )
    return _sub_out(sub, plan)


@router.post("/tenants/{tenant_id}/subscription/cancel", response_model=SubscriptionOut)
async def cancel_subscription(
    tenant_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> SubscriptionOut:
    sub = await db.scalar(select(Subscription).where(Subscription.tenant_id == tenant_id))
    if sub is None:
        raise NotFoundError("no subscription for this tenant")
    sub.status = "canceled"
    sub.canceled_at = _now()
    sub.updated_at = _now()
    await db.commit()
    await db.refresh(sub)
    plan = await db.scalar(select(Plan).where(Plan.key == sub.plan_key))
    await audit_record(
        db, actor=actor, action="billing.subscription.cancel", target_type="tenant",
        target_id=str(tenant_id), meta={"plan": sub.plan_key},
    )
    return _sub_out(sub, plan)


# --- Invoices ----------------------------------------------------------------
def _invoice_out(inv: Invoice, tenant: Tenant | None) -> InvoiceOut:
    out = InvoiceOut.model_validate(inv)
    out.tenant_name = tenant.name if tenant is not None else None
    return out


@router.get("/invoices", response_model=PagedInvoicesOut)
async def list_invoices(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_superadmin),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    tenant_id: uuid.UUID | None = Query(None),
    status: str | None = Query(None),
    q: str | None = Query(None),
) -> PagedInvoicesOut:
    """Cross-tenant invoice list with tenant/status filters + pagination."""
    conds = []
    if tenant_id is not None:
        conds.append(Invoice.tenant_id == tenant_id)
    if status:
        conds.append(Invoice.status == status)
    if q:
        conds.append(Invoice.number.ilike(f"%{q.strip()}%"))

    count_stmt = select(func.count()).select_from(Invoice)
    list_stmt = select(Invoice, Tenant).join(Tenant, Invoice.tenant_id == Tenant.id, isouter=True)
    if conds:
        count_stmt = count_stmt.where(*conds)
        list_stmt = list_stmt.where(*conds)
    total = (await db.execute(count_stmt)).scalar_one()
    list_stmt = list_stmt.order_by(Invoice.created_at.desc()).offset((page - 1) * page_size).limit(page_size)
    rows = (await db.execute(list_stmt)).all()
    items = [_invoice_out(inv, tenant) for inv, tenant in rows]
    return PagedInvoicesOut(items=items, total=total, page=page, page_size=page_size)


@router.post("/tenants/{tenant_id}/invoices", response_model=InvoiceOut, status_code=201)
async def create_invoice(
    tenant_id: uuid.UUID,
    data: CreateInvoiceIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> InvoiceOut:
    if data.status not in INVOICE_STATUSES:
        raise ValidationError(f"status must be one of {INVOICE_STATUSES}")
    tenant = await db.get(Tenant, tenant_id)
    if tenant is None:
        raise NotFoundError("tenant not found")
    now = _now()
    inv = Invoice(
        tenant_id=tenant_id,
        number=await service.next_invoice_number(db),
        amount_cents=data.amount_cents,
        currency=data.currency,
        status=data.status,
        period_start=data.period_start,
        period_end=data.period_end,
        due_at=data.due_at,
        notes=data.notes,
        issued_at=now if data.status in ("issued", "paid", "overdue") else None,
        paid_at=now if data.status == "paid" else None,
    )
    db.add(inv)
    await db.commit()
    await db.refresh(inv)
    await audit_record(
        db, actor=actor, action="billing.invoice.create", target_type="invoice",
        target_id=inv.number, meta={"tenant_id": str(tenant_id), "amount_cents": inv.amount_cents},
    )
    return _invoice_out(inv, tenant)


@router.post("/invoices/{invoice_id}/mark-paid", response_model=InvoiceOut)
async def mark_invoice_paid(
    invoice_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> InvoiceOut:
    inv = await db.get(Invoice, invoice_id)
    if inv is None:
        raise NotFoundError("invoice not found")
    if inv.status == "void":
        raise ValidationError("a void invoice cannot be marked paid")
    inv.status = "paid"
    inv.paid_at = _now()
    await db.commit()
    await db.refresh(inv)
    tenant = await db.get(Tenant, inv.tenant_id)
    await audit_record(
        db, actor=actor, action="billing.invoice.paid", target_type="invoice",
        target_id=inv.number, meta={"tenant_id": str(inv.tenant_id)},
    )
    return _invoice_out(inv, tenant)


@router.post("/invoices/{invoice_id}/void", response_model=InvoiceOut)
async def void_invoice(
    invoice_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> InvoiceOut:
    inv = await db.get(Invoice, invoice_id)
    if inv is None:
        raise NotFoundError("invoice not found")
    inv.status = "void"
    await db.commit()
    await db.refresh(inv)
    tenant = await db.get(Tenant, inv.tenant_id)
    await audit_record(
        db, actor=actor, action="billing.invoice.void", target_type="invoice",
        target_id=inv.number, meta={"tenant_id": str(inv.tenant_id)},
    )
    return _invoice_out(inv, tenant)


# --- Summary -----------------------------------------------------------------
@router.get("/summary", response_model=BillingSummaryOut)
async def summary(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_superadmin),
) -> BillingSummaryOut:
    return BillingSummaryOut(**await service.billing_summary(db))
