"""Scheduled job over the notification outbox — the dispatch drain.

Async body for the worker's ``dispatch_notifications`` beat task, plus the
long-running notify-request consumer runner. The service and the consumer write
outbox rows; this drains them through the connector registry.

Retry policy lives here, not in a connector: how often a message is worth sending
is a property of the outbox, and per-connector copies drift.

The drain is a CLAIM, not a SELECT — every replica runs the same sweep on the same
minute, so a plain select would send every notification once per replica. See
``_claim_batch`` for the exclusion and ``_reclaim_expired`` for a dead claimer.
"""

from __future__ import annotations

import logging
import os
import random
import socket
from datetime import timedelta

from sqlalchemy import or_, select, update

from kernel.secrets import decrypt_fields

from ..core.primitives import utcnow
from ..runtime.session import task_session as _task_session
from .connectors import registry
from .connectors.base import DeliveryContext
from .models import Notification, NotificationChannel
from .secrets import is_secret_path

log = logging.getLogger("workflow.notifications.jobs")

MAX_NOTIFY_ATTEMPTS = 5

# How long a claim is good for. Without it, a worker that dies mid-send leaves a
# row in ``claimed`` that nothing drains. Too low and a merely slow send is
# reclaimed while still in flight, which is a double-send; too high and a real
# alert waits.
NOTIFY_CLAIM_LEASE_SECONDS = int(os.getenv("VE_WORKFLOW_NOTIFY_CLAIM_LEASE", "600"))

# Exponential-backoff tuning for notification retries (seconds).
NOTIFY_BACKOFF_BASE_SECONDS = int(os.getenv("VE_WORKFLOW_NOTIFY_BACKOFF_BASE", "30"))
NOTIFY_BACKOFF_CAP_SECONDS = int(os.getenv("VE_WORKFLOW_NOTIFY_BACKOFF_CAP", "3600"))


def _backoff_delay(attempts: int) -> timedelta:
    """Exponential backoff with jitter: min(base * 2**attempts, cap) ± jitter.

    ``attempts`` is the number of attempts already made (>=1 when scheduling the
    next retry). Jitter is ±20% to avoid thundering-herd re-dispatch.
    """
    raw = min(NOTIFY_BACKOFF_BASE_SECONDS * (2 ** max(attempts, 0)), NOTIFY_BACKOFF_CAP_SECONDS)
    jitter = raw * 0.2 * (random.random() * 2 - 1)  # ±20%
    return timedelta(seconds=max(1.0, raw + jitter))



# ── Notification dispatch (via connector registry) ─────────────────────


def _worker_id() -> str:
    """Who holds a claim: hostname + pid. Diagnostic only — nothing keys off it."""
    return f"{socket.gethostname()}:{os.getpid()}"


async def _reclaim_expired(session, now) -> int:
    """Return rows whose claimer died back to ``pending``. Caller commits.

    ``attempts`` is deliberately not reset: the dead worker may have reached the
    provider first, and forgiving the try would let a row that kills the worker
    every time retry forever.
    """
    cutoff = now - timedelta(seconds=NOTIFY_CLAIM_LEASE_SECONDS)
    stmt = (
        update(Notification)
        .where(
            Notification.status == "claimed",
            # A NULL claimed_at (pre-dates this column, or written by hand) has no
            # lease to expire, so expire it now rather than leave it stuck.
            or_(Notification.claimed_at.is_(None), Notification.claimed_at <= cutoff),
        )
        .values(status="pending", claimed_at=None, claimed_by=None, updated_at=now)
    )
    result = await session.execute(stmt)
    n = int(result.rowcount or 0)
    if n:
        log.warning("reclaimed %d notification(s) from a claim older than %ds — a worker "
                    "died holding them", n, NOTIFY_CLAIM_LEASE_SECONDS)
    return n


async def _claim_batch(session, limit: int, now, worker: str) -> list[str]:
    """Take exclusive ownership of up to ``limit`` due rows. Caller commits.

    ``FOR UPDATE SKIP LOCKED`` is the exclusion: a concurrent worker walks past
    these rows instead of blocking on them. The caller commits immediately, before
    any provider is contacted — holding a row lock across an SMTP dial turns a slow
    provider into a database incident.

    That commit turns the lock into a lease: ``status='claimed'`` keeps the next
    worker off the row and ``claimed_at`` stops that being forever.

    ``attempts`` is incremented in the same committed transaction, so a crash can
    only over-count. Counting after the send would lose increments on a crash and
    re-deliver rows already sent.

    Caller must not have an open transaction it cares about.
    """
    due = or_(Notification.next_attempt_at.is_(None), Notification.next_attempt_at <= now)
    picker = (
        select(Notification.notification_id)
        .where(Notification.status == "pending", due)
        .order_by(Notification.created_at.asc())
        .limit(limit)
    )
    # SQLite has no SKIP LOCKED, and the unit suite is single-threaded there.
    # Production is Postgres.
    if session.bind is not None and session.bind.dialect.name == "postgresql":
        picker = picker.with_for_update(skip_locked=True)
    ids = list((await session.execute(picker)).scalars().all())
    if not ids:
        return []
    await session.execute(
        update(Notification)
        .where(Notification.notification_id.in_(ids))
        .values(status="claimed", claimed_at=now, claimed_by=worker,
                attempts=Notification.attempts + 1, last_attempt_at=now, updated_at=now)
    )
    return ids


