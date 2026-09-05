"""How much of the notification outbox is waiting, and how much of it is late.

A raw count of pending rows is close to useless as a health signal, which is why
this is three numbers rather than one. Pending rises for two reasons that need
opposite responses:

  * a burst arrived and ``dispatch_notifications`` has not reached it yet — a busy
    minute, self-correcting, nothing to do;
  * nothing is draining the outbox at all — a wedged worker, a broker outage, a
    provider timing out on every row.

Both look identical at any single instant. What separates them is AGE. A row
becomes due at ``next_attempt_at`` (or, never having been tried, at
``created_at``); the drain runs on ``crontab(minute="*")``. So a row that has been
DUE for five dispatch ticks and is still pending has not been passed over by a
busy worker — it has been passed over by no worker. That is ``overdue``, and it is
the number worth paging on. ``pending`` is context for it.

``claimed`` is counted separately and is NOT folded into ``pending``, because a
claimed row is one a worker owns right now. It has to be its own number rather than
be left out: rows in flight are invisible to ``pending``/``overdue``, so a worker
that claims a batch and then wedges would empty the backlog gauges while delivering
nothing. ``claimed`` sitting at a constant non-zero across ticks is that wedge. (The
lease reaper returns those rows to pending once the claim expires, so a permanent
stall still reaches ``overdue`` eventually — this is what sees it sooner.)

DELIBERATELY NOT COUNTING ``failed`` ROWS AS BACKLOG. A row that exhausted
MAX_NOTIFY_ATTEMPTS is a delivery that will never be retried; it is a delivery
problem, not a drain problem, and folding it in would make a broken SMTP server
look like a dead worker. It is exposed as its own counter instead.

Why here and not in ``service.py``: nothing about this is a request. There is no
principal, no tenant scope and no permission — it is a whole-process gauge over
every tenant's rows, which is the one thing a tenant-scoped service must never
return.
"""

from __future__ import annotations

import os
from datetime import timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.primitives import utcnow
from .models import Notification

# Five ticks of the every-minute dispatch schedule. Same reasoning as the worker's
# silence limit: one or two missed passes is a slow provider or a restart, five is
# nothing draining. Kept as its own knob because the two limits answer different
# questions — this one can go red while the worker is perfectly healthy, if every
# connector is failing.
OVERDUE_AFTER_SEC = int(os.getenv("VE_WORKFLOW_NOTIFY_OVERDUE_SEC", "300"))


async def backlog(session: AsyncSession) -> dict:
    """Outbox depth for the whole process. One query, three counts plus the age.

    ``oldest_due_age_sec`` is the one that keeps rising during a wedge while every
    count can sit flat (a stalled drain with a stable inbound rate holds ``pending``
    perfectly still), so it is the signal that distinguishes "stuck" from "steady".
    """
    now = utcnow()
    due = or_(Notification.next_attempt_at.is_(None), Notification.next_attempt_at <= now)
    # A row's due time: when it may next be attempted, or when it was created if it
    # never has been. COALESCE, not two queries, so the two branches cannot drift.
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
