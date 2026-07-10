"""Billing service — invoice numbering, entitlement sync, and summary metrics."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..tenancy.models import Tenant
from .models import Invoice, Plan, Subscription


async def next_invoice_number(db: AsyncSession) -> str:
    """Generate a human invoice number ``INV-<year>-<seq>`` (per-year sequence)."""
    year = datetime.now(timezone.utc).year
    prefix = f"INV-{year}-"
    count = await db.scalar(
        select(func.count()).select_from(Invoice).where(Invoice.number.like(f"{prefix}%"))
    )
    return f"{prefix}{(int(count or 0) + 1):04d}"


def apply_plan_entitlements(tenant: Tenant, plan: Plan) -> None:
    """Copy a plan's commercial identity + entitlements onto the tenant so the
    operator console's license reflects the plan. Only overwrites what the plan
    defines (features/limits are replaced wholesale to keep the plan authoritative).
    """
    tenant.plan = plan.key
    if plan.features:
        tenant.features = dict(plan.features)
    if plan.limits:
        tenant.limits = dict(plan.limits)


def _monthly_cents(plan: Plan) -> int:
    """Normalize a plan's price to a monthly figure for MRR."""
    if plan.interval == "yearly":
        return round(plan.price_cents / 12)
    return plan.price_cents


async def billing_summary(db: AsyncSession) -> dict:
    """Compute headline commercial metrics across all tenants."""
    now = datetime.now(timezone.utc)

    plans = {p.key: p for p in (await db.execute(select(Plan))).scalars()}
    plan_count = len(plans)

    subs = (await db.execute(select(Subscription))).scalars().all()
    active = [s for s in subs if s.status in ("active", "trialing")]
    mrr = sum(_monthly_cents(plans[s.plan_key]) for s in active if s.plan_key in plans)

    invoices = (await db.execute(select(Invoice))).scalars().all()
    outstanding = 0
    overdue_count = 0
    paid_30d = 0
    cutoff = now - timedelta(days=30)
    for inv in invoices:
        due = inv.due_at
        if due is not None and due.tzinfo is None:
            due = due.replace(tzinfo=timezone.utc)
        is_overdue = inv.status == "overdue" or (inv.status == "issued" and due is not None and due < now)
        if inv.status in ("issued", "overdue"):
            outstanding += inv.amount_cents
        if is_overdue:
            overdue_count += 1
        if inv.status == "paid" and inv.paid_at is not None:
            paid_at = inv.paid_at
            if paid_at.tzinfo is None:
                paid_at = paid_at.replace(tzinfo=timezone.utc)
            if paid_at >= cutoff:
                paid_30d += inv.amount_cents

    # Currency is taken from the most common active plan (single-currency assumption).
    currency = "USD"
    if active:
        first = plans.get(active[0].plan_key)
        if first:
            currency = first.currency

    return {
        "mrr_cents": mrr,
        "currency": currency,
        "active_subscriptions": len(active),
        "plan_count": plan_count,
        "outstanding_cents": outstanding,
        "overdue_count": overdue_count,
        "paid_last_30d_cents": paid_30d,
    }
