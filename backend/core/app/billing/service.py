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
    """Copy a plan's key and entitlements onto the tenant.

    Only what the plan defines is overwritten, and features/limits are replaced
    wholesale so the plan stays authoritative.
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


def _as_utc(value):
    """A naive timestamp out of the store is UTC; say so before comparing it."""
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _invoice_totals(invoices: list, now: datetime) -> dict:
    """What is owed, what is late, and what was actually paid this month."""
    cutoff = now - timedelta(days=30)
    outstanding = 0
    overdue_count = 0
    paid_30d = 0
    for inv in invoices:
        due = _as_utc(inv.due_at)
        if inv.status in ("issued", "overdue"):
            outstanding += inv.amount_cents
        if inv.status == "overdue" or (
            inv.status == "issued" and due is not None and due < now
        ):
            overdue_count += 1
        paid_at = _as_utc(inv.paid_at)
        if inv.status == "paid" and paid_at is not None and paid_at >= cutoff:
            paid_30d += inv.amount_cents
    return {
        "outstanding": outstanding,
        "overdue_count": overdue_count,
        "paid_30d": paid_30d,
    }


async def billing_summary(db: AsyncSession) -> dict:
    """Compute headline commercial metrics across all tenants."""
    now = datetime.now(timezone.utc)

    plans = {p.key: p for p in (await db.execute(select(Plan))).scalars()}
    plan_count = len(plans)

    subs = (await db.execute(select(Subscription))).scalars().all()
    active = [s for s in subs if s.status in ("active", "trialing")]
    mrr = sum(_monthly_cents(plans[s.plan_key]) for s in active if s.plan_key in plans)

    totals = _invoice_totals((await db.execute(select(Invoice))).scalars().all(), now)
    outstanding = totals["outstanding"]
    overdue_count = totals["overdue_count"]
    paid_30d = totals["paid_30d"]

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
