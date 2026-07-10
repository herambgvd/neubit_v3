"""Derive the platform alert list from live data.

Each alert has a DETERMINISTIC ``key`` so its read/dismiss state (stored per admin)
stays stable across recomputations. Sorted most-urgent first.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..billing.models import Invoice, Subscription
from ..tenancy.models import Tenant, effective_license_state

_SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2}


def _aware(d: datetime | None) -> datetime | None:
    if d is not None and d.tzinfo is None:
        return d.replace(tzinfo=timezone.utc)
    return d


async def compute_alerts(db: AsyncSession) -> list[dict]:
    now = datetime.now(timezone.utc)
    alerts: list[dict] = []

    tenants = (await db.execute(select(Tenant))).scalars().all()
    tenant_by_id = {t.id: t for t in tenants}

    # License lifecycle + suspension.
    for t in tenants:
        state = effective_license_state(t, now)
        if state == "expired":
            alerts.append({
                "key": f"license-expired:{t.id}",
                "severity": "critical",
                "category": "license",
                "title": f"{t.name}: license expired",
                "message": "Access is blocked past the grace window. Renew or extend the license.",
                "link": f"/tenants/{t.id}",
                "ts": _aware(t.license_expires_at) or t.created_at,
            })
        elif state == "grace":
            alerts.append({
                "key": f"license-grace:{t.id}",
                "severity": "warning",
                "category": "license",
                "title": f"{t.name}: license in grace period",
                "message": "The license has expired but is still usable during grace. Renew soon.",
                "link": f"/tenants/{t.id}",
                "ts": _aware(t.license_expires_at) or t.created_at,
            })
        if t.status == "suspended":
            alerts.append({
                "key": f"suspended:{t.id}",
                "severity": "warning",
                "category": "tenant",
                "title": f"{t.name} is suspended",
                "message": "Users of this tenant are denied access until it is reactivated.",
                "link": f"/tenants/{t.id}",
                "ts": t.created_at,
            })

    # User-quota breaches.
    rows = (
        await db.execute(select(User.tenant_id, func.count()).group_by(User.tenant_id))
    ).all()
    counts = {tid: n for tid, n in rows if tid is not None}
    for tid, n in counts.items():
        t = tenant_by_id.get(tid)
        if t is None:
            continue
        cap = (t.limits or {}).get("max_users")
        if isinstance(cap, int) and cap >= 0 and n >= cap:
            over = n > cap
            alerts.append({
                "key": f"quota-users:{tid}",
                "severity": "critical" if over else "warning",
                "category": "quota",
                "title": f"{t.name}: user quota {'exceeded' if over else 'reached'}",
                "message": f"{n} of {cap} seats used. Increase the quota or the plan.",
                "link": f"/tenants/{tid}",
                "ts": t.created_at,
            })

    # Overdue / past-due invoices.
    invoices = (
        await db.execute(select(Invoice).where(Invoice.status.in_(("issued", "overdue"))))
    ).scalars().all()
    for inv in invoices:
        due = _aware(inv.due_at)
        is_overdue = inv.status == "overdue" or (due is not None and due < now)
        if not is_overdue:
            continue
        t = tenant_by_id.get(inv.tenant_id)
        alerts.append({
            "key": f"invoice-overdue:{inv.id}",
            "severity": "warning",
            "category": "invoice",
            "title": f"Invoice {inv.number} overdue",
            "message": f"{(t.name + ': ') if t else ''}payment is past due.",
            "link": "/billing",
            "ts": due or inv.created_at,
        })

    # Past-due subscriptions.
    subs = (
        await db.execute(select(Subscription).where(Subscription.status == "past_due"))
    ).scalars().all()
    for s in subs:
        t = tenant_by_id.get(s.tenant_id)
        alerts.append({
            "key": f"sub-pastdue:{s.tenant_id}",
            "severity": "warning",
            "category": "subscription",
            "title": f"{(t.name + ': ') if t else ''}subscription past due",
            "message": "The subscription is marked past due. Follow up on payment.",
            "link": f"/tenants/{s.tenant_id}" if t else "/billing",
            "ts": _aware(s.updated_at) or s.created_at,
        })

    alerts.sort(key=lambda a: (_SEVERITY_RANK.get(a["severity"], 3), -(a["ts"] or now).timestamp()))
    return alerts
