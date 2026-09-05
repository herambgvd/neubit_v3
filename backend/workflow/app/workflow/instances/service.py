"""Instance service — the running incident, and the state machine that moves it.

This is the one service that reads across features, and the direction is
deliberate: an incident is an instance OF a SOP, executes ITS transitions,
captures a FORM on the way through, and enqueues NOTIFICATIONS when it lands.
Nothing in ``sops``, ``forms`` or ``notifications`` imports back, so the graph
stays one-directional and acyclic.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ConflictError, ValidationError

from ..core.actor import actor_id as _actor_id
from ..core.enums import (
    CLOSED_STATUSES,
    InstancePriority,
    InstanceStatus,
    is_legal_status_change,
)
from ..core.matching import build_instance_context, matches_conditions
from ..core.primitives import utcnow
from ..forms.models import Form
from ..forms.validation import validate_form_data
from ..notifications.models import Notification, NotificationTemplate
from ..notifications.templating import build_notification_context, render_template
from ..runtime.events import emit
from ..sops.models import SOP, State, Transition
from .models import WorkflowInstance

log = logging.getLogger("workflow.instances.service")


# ── Workflow instance (the state machine) ──────────────────────────────


class InstanceService:
    """The running-incident state machine: create, transition, assign, escalate."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _row(self, instance_id: str) -> WorkflowInstance:
        row = await self.db.get(WorkflowInstance, instance_id)
        assert_owned(row, self.scope, message="Workflow instance not found")
        return row

    async def _initial_state(self, sop_id: str) -> State | None:
        stmt = select(State).where(State.sop_id == sop_id, State.is_initial.is_(True)).limit(1)
        return (await self.db.execute(stmt)).scalars().first()

    async def create(self, body, *, actor) -> WorkflowInstance:
        sop = await self.db.get(SOP, body.sop_id)
        assert_owned(sop, self.scope, message="SOP not found")
        initial = await self._initial_state(sop.sop_id)
        if not initial:
            raise ConflictError("SOP has no initial state defined")

        priority = (body.priority.value if body.priority else sop.priority)
        now = utcnow()
        sla_deadline = now + timedelta(hours=sop.sla_hours) if sop.sla_hours else None
        row = WorkflowInstance(
            tenant_id=self.scope.tenant_id,
            sop_id=sop.sop_id, sop_name=sop.name, sop_version=sop.version,
            name=body.name or f"{sop.name}: {body.event_type or 'manual'}",
            description=body.description, priority=priority, site_id=body.site_id,
            current_state=initial.state_id, current_state_name=initial.name,
            status=InstanceStatus.ACTIVE.value,
            trigger_data=body.trigger_data, event_id=body.event_id, event_type=body.event_type,
            sla_hours=sop.sla_hours, sla_deadline=sla_deadline, state_entered_at=now,
            tags=list(body.tags), timeline=[], extra=body.metadata,
            created_by=_actor_id(actor), updated_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        await emit(row.tenant_id, "incident", "created", {
            "instance_id": row.instance_id, "sop_id": sop.sop_id,
            "priority": row.priority, "state": row.current_state_name,
        })
        return row

    async def list_(self, *, skip=0, limit=50, status=None, priority=None, site_id=None,
                    sop_id=None, assigned_to=None, q=None, event_id=None, source=None):
        stmt = scoped(select(WorkflowInstance), WorkflowInstance, self.scope)
        count = scoped(select(func.count()).select_from(WorkflowInstance), WorkflowInstance, self.scope)
        for col, val in [
            (WorkflowInstance.status, status),
            (WorkflowInstance.priority, priority),
            (WorkflowInstance.site_id, site_id),
            (WorkflowInstance.sop_id, sop_id),
            (WorkflowInstance.assigned_to, assigned_to),
        ]:
            if val is not None:
                stmt = stmt.where(col == val)
                count = count.where(col == val)
        # event_id — the CROSS-LINK key from a camera event. A camera event's own id
        # (VmsEvent.id) rides in the envelope PAYLOAD (trigger_data.payload.event_id),
        # while WorkflowInstance.event_id holds the bus envelope UUID (a different id).
        # So match EITHER identifier so a lookup by a camera-event id finds the
        # incident it spawned, and a lookup by the envelope id also works.
        if event_id is not None:
            link = or_(
                WorkflowInstance.event_id == event_id,
                WorkflowInstance.trigger_data["payload"]["event_id"].as_string() == event_id,
            )
            stmt = stmt.where(link)
            count = count.where(link)
        # source — the ORIGINATING domain (the EventBus source tag stored on the
        # envelope): "vision" (camera events), "access", "ingest", … The UI groups
        # camera-ish sources under "Camera". "manual" matches operator-raised
        # incidents (created via POST /instances → extra.source == "manual", no
        # trigger envelope).
        if source is not None:
            if source == "manual":
                # Operator-raised incidents have no originating-event envelope, so no
                # domain source tag. A JSON column set to Python None stores JSON
                # 'null' (not SQL NULL), so extracting .source yields NULL — that's
                # the portable "no envelope source" test (also matches an envelope
                # that carries no source). extra.source == 'manual' is the explicit
                # opt-in if a create ever stamps it.
                src = or_(
                    WorkflowInstance.trigger_data["source"].as_string().is_(None),
                    WorkflowInstance.extra["source"].as_string() == "manual",
                )
            else:
                src = WorkflowInstance.trigger_data["source"].as_string() == source
            stmt = stmt.where(src)
            count = count.where(src)
        # Full-text-ish search over the incident name + its SOP name (v2 parity).
        if q:
            like = f"%{q.strip()}%"
            search = or_(WorkflowInstance.name.ilike(like), WorkflowInstance.sop_name.ilike(like))
            stmt = stmt.where(search)
            count = count.where(search)
        stmt = stmt.order_by(WorkflowInstance.created_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count) or 0)
        return rows, total

    async def get(self, instance_id: str) -> WorkflowInstance:
        return await self._row(instance_id)

    async def render_pdf(self, instance_id: str) -> bytes:
        """Render the incident report PDF for a tenant-owned instance."""
        from .pdf import render_incident_pdf

        inst = await self._row(instance_id)
        sop = await self.db.get(SOP, inst.sop_id)
        return render_incident_pdf(inst, sop=sop)

    async def stats(self, *, site_id=None) -> dict:
        """Incident counts grouped by status and by priority for the tenant scope.

        Returns ``{by_status: {...}, by_priority: {...}, total: N}`` with every
        known status/priority key present (zero-filled) so the frontend strip is
        stable regardless of which buckets currently have rows.
        """
        base = scoped(select(WorkflowInstance), WorkflowInstance, self.scope)
        if site_id is not None:
            base = base.where(WorkflowInstance.site_id == site_id)
        sub = base.subquery()

        by_status = {s.value: 0 for s in InstanceStatus}
        status_stmt = select(sub.c.status, func.count()).group_by(sub.c.status)
        for value, count in (await self.db.execute(status_stmt)).all():
            by_status[str(value)] = int(count)

        by_priority = {p.value: 0 for p in InstancePriority}
        priority_stmt = select(sub.c.priority, func.count()).group_by(sub.c.priority)
        for value, count in (await self.db.execute(priority_stmt)).all():
            by_priority[str(value)] = int(count)

        total = sum(by_status.values())
        # Convenience alias — "completed" is the v2 name some UIs use for resolved.
        by_status["completed"] = by_status[InstanceStatus.RESOLVED.value]
        return {"by_status": by_status, "by_priority": by_priority, "total": total}

    async def get_available_transitions(self, instance_id: str) -> list[Transition]:
        inst = await self._row(instance_id)
        if inst.status != InstanceStatus.ACTIVE.value or not inst.current_state:
            return []
        stmt = select(Transition).where(
            Transition.sop_id == inst.sop_id,
            Transition.from_state_id == inst.current_state,
        )
        rows = list((await self.db.execute(stmt)).scalars().all())
        # Gate on each transition's conditions against the instance context.
        # Empty conditions (None / []) always pass (matches_conditions contract).
        ctx = build_instance_context(inst)
        return [t for t in rows if matches_conditions(ctx, t.conditions or [])]

    async def transition(self, instance_id: str, body, *, actor, actor_name=None) -> WorkflowInstance:
        inst = await self._row(instance_id)
        if InstanceStatus(inst.status) in CLOSED_STATUSES:
            raise ConflictError("Cannot mutate a closed instance")

        trans = await self.db.get(Transition, body.transition_id)
        if (not trans or trans.sop_id != inst.sop_id
                or trans.from_state_id != inst.current_state):
            raise ConflictError("Transition not valid for the instance's current state")
        if trans.requires_note and not (body.notes and body.notes.strip()):
            raise ValidationError("Transition requires a note")

        # Gate: the transition's conditions must be satisfied by the instance context.
        # Empty conditions always pass; a failing gate is a 409 (state precondition).
        if trans.conditions:
            ctx = build_instance_context(inst)
            if not matches_conditions(ctx, trans.conditions):
                raise ConflictError("Transition conditions are not satisfied")

        from_state = await self.db.get(State, trans.from_state_id)
        to_state = await self.db.get(State, trans.to_state_id)
        if not from_state or not to_state:
            raise ConflictError("Transition endpoints missing")

        # Validate submitted form_data against the transition's form definition.
        form_labels = None
        if trans.form_id:
            form = await self.db.get(Form, trans.form_id)
            if form and form.fields:
                form_errors = validate_form_data(form.fields, body.form_data)
                if form_errors:
                    raise ValidationError(
                        "Form validation failed", details={"fields": form_errors}
                    )
                if body.form_data:
                    form_labels = {
                        str(f.get("id")): f.get("label")
                        for f in form.fields if str(f.get("id")) in body.form_data
                    } or None

        now = utcnow()
        entry = {
            "transition_id": trans.transition_id, "transition_name": trans.label,
            "from_state_id": from_state.state_id, "from_state_name": from_state.name,
            "to_state_id": to_state.state_id, "to_state_name": to_state.name,
            "executed_by": _actor_id(actor) or "system", "executed_by_name": actor_name,
            "notes": body.notes, "form_data": body.form_data, "form_labels": form_labels,
            "executed_at": now.isoformat(),
        }
        inst.timeline = (inst.timeline or []) + [entry]
        inst.current_state = to_state.state_id
        inst.current_state_name = to_state.name
        inst.state_entered_at = now
        inst.updated_at = now
        inst.updated_by = _actor_id(actor)
        # Terminal states close the instance.
        if to_state.is_cancellation:
            inst.status = InstanceStatus.CANCELLED.value
            inst.closed_at = now
        elif to_state.is_terminal:
            inst.status = InstanceStatus.RESOLVED.value
            inst.closed_at = now
        await self.db.commit()
        await self.db.refresh(inst)

        await emit(inst.tenant_id, "incident", "transitioned", {
            "instance_id": inst.instance_id,
            "from_state_id": from_state.state_id, "to_state_id": to_state.state_id,
            "transition_id": trans.transition_id, "status": inst.status,
        })
        # Best-effort: enqueue transition notifications (never blocks the transition).
        try:
            await self._enqueue_transition_notifications(inst, trans, from_state.name, to_state.name)
        except Exception as exc:  # pragma: no cover
            log.warning("transition notification enqueue failed for %s: %s", instance_id, exc)
        return inst

    async def assign(self, instance_id: str, body, *, actor) -> WorkflowInstance:
        inst = await self._row(instance_id)
        if InstanceStatus(inst.status) in CLOSED_STATUSES:
            raise ConflictError("Cannot mutate a closed instance")
        now = utcnow()
        inst.assigned_to = body.assigned_to
        inst.assignment = {
            "assigned_to": body.assigned_to, "assigned_to_name": body.assigned_to_name,
            "assigned_role": body.assigned_role, "assigned_role_name": body.assigned_role_name,
            "assigned_at": now.isoformat(),
        }
        inst.updated_at = now
        inst.updated_by = _actor_id(actor)
        await self.db.commit()
        await self.db.refresh(inst)
        await emit(inst.tenant_id, "incident", "assigned",
                   {"instance_id": inst.instance_id, "assigned_to": body.assigned_to})
        return inst

    async def change_status(self, instance_id: str, body, *, actor) -> WorkflowInstance:
        inst = await self._row(instance_id)
        current = InstanceStatus(inst.status)
        if current in CLOSED_STATUSES:
            raise ConflictError("Cannot mutate a closed instance")
        # Enforce the legal status machine (PENDING→ACTIVE→PAUSED↔ACTIVE→RESOLVED/
        # CANCELLED; terminal states can't change). A no-op is allowed.
        if not is_legal_status_change(current, body.status):
            raise ConflictError(
                f"Illegal status change: {current.value} → {body.status.value}"
            )
        now = utcnow()
        inst.status = body.status.value
        if body.outcome:
            inst.outcome = body.outcome
        if InstanceStatus(body.status) in CLOSED_STATUSES:
            inst.closed_at = now
        inst.updated_at = now
        inst.updated_by = _actor_id(actor)
        await self.db.commit()
        await self.db.refresh(inst)
        await emit(inst.tenant_id, "incident", "status_changed",
                   {"instance_id": inst.instance_id, "status": body.status.value})
        return inst

    async def escalate(self, instance_id: str, body, *, actor) -> WorkflowInstance:
        inst = await self._row(instance_id)
        if InstanceStatus(inst.status) in CLOSED_STATUSES:
            raise ConflictError("Cannot mutate a closed instance")
        now = utcnow()
        level = ((inst.escalation or {}).get("level", 0)) + 1
        inst.escalation = {
            "level": level, "escalated_at": now.isoformat(),
            "escalated_by": _actor_id(actor), "reason": body.reason,
        }
        inst.updated_at = now
        await self.db.commit()
        await self.db.refresh(inst)
        await emit(inst.tenant_id, "incident", "escalated",
                   {"instance_id": inst.instance_id, "level": level, "reason": body.reason})
        return inst

    async def _enqueue_transition_notifications(self, inst, trans, from_name, to_name) -> None:
        cfg = trans.notification_config or {}
        ntype = cfg.get("type", "none")
        if ntype == "none":
            return

        # Render context exposed to templates (and .format fallback below).
        render_ctx = build_notification_context(
            inst, from_state=from_name, to_state=to_name, sop_name=inst.sop_name
        )

        # If a NotificationTemplate is referenced, render its subject/body with
        # Jinja2. Otherwise fall back to the inline config strings (or a default),
        # rendered through Jinja2 too so {{ }} placeholders work uniformly.
        template = None
        template_id = cfg.get("template_id")
        if template_id:
            template = await self.db.get(NotificationTemplate, template_id)
            # Scope guard: only use a template the caller's tenant owns.
            if template is not None and template.tenant_id not in (None, inst.tenant_id):
                template = None

        if template is not None:
            subject = render_template(template.subject, render_ctx)
            body_text = render_template(template.body, render_ctx)
        else:
            subject_src = cfg.get("email_subject") or "[{{ priority|upper }}] {{ instance_name }}"
            body_src = cfg.get("email_body") or (
                "Incident {{ instance_name }} moved from {{ from_state }} "
                "to {{ to_state }}."
            )
            subject = render_template(subject_src, render_ctx)
            body_text = render_template(body_src, render_ctx)

        # Recipients: explicit addresses in the config (user resolution lives in core).
        default_channel = "email" if ntype in ("email", "both") else "webhook"
        for addr in cfg.get("recipients", []) or []:
            channel_type = (
                template.channel_type if template is not None else default_channel
            )
            self.db.add(Notification(
                tenant_id=inst.tenant_id, channel_type=channel_type, recipient=addr,
                subject=subject, body=body_text, status="pending",
                instance_id=inst.instance_id,
                extra={"transition_id": trans.transition_id,
                       "template_id": template_id if template is not None else None},
            ))
        await self.db.commit()


