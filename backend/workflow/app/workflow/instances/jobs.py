"""Scheduled jobs over incidents — the escalation and timeout sweeps.

Async bodies for two of the workflow worker's beat tasks (``app.worker`` wraps
each in ``asyncio.run``). They live with the instances feature, not in a flat
``tasks`` module, because what they do IS the incident lifecycle: an SLA breach,
a state timeout and a SOP escalation rule are the same state machine the service
drives from a request, moved by the clock instead of an operator. Reading
``instances/service.py`` without these is reading half of it.

Both are idempotent by construction — re-running a sweep re-derives the same
decision from the row, so a Celery redelivery cannot double-escalate.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta

from sqlalchemy import select

from kernel.events import EventBus, subject

from ..core.enums import PRIORITY_ORDER, InstancePriority, InstanceStatus, bump_priority
from ..core.primitives import utcnow
from ..notifications.models import Notification
from ..runtime.session import task_session as _task_session
from ..sops.models import SOP, State
from .models import WorkflowInstance

log = logging.getLogger("workflow.instances.jobs")

DEFAULT_INSTANCE_TIMEOUT_HOURS = int(os.getenv("VE_WORKFLOW_INSTANCE_TIMEOUT_HOURS", "72"))


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

