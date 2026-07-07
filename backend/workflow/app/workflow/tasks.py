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
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kernel.events import EventBus, subject

from app.db import get_engine
from .connectors import registry
from .connectors.base import DeliveryContext
from .models import (
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


def _sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_engine(), expire_on_commit=False, class_=AsyncSession)


# ── Escalation sweep ───────────────────────────────────────────────────


async def escalation_sweep() -> int:
    """Scan active/paused instances for SLA breaches + escalations. Idempotent."""
    now = utcnow()
    changed = 0
    bus = EventBus(source="workflow-escalation")
    await bus.connect()
    sm = _sessionmaker()
    try:
        async with sm() as session:
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
            changed = True
            cur = new_pri
    return changed


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
    sm = _sessionmaker()
    try:
        async with sm() as session:
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
    """Drain pending notifications through the pluggable connector registry."""
    sent = 0
    sm = _sessionmaker()
    async with sm() as session:
        stmt = (
            select(Notification)
            .where(Notification.status == "pending")
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
                note.error = None
                sent += 1
            except Exception as exc:  # keep pending for retry unless capped
                note.error = str(exc)
                note.status = "pending" if note.attempts < MAX_NOTIFY_ATTEMPTS else "failed"
                log.warning("notification %s dispatch failed (attempt %d): %s",
                            note.notification_id, note.attempts, exc)
            note.updated_at = utcnow()
        await session.commit()
    if sent:
        log.info("dispatched %d notification(s)", sent)
    return sent


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
