"""How much of the notification outbox is waiting, and how much of it is late.

Three numbers, not one, because a raw pending count cannot tell a busy minute from
a drain that has stopped. What separates them is AGE: the drain runs every minute,
so a row still pending five ticks after it became due was passed over by no worker
at all. That is ``overdue``, the number worth paging on.

``claimed`` is counted separately because rows in flight are invisible to the other
two — a worker that claims a batch and then wedges would otherwise empty the
gauges while delivering nothing.

``failed`` rows are not backlog: they will never be retried, and folding them in
would make a broken SMTP server look like a dead worker.

Not in ``service.py`` because nothing here is a request: no principal, no scope, no
permission — it is a whole-process gauge across every tenant's rows.
"""

from __future__ import annotations

import os
from datetime import timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.primitives import utcnow
from .models import Notification

# Five ticks of the every-minute dispatch schedule: one or two missed passes is a
# slow provider or a restart, five is nothing draining. Its own knob because it can
# go red while the worker is healthy and every connector is failing.
OVERDUE_AFTER_SEC = int(os.getenv("VE_WORKFLOW_NOTIFY_OVERDUE_SEC", "300"))


async def backlog(session: AsyncSession) -> dict:
    """Outbox depth for the whole process. One query, three counts plus the age.

    ``oldest_due_age_sec`` keeps rising during a wedge while the counts can sit
    flat, so it is what distinguishes "stuck" from "steady".
    """
    now = utcnow()
    due = or_(Notification.next_attempt_at.is_(None), Notification.next_attempt_at <= now)
    # Due time: next attempt, or creation if never tried. One COALESCE rather than
    # two queries, so the branches cannot drift.
    due_at = func.coalesce(Notification.next_attempt_at, Notification.created_at)
    cutoff = now - timedelta(seconds=OVERDUE_AFTER_SEC)

    stmt = select(
        func.count().filter(Notification.status == "pending"),
        func.count().filter(Notification.status == "pending", due),
        func.count().filter(Notification.status == "pending", due, due_at <= cutoff),
        func.count().filter(Notification.status == "failed"),
        func.min(due_at).filter(Notification.status == "pending", due),
        func.count().filter(Notification.status == "claimed"),
    ).select_from(Notification)

    pending, ready, overdue, failed, oldest, claimed = (await session.execute(stmt)).one()
    return {
        "pending": int(pending or 0),
        "claimed": int(claimed or 0),
        "due": int(ready or 0),
        "overdue": int(overdue or 0),
        "failed": int(failed or 0),
        "overdue_after_sec": OVERDUE_AFTER_SEC,
        "oldest_due_age_sec": round((now - oldest).total_seconds(), 1) if oldest else 0.0,
    }


def prometheus(b: dict, prefix: str = "workflow_") -> str:
    p = prefix
    return "\n".join([
        f"# HELP {p}notifications_pending Outbox rows awaiting delivery, all tenants.",
        f"# TYPE {p}notifications_pending gauge",
        f"{p}notifications_pending {b['pending']}",
        f"# HELP {p}notifications_due Pending rows whose next_attempt_at has arrived. "
        f"Rises during a normal burst too — read it with notifications_overdue.",
        f"# TYPE {p}notifications_due gauge",
        f"{p}notifications_due {b['due']}",
        f"# HELP {p}notifications_overdue Pending rows that have been DUE for longer than "
        f"{b['overdue_after_sec']}s ({b['overdue_after_sec'] // 60} ticks of the "
        f"every-minute dispatch task). A busy worker does not produce these; a worker "
        f"that is not draining the outbox does. THIS is the backlog number to page on.",
        f"# TYPE {p}notifications_overdue gauge",
        f"{p}notifications_overdue {b['overdue']}",
        f"# HELP {p}notifications_claimed Rows a worker currently owns (in flight). "
        f"Not part of pending. A value that never moves is a worker that claimed a "
        f"batch and stopped, which every other gauge here reads as an empty outbox.",
        f"# TYPE {p}notifications_claimed gauge",
        f"{p}notifications_claimed {b['claimed']}",
        f"# HELP {p}notifications_failed Rows that exhausted their retry budget. A "
        f"delivery problem (provider, credentials), NOT a drain problem.",
        f"# TYPE {p}notifications_failed gauge",
        f"{p}notifications_failed {b['failed']}",
        f"# HELP {p}notifications_oldest_due_age_sec Age of the oldest row that is due and "
        f"still pending. Keeps rising through a wedge even when the counts sit flat.",
        f"# TYPE {p}notifications_oldest_due_age_sec gauge",
        f"{p}notifications_oldest_due_age_sec {b['oldest_due_age_sec']}",
        "",
    ])
