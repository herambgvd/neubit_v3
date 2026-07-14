"""Async task bodies for the workflow Celery worker + the correlation consumer.

Celery tasks are synchronous entry points (``app.worker``); the real work is async
(DB + NATS), so each task wraps an ``async def`` here via ``asyncio.run``. Keeping
the logic here (not in ``worker.py``) keeps the Celery module thin and importable.

Three scheduled jobs + one long-running consumer:
  * ``escalation_sweep`` — SLA breach + state-timeout + SOP escalation-rule bumps.
  * ``timeout_sweep``    — auto-cancel instances idle past a global timeout.
  * ``dispatch_notifications`` — drain the outbox through the connector registry.
  * ``run_correlation_consumer`` — the NATS→incident engine (runs forever).
"""

from __future__ import annotations

import logging
import os
import random
from datetime import datetime, timedelta

from contextlib import asynccontextmanager

from sqlalchemy import delete, or_, pool, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.config import get_settings
from kernel.events import EventBus, subject

from .connectors import registry
from .connectors.base import DeliveryContext
from .models import (
    CorrelationDedup,
    Notification,
    NotificationChannel,
    SOP,
    State,
    WorkflowInstance,
)
from .shared import (
    PRIORITY_ORDER,
    InstancePriority,
    InstanceStatus,
    bump_priority,
    utcnow,
)

log = logging.getLogger("workflow.tasks")

MAX_NOTIFY_ATTEMPTS = 5
DEFAULT_INSTANCE_TIMEOUT_HOURS = int(os.getenv("VE_WORKFLOW_INSTANCE_TIMEOUT_HOURS", "72"))

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


@asynccontextmanager
async def _task_session():
    """Yield an ``AsyncSession`` bound to a fresh, per-run NullPool engine.

    Each Celery task body runs under its own ``asyncio.run()`` loop. Reusing the
    process-wide pooled engine leaks connections bound to a previous loop and
    raises "Future attached to a different loop". A per-run NullPool engine (no
    cross-loop connection reuse), disposed on exit, keeps each sweep loop-safe.
    """
    engine = create_async_engine(get_settings().database_url, poolclass=pool.NullPool)
    sm = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    try:
        async with sm() as session:
            yield session
    finally:
        await engine.dispose()


# ── Escalation sweep ───────────────────────────────────────────────────


async def escalation_sweep() -> int:
    """Scan active/paused instances for SLA breaches + escalations. Idempotent."""
    now = utcnow()
    changed = 0
    bus = EventBus(source="workflow-escalation")
    await bus.connect()
    try:
        async with _task_session() as session:
            stmt = select(WorkflowInstance).where(
                WorkflowInstance.status.in_(
                    [InstanceStatus.ACTIVE.value, InstanceStatus.PAUSED.value]
                )
            )
            for inst in (await session.execute(stmt)).scalars().all():
                if await _evaluate_instance(session, inst, now, bus):
                    changed += 1
            await session.commit()
    finally:
        await bus.close()
    if changed:
        log.info("escalation sweep: touched %d instance(s)", changed)
    return changed


async def _evaluate_instance(session, inst, now, bus) -> bool:
    changed = False
    tid = str(inst.tenant_id) if inst.tenant_id else None

    # 1) Top-level SLA breach.
    if inst.sla_deadline and not inst.is_sla_breached and inst.sla_deadline < now:
        inst.is_sla_breached = True
        inst.updated_at = now
        await bus.publish(subject(tid, "workflow", "incident.sla_breached"),
                          {"tenant_id": tid, "instance_id": inst.instance_id,
                           "sla_deadline": inst.sla_deadline.isoformat()})
        changed = True

    # 2) Per-state timeout → escalate one level.
    state = await session.get(State, inst.current_state) if inst.current_state else None
    if state and state.sla_hours and inst.state_entered_at:
        deadline = inst.state_entered_at + timedelta(hours=state.sla_hours)
        esc = inst.escalation or {}
        esc_at = esc.get("escalated_at")
        already = bool(esc_at) and _parse(esc_at) is not None and _parse(esc_at) >= deadline
        if deadline < now and not already:
            _escalate(inst, now, f"State '{state.name}' timeout", by="system:escalation")
            await bus.publish(subject(tid, "workflow", "incident.escalated"),
                              {"tenant_id": tid, "instance_id": inst.instance_id,
                               "level": inst.escalation["level"], "reason": inst.escalation["reason"]})
            changed = True

    # 3) SOP-level escalation rules (bump priority after N hours).
    sop = await session.get(SOP, inst.sop_id)
    if sop and sop.escalation_rules and inst.created_at:
        elapsed_h = (now - inst.created_at).total_seconds() / 3600
        cur = InstancePriority(inst.priority)
        for rule in sop.escalation_rules:
            after = rule.get("after_hours", 0)
            target = InstancePriority(rule.get("to_priority", "high"))
            if elapsed_h < after:
                continue
            if PRIORITY_ORDER.index(cur) >= PRIORITY_ORDER.index(target):
                continue
            new_pri = bump_priority(cur, target)
            inst.priority = new_pri.value
            _escalate(inst, now, f"SOP escalation rule (after {after}h)", by="system:sop_rule")
            await bus.publish(subject(tid, "workflow", "incident.priority_escalated"),
                              {"tenant_id": tid, "instance_id": inst.instance_id,
                               "priority": new_pri.value, "level": inst.escalation["level"],
                               "notify_role_ids": rule.get("notify_role_ids", [])})
            # Enqueue notifications for the rule's recipients (roles/users). Role→user
            # resolution lives in core; we can't reach it here, so we create pending
            # rows keyed by the role_id/user_id and let dispatch/core resolve later.
            _enqueue_escalation_notifications(session, inst, rule, new_pri, now)
            changed = True
            cur = new_pri
    return changed