async def dispatch_notifications(limit: int = 50) -> int:
    """Drain due pending notifications through the pluggable connector registry.

    Picks up rows whose ``next_attempt_at`` is NULL or due; a failure reschedules
    with exponential backoff plus jitter.

    Commits per row, not per batch: one batch-wide commit would throw away the
    outcome of every row already delivered when a later row crashed.
    """
    sent = 0
    now = utcnow()
    worker = _worker_id()
    async with _task_session() as session:
        await _reclaim_expired(session, now)
        await session.commit()

        claimed_ids = await _claim_batch(session, limit, now, worker)
        await session.commit()

        for nid in claimed_ids:
            note = await session.get(Notification, nid)
            if note is None:  # deleted under us; nothing to deliver
                continue
            if note.attempts > MAX_NOTIFY_ATTEMPTS:
                note.status = "failed"
                note.error = f"Max attempts ({MAX_NOTIFY_ATTEMPTS}) reached"
                note.claimed_at = note.claimed_by = None
                note.updated_at = utcnow()
                await session.commit()
                continue
            connector = registry.get(note.channel_type)
            if connector is None:
                note.status = "failed"
                note.error = f"No connector registered for channel_type={note.channel_type!r}"
                note.claimed_at = note.claimed_by = None
                note.updated_at = utcnow()
                await session.commit()
                continue
            channel_cfg = await _resolve_channel_config(session, note)
            try:
                await connector.send(DeliveryContext(
                    tenant_id=str(note.tenant_id) if note.tenant_id else None,
                    recipient=note.recipient, subject=note.subject, body=note.body,
                    metadata=note.extra or {}, channel_config=channel_cfg,
                ))
                note.status = "sent"
                note.sent_at = utcnow()
                note.next_attempt_at = None
                note.error = None
                sent += 1
            except Exception as exc:  # back to pending for retry unless capped
                note.error = str(exc)
                if note.attempts < MAX_NOTIFY_ATTEMPTS:
                    note.status = "pending"
                    note.next_attempt_at = utcnow() + _backoff_delay(note.attempts)
                else:
                    note.status = "failed"
                    note.next_attempt_at = None
                log.warning("notification %s dispatch failed (attempt %d): %s",
                            note.notification_id, note.attempts, exc)
            # Release the claim with the outcome, in the same commit — a row still
            # holding claimed_at would be reclaimed by a later sweep and resent.
            note.claimed_at = note.claimed_by = None
            note.updated_at = utcnow()
            await session.commit()
    if sent:
        log.info("dispatched %d notification(s)", sent)
    return sent


async def _resolve_channel_config(session, note) -> dict:
    """Find the tenant's enabled channel config for this notification's type.

    Credentials are decrypted here, as late as possible, under the key of the tenant
    that OWNS the channel row — not the notification's tenant, which differs when a
    platform channel serves a tenant's rows. The plaintext lives only in the
    ``DeliveryContext`` for one send; never stored back, returned or logged.
    """
    stmt = select(NotificationChannel).where(
        NotificationChannel.channel_type == note.channel_type,
        NotificationChannel.is_enabled.is_(True),
    )
    if note.channel_id:
        stmt = stmt.where(NotificationChannel.channel_id == note.channel_id)
    elif note.tenant_id is not None:
        stmt = stmt.where(NotificationChannel.tenant_id == note.tenant_id)
    else:
        stmt = stmt.where(NotificationChannel.tenant_id.is_(None))
    row = (await session.execute(stmt.limit(1))).scalars().first()
    if row is None:
        return {}
    return decrypt_fields(row.tenant_id, row.config or {}, is_secret_path) or {}


# ── Notify consumer (long-running) ─────────────────────────────────────


async def run_notify_consumer() -> None:
    """Start the notify-request consumer and block forever (Celery long-running).

    Drains ``tenant.*.notify.request`` / ``tenant.*.vms.popup`` into the outbox,
    which ``dispatch_notifications`` then delivers. Separate from the correlation
    consumer: that one creates incidents, this one creates notifications.
    """
    from .consumer import run_notify_consumer as _run

    await _run()
