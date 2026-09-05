"""Scheduled job over the notification outbox — the dispatch drain.

Async body for the worker's ``dispatch_notifications`` beat task (``app.worker``
wraps it in ``asyncio.run``), plus the long-running notify-request consumer
runner. Both live with the notifications feature because they are the far end of
it: the service and the consumer WRITE outbox rows, this drains them through the
connector registry.

The retry policy is here rather than in a connector on purpose. A connector knows
how to send one message; how many times a message is worth sending, and how long
to wait between tries, is a property of the outbox — and a per-connector copy is
how a flaky provider ends up hammered by one channel and abandoned by another.

THE DRAIN IS A CLAIM, NOT A SELECT. Every replica of this worker runs the same
``SELECT ... WHERE status = 'pending' ORDER BY created_at LIMIT n``, so with one
replica the outbox drains and with two the SAME ROWS come back to both and every
operator gets the alert twice. Two replicas is the normal response to a backlog,
which means the fix for a slow outbox was the trigger for duplicate alerts. See
``_claim_batch`` for the exclusion and ``_reclaim_expired`` for what happens to a
row whose claimer died holding it.
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

# How long a claim is good for. A worker that dies between claiming a row and
# recording its outcome leaves the row in ``claimed`` with nobody working it, and
# ``claimed`` is not a state anything else drains — so without this the row is lost
# silently, which for a life-safety-adjacent alert is worse than sending it twice.
# 600s is an order of magnitude above the slowest realistic delivery (an APNs or
# SMTP connect timing out is tens of seconds) and well below anyone's patience for
# a missing alert. Set it too low and a merely SLOW send is reclaimed while it is
# still in flight, which reintroduces the double-send this commit removes.
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
    """Who holds a claim. Container hostname + pid: enough to point at one process
    across replicas from a psql prompt, and it is diagnostic only — nothing keys off
    it, so a recycled hostname cannot cause a row to be handed to the wrong worker.
    """
    return f"{socket.gethostname()}:{os.getpid()}"


async def _reclaim_expired(session, now) -> int:
    """Return rows whose claimer died back to ``pending``. Caller commits.

    A claim is committed before the send (see ``_claim_batch``), which is what keeps
    the attempt counter durable — and is also what makes an orphan possible: SIGKILL
    the worker mid-send and the row sits in ``claimed`` forever, drained by nothing
    and counted by nothing.

    ``attempts`` is DELIBERATELY NOT reset here. The dead worker may well have
    reached the provider before it died, so that try happened whether or not anyone
    recorded it; forgiving it would let a row that crashes the worker every time
    retry forever. Over-counting an attempt costs one lost retry, under-counting
    costs an unbounded loop — the asymmetry decides it.
    """
    cutoff = now - timedelta(seconds=NOTIFY_CLAIM_LEASE_SECONDS)
    stmt = (
        update(Notification)
        .where(
            Notification.status == "claimed",
            # A NULL claimed_at is a claimed row from before this column existed, or
            # one written by hand. It has no lease to expire, so expire it now
            # rather than leaving it stuck for the same reason.
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

    ``FOR UPDATE SKIP LOCKED`` on the id select is the exclusion: a second worker
    running this same statement in a concurrent transaction does not block on the
    rows this one holds and does not return them either — it walks past to the next
    unlocked rows. The locks live until the caller COMMITS, and the caller commits
    immediately after this returns, before any provider is contacted; holding a row
    lock (and therefore a connection and an open transaction) across an SMTP dial is
    how a slow provider becomes a database incident.

    That commit is what turns the lock into a lease: once the transaction ends the
    row is no longer locked, so ``status = 'claimed'`` is what keeps the next worker
    off it, and ``claimed_at`` is what stops that being forever
    (``_reclaim_expired``).

    ``attempts`` is incremented HERE, in the same committed transaction as the
    claim. It used to be a ``note.attempts += 1`` in memory that reached the
    database only in one big commit after the whole batch had been sent, so a crash
    anywhere in the batch lost the increments AND the ``sent`` marks of every row
    already delivered — the counter could not bound anything and delivered rows were
    re-delivered on the next tick. Committing the increment before the send can only
    over-count (a crash after claiming and before sending burns one try), which is
    the direction that stays bounded.

    Caller must not have an open transaction it cares about: this is a claim, not
    part of a larger unit of work.
    """
    due = or_(Notification.next_attempt_at.is_(None), Notification.next_attempt_at <= now)
    picker = (
        select(Notification.notification_id)
        .where(Notification.status == "pending", due)
        .order_by(Notification.created_at.asc())
        .limit(limit)
    )
    # SQLite has no row locks and no SKIP LOCKED; the unit suite runs single-
    # threaded there, so the clause is Postgres-only and its absence is not a
    # silently weaker claim in production — production is Postgres.
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

    Only rows whose ``next_attempt_at`` is NULL (never tried) or <= now are picked
    up; on failure the row is rescheduled with exponential backoff (+jitter) so a
    flaky provider doesn't get hammered.

    Three transactions, not one: reclaim, claim, then ONE PER ROW for its outcome.
    The single batch-wide commit this replaces meant a crash on row 40 threw away
    the recorded outcome of rows 1..39 — including ones the provider had already
    accepted, which came back as pending and were sent again.
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
            # The claim is released with the outcome, in the same commit. A row that
            # kept claimed_at after reaching a terminal state would be reclaimed by a
            # later sweep and, if it were still pending, sent again.
            note.claimed_at = note.claimed_by = None
            note.updated_at = utcnow()
            await session.commit()
    if sent:
        log.info("dispatched %d notification(s)", sent)
    return sent


async def _resolve_channel_config(session, note) -> dict:
    """Find the tenant's enabled channel config for this notification's type.

    Credentials come out of the column encrypted and are decrypted HERE, at the last
    possible point before a connector needs them, under the key of the tenant that
    OWNS the row (``row.tenant_id``) -- which is the tenant the value was encrypted
    under, and is not always the notification's own tenant (a NULL-tenant platform
    channel serves rows that carry a tenant). The plaintext exists only inside the
    ``DeliveryContext`` handed to one connector for one send; it is never written
    back, never returned by the API and never logged.
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

    Drains ``tenant.*.notify.request`` / ``tenant.*.vms.popup`` into the
    notification outbox (email / webhook / push), which ``dispatch_notifications``
    then delivers. Kept separate from the correlation consumer (that one creates
    incidents; this one creates notifications).
    """
    from .consumer import run_notify_consumer as _run

    await _run()