def _enqueue_escalation_notifications(session, inst, rule, new_pri, now) -> None:
    """Create pending Notification rows for a SOP escalation rule's recipients.

    ``notify_role_ids`` (and optional ``notify_user_ids``) come from the SOP's
    escalation rule. We cannot resolve a role → concrete users/addresses from this
    service (that's core data), so we enqueue one webhook-channel row per recipient
    with the recipient set to ``role:<id>`` / ``user:<id>`` and a TODO marker in
    metadata. A downstream resolver (or the connector) can expand these; nothing is
    silently dropped.
    """
    role_ids = rule.get("notify_role_ids") or []
    user_ids = rule.get("notify_user_ids") or []
    if not role_ids and not user_ids:
        return
    subject_text = f"[{new_pri.value.upper()}] {inst.name or inst.instance_id} escalated"
    body_text = (
        f"Incident {inst.name or inst.instance_id} was escalated to "
        f"priority {new_pri.value} by SOP rule (after {rule.get('after_hours', 0)}h)."
    )
    recipients = [("role", rid) for rid in role_ids] + [("user", uid) for uid in user_ids]
    for kind, ident in recipients:
        session.add(Notification(
            tenant_id=inst.tenant_id,
            # webhook is the safe default: role/user recipients need core resolution
            # before an email address exists. A resolver may re-route to "email".
            channel_type="webhook",
            recipient=f"{kind}:{ident}",
            subject=subject_text,
            body=body_text,
            status="pending",
            instance_id=inst.instance_id,
            extra={
                "kind": "escalation",
                "recipient_kind": kind,
                "recipient_id": str(ident),
                "priority": new_pri.value,
                # TODO(core-resolve): expand role→users / user→address via core.
                "needs_recipient_resolution": True,
            },
        ))


def _escalate(inst, now, reason: str, *, by: str) -> None:
    level = ((inst.escalation or {}).get("level", 0)) + 1
    inst.escalation = {"level": level, "escalated_at": now.isoformat(),
                       "escalated_by": by, "reason": reason}
    inst.updated_at = now


def _parse(raw):
    if isinstance(raw, datetime):
        return raw
    if isinstance(raw, str):
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


# ── Timeout sweep ──────────────────────────────────────────────────────


async def timeout_sweep(timeout_hours: int = DEFAULT_INSTANCE_TIMEOUT_HOURS) -> int:
    """Auto-cancel active/paused instances idle in the same state past the cutoff."""
    if timeout_hours <= 0:
        return 0
    cutoff = utcnow() - timedelta(hours=timeout_hours)
    cancelled = 0
    bus = EventBus(source="workflow-timeout")
    await bus.connect()
    try:
        async with _task_session() as session:
            stmt = select(WorkflowInstance).where(
                WorkflowInstance.status.in_(
                    [InstanceStatus.ACTIVE.value, InstanceStatus.PAUSED.value]
                ),
                WorkflowInstance.state_entered_at < cutoff,
            )
            for inst in (await session.execute(stmt)).scalars().all():
                inst.status = InstanceStatus.CANCELLED.value
                inst.closed_at = utcnow()
                inst.outcome = "instance_timeout"
                inst.updated_at = utcnow()
                cancelled += 1
                tid = str(inst.tenant_id) if inst.tenant_id else None
                await bus.publish(subject(tid, "workflow", "incident.timed_out"),
                                  {"tenant_id": tid, "instance_id": inst.instance_id,
                                   "cutoff_hours": timeout_hours})
            await session.commit()
    finally:
        await bus.close()
    if cancelled:
        log.info("timeout sweep: cancelled %d stale instance(s)", cancelled)
    return cancelled


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


# ── Dedup cleanup ──────────────────────────────────────────────────────


async def dedup_cleanup() -> int:
    """Delete expired correlation-dedup slots (``expires_at`` < now)."""
    now = utcnow()
    async with _task_session() as session:
        result = await session.execute(
            delete(CorrelationDedup).where(
                CorrelationDedup.expires_at.is_not(None),
                CorrelationDedup.expires_at < now,
            )
        )
        await session.commit()
    deleted = int(result.rowcount or 0)
    if deleted:
        log.info("dedup cleanup: removed %d expired slot(s)", deleted)
    return deleted


async def _resolve_channel_config(session, note) -> dict:
    """Find the tenant's enabled channel config for this notification's type."""
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
    return (row.config or {}) if row else {}


# ── Correlation consumer (long-running) ────────────────────────────────


async def run_correlation_consumer() -> None:
    """Start the correlation engine and block forever (Celery long-running task)."""
    import asyncio

    from .correlation import CorrelationEngine

    engine = CorrelationEngine()
    await engine.start()
    log.info("correlation consumer running")
    try:
        while True:
            await asyncio.sleep(3600)
    finally:
        await engine.close()


# ── Notify consumer (long-running) ─────────────────────────────────────


async def run_notify_consumer() -> None:
    """Start the notify-request consumer and block forever (Celery long-running).

    Drains ``tenant.*.notify.request`` / ``tenant.*.vms.popup`` into the
    notification outbox (email / webhook / push), which ``dispatch_notifications``
    then delivers. Kept separate from the correlation consumer (that one creates
    incidents; this one creates notifications).
    """
    from .notify_consumer import run_notify_consumer as _run

    await _run()
