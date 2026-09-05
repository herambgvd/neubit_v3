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
"""

from __future__ import annotations

import logging
import os
import random
from datetime import timedelta

from sqlalchemy import or_, select

from kernel.secrets import decrypt_fields

from ..core.primitives import utcnow
from ..runtime.session import task_session as _task_session
from .connectors import registry
from .connectors.base import DeliveryContext
from .models import Notification, NotificationChannel
from .secrets import is_secret_path

log = logging.getLogger("workflow.notifications.jobs")

MAX_NOTIFY_ATTEMPTS = 5

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


async def dispatch_notifications(limit: int = 50) -> int:
    """Drain due pending notifications through the pluggable connector registry.

    Only rows whose ``next_attempt_at`` is NULL (never tried) or <= now are picked
    up; on failure the row is rescheduled with exponential backoff (+jitter) so a
    flaky provider doesn't get hammered.
    """
    sent = 0
    now = utcnow()
    async with _task_session() as session:
        stmt = (
            select(Notification)
            .where(
                Notification.status == "pending",
                or_(
                    Notification.next_attempt_at.is_(None),
                    Notification.next_attempt_at <= now,
                ),
            )
            .order_by(Notification.created_at.asc())
            .limit(limit)
        )
        pending = list((await session.execute(stmt)).scalars().all())
        for note in pending:
            if note.attempts >= MAX_NOTIFY_ATTEMPTS:
                note.status = "failed"
                note.error = f"Max attempts ({MAX_NOTIFY_ATTEMPTS}) reached"
                note.updated_at = utcnow()
                continue
            note.attempts += 1
            note.last_attempt_at = utcnow()
            connector = registry.get(note.channel_type)
            if connector is None:
                note.status = "failed"
                note.error = f"No connector registered for channel_type={note.channel_type!r}"
                note.updated_at = utcnow()
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
            except Exception as exc:  # keep pending for retry unless capped
                note.error = str(exc)
                if note.attempts < MAX_NOTIFY_ATTEMPTS:
                    note.status = "pending"
                    note.next_attempt_at = utcnow() + _backoff_delay(note.attempts)
                else:
                    note.status = "failed"
                    note.next_attempt_at = None
                log.warning("notification %s dispatch failed (attempt %d): %s",
                            note.notification_id, note.attempts, exc)
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
