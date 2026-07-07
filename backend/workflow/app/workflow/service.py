"""Workflow services — scope-aware, one service per entity.

The v3 house style: each service holds the ``AsyncSession`` + the caller's
``Scope``, routes every read through ``scoped`` and every by-id fetch through
``assert_owned``, stamps new rows with ``scope.tenant_id``, and emits domain
events on the NATS spine.

Folds neubit_v2's repository + service split into single scope-aware services.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ConflictError, ValidationError

from .events import emit
from .models import (
    Form,
    Notification,
    NotificationChannel,
    NotificationTemplate,
    SOP,
    State,
    ThreatLevel,
    Transition,
    Trigger,
    WorkflowInstance,
)
from .shared import (
    CLOSED_STATUSES,
    InstancePriority,
    InstanceStatus,
    build_instance_context,
    is_legal_status_change,
    matches_conditions,
    utcnow,
    validate_form_data,
)
from .templating import build_notification_context, render_template

log = logging.getLogger("workflow.service")


def _actor_id(actor) -> str | None:
    """Best-effort user_id from a kernel Principal (or None)."""
    uid = getattr(actor, "user_id", None)
    return str(uid) if uid else None


# ── SOP ────────────────────────────────────────────────────────────────


class SopService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _row(self, sop_id: str) -> SOP:
        row = await self.db.get(SOP, sop_id)
        assert_owned(row, self.scope, message="SOP not found")
        return row

    async def create(self, body, *, actor) -> SOP:
        row = SOP(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            description=body.description,
            priority=body.priority.value,
            trigger_event_types=list(body.trigger_event_types),
            sla_hours=body.sla_hours,
            tags=list(body.tags),
            escalation_rules=[r.model_dump(mode="json") for r in body.escalation_rules],
            is_active=body.is_active,
            created_by=_actor_id(actor),
            updated_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        await emit(row.tenant_id, "sop", "created", {"sop_id": row.sop_id, "name": row.name})
        return row

    async def list_(self, *, skip=0, limit=50, is_active=None, tag=None):
        stmt = scoped(select(SOP), SOP, self.scope)
        count = scoped(select(func.count()).select_from(SOP), SOP, self.scope)
        if is_active is not None:
            stmt = stmt.where(SOP.is_active.is_(is_active))
            count = count.where(SOP.is_active.is_(is_active))
        stmt = stmt.order_by(SOP.created_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        if tag:
            rows = [r for r in rows if tag in (r.tags or [])]
        total = int(await self.db.scalar(count) or 0)
        return rows, total

    async def get(self, sop_id: str) -> SOP:
        return await self._row(sop_id)

    async def update(self, sop_id: str, body, *, actor) -> SOP:
        row = await self._row(sop_id)
        data = body.model_dump(exclude_none=True)
        if "priority" in data:
            data["priority"] = body.priority.value
        if "escalation_rules" in data and body.escalation_rules is not None:
            data["escalation_rules"] = [r.model_dump(mode="json") for r in body.escalation_rules]
        for k, v in data.items():
            setattr(row, k, v)
        row.version += 1
        row.updated_by = _actor_id(actor)
        row.updated_at = utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        await emit(row.tenant_id, "sop", "updated", {"sop_id": row.sop_id})
        return row

    async def delete(self, sop_id: str, *, actor) -> None:
        row = await self._row(sop_id)
        row.is_active = False
        row.updated_at = utcnow()
        await self.db.commit()
        await emit(row.tenant_id, "sop", "deleted", {"sop_id": row.sop_id})


# ── State ──────────────────────────────────────────────────────────────


class StateService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _sop(self, sop_id: str) -> SOP:
        row = await self.db.get(SOP, sop_id)
        assert_owned(row, self.scope, message="SOP not found")
        return row

    async def _row(self, state_id: str) -> State:
        row = await self.db.get(State, state_id)
        assert_owned(row, self.scope, message="State not found")
        return row

    async def list_(self, sop_id: str) -> list[State]:
        await self._sop(sop_id)
        stmt = scoped(select(State).where(State.sop_id == sop_id), State, self.scope)
        stmt = stmt.order_by(State.order.asc(), State.created_at.asc())
        return list((await self.db.execute(stmt)).scalars().all())

    async def create(self, sop_id: str, body, *, actor) -> State:
        sop = await self._sop(sop_id)
        if body.is_initial:
            await self._clear_initial(sop_id)
        row = State(
            tenant_id=self.scope.tenant_id,
            sop_id=sop_id,
            name=body.name,
            description=body.description,
            color=body.color,
            position_x=body.position_x,
            position_y=body.position_y,
            is_initial=body.is_initial,
            is_terminal=body.is_terminal,
            is_cancellation=body.is_cancellation,
            sla_hours=body.sla_hours,
            entry_actions=list(body.entry_actions),
            exit_actions=list(body.exit_actions),
            required_role_ids=list(body.required_role_ids),
            order=body.order,
            created_by=_actor_id(actor),
            updated_by=_actor_id(actor),
        )
        self.db.add(row)
        if body.is_initial:
            sop.initial_state = row.state_id
        await self.db.commit()
        await self.db.refresh(row)
        await emit(row.tenant_id, "state", "created", {"sop_id": sop_id, "state_id": row.state_id})
        return row

    async def update(self, state_id: str, body, *, actor) -> State:
        row = await self._row(state_id)
        data = body.model_dump(exclude_none=True)
        if data.get("is_initial"):
            await self._clear_initial(row.sop_id, keep=state_id)
            sop = await self.db.get(SOP, row.sop_id)
            if sop:
                sop.initial_state = state_id
        for k, v in data.items():
            setattr(row, k, v)
        row.updated_by = _actor_id(actor)
        row.updated_at = utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        await emit(row.tenant_id, "state", "updated", {"state_id": row.state_id})
        return row

    async def delete(self, state_id: str) -> None:
        row = await self._row(state_id)
        await self.db.delete(row)
        await self.db.commit()
        await emit(self.scope.tenant_id, "state", "deleted", {"state_id": state_id})

    async def _clear_initial(self, sop_id: str, keep: str | None = None) -> None:
        stmt = scoped(
            select(State).where(State.sop_id == sop_id, State.is_initial.is_(True)),
            State, self.scope,
        )
        for s in (await self.db.execute(stmt)).scalars().all():
            if keep and s.state_id == keep:
                continue
            s.is_initial = False

    async def find_initial(self, sop_id: str) -> State | None:
        stmt = select(State).where(State.sop_id == sop_id, State.is_initial.is_(True)).limit(1)
        return (await self.db.execute(stmt)).scalars().first()


# ── Transition ─────────────────────────────────────────────────────────


class TransitionService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _sop(self, sop_id: str) -> SOP:
        row = await self.db.get(SOP, sop_id)
        assert_owned(row, self.scope, message="SOP not found")
        return row

    async def _row(self, transition_id: str) -> Transition:
        row = await self.db.get(Transition, transition_id)
        assert_owned(row, self.scope, message="Transition not found")
        return row

    async def list_(self, sop_id: str) -> list[Transition]:
        await self._sop(sop_id)
        stmt = scoped(select(Transition).where(Transition.sop_id == sop_id), Transition, self.scope)
        return list((await self.db.execute(stmt.order_by(Transition.created_at.asc()))).scalars().all())

    async def create(self, sop_id: str, body, *, actor) -> Transition:
        await self._sop(sop_id)
        row = Transition(
            tenant_id=self.scope.tenant_id,
            sop_id=sop_id,
            from_state_id=body.from_state_id,
            to_state_id=body.to_state_id,
            label=body.label,
            description=body.description,
            requires_note=body.requires_note,
            confirmation_required=body.confirmation_required,
            required_role_ids=list(body.required_role_ids),
            form_id=body.form_id,
            conditions=[c.model_dump(mode="json") for c in body.conditions],
            notification_config=body.notification_config,
            created_by=_actor_id(actor),
            updated_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        await emit(row.tenant_id, "transition", "created",
                   {"sop_id": sop_id, "transition_id": row.transition_id})
        return row

    async def update(self, transition_id: str, body, *, actor) -> Transition:
        row = await self._row(transition_id)
        data = body.model_dump(exclude_none=True)
        if "conditions" in data and body.conditions is not None:
            data["conditions"] = [c.model_dump(mode="json") for c in body.conditions]
        for k, v in data.items():
            setattr(row, k, v)
        row.updated_by = _actor_id(actor)
        row.updated_at = utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        await emit(row.tenant_id, "transition", "updated", {"transition_id": row.transition_id})
        return row

    async def delete(self, transition_id: str) -> None:
        row = await self._row(transition_id)
        await self.db.delete(row)
        await self.db.commit()
        await emit(self.scope.tenant_id, "transition", "deleted", {"transition_id": transition_id})


# ── Trigger ────────────────────────────────────────────────────────────


class TriggerService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _row(self, trigger_id: str) -> Trigger:
        row = await self.db.get(Trigger, trigger_id)
        assert_owned(row, self.scope, message="Trigger not found")
        return row

    async def create(self, body, *, actor) -> Trigger:
        sop = await self.db.get(SOP, body.sop_id)
        assert_owned(sop, self.scope, message="SOP not found")
        row = Trigger(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            description=body.description,
            sop_id=body.sop_id,
            event_source=body.event_source,
            event_type=body.event_type,
            conditions=[c.model_dump(mode="json") for c in body.conditions],
            dedup=body.dedup.model_dump(mode="json"),
            priority=body.priority.value,
            auto_assign=body.auto_assign,
            assign_users=list(body.assign_users),
            enabled=body.enabled,
            created_by=_actor_id(actor),
            updated_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        await emit(row.tenant_id, "trigger", "created", {"trigger_id": row.trigger_id})
        return row

    async def list_(self, *, skip=0, limit=50, enabled=None, event_type=None):
        stmt = scoped(select(Trigger), Trigger, self.scope)
        count = scoped(select(func.count()).select_from(Trigger), Trigger, self.scope)
        if enabled is not None:
            stmt = stmt.where(Trigger.enabled.is_(enabled))
            count = count.where(Trigger.enabled.is_(enabled))
        if event_type:
            stmt = stmt.where(Trigger.event_type == event_type)
            count = count.where(Trigger.event_type == event_type)
        stmt = stmt.order_by(Trigger.created_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count) or 0)
        return rows, total

    async def get(self, trigger_id: str) -> Trigger:
        return await self._row(trigger_id)

    async def update(self, trigger_id: str, body, *, actor) -> Trigger:
        row = await self._row(trigger_id)
        data = body.model_dump(exclude_none=True)
        if "priority" in data:
            data["priority"] = body.priority.value
        if "conditions" in data and body.conditions is not None:
            data["conditions"] = [c.model_dump(mode="json") for c in body.conditions]
        if "dedup" in data and body.dedup is not None:
            data["dedup"] = body.dedup.model_dump(mode="json")
        for k, v in data.items():
            setattr(row, k, v)
        row.updated_by = _actor_id(actor)
        row.updated_at = utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        await emit(row.tenant_id, "trigger", "updated", {"trigger_id": row.trigger_id})
        return row

    async def delete(self, trigger_id: str) -> None:
        row = await self._row(trigger_id)
        await self.db.delete(row)
        await self.db.commit()
        await emit(self.scope.tenant_id, "trigger", "deleted", {"trigger_id": trigger_id})


# ── Form ───────────────────────────────────────────────────────────────


class FormService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _row(self, form_id: str) -> Form:
        row = await self.db.get(Form, form_id)
        assert_owned(row, self.scope, message="Form not found")
        return row

    async def create(self, body, *, actor) -> Form:
        row = Form(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            description=body.description,
            fields=[f.model_dump(mode="json") for f in body.fields],
            is_active=body.is_active,
            created_by=_actor_id(actor),
            updated_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def list_(self, *, skip=0, limit=50, is_active=None):
        stmt = scoped(select(Form), Form, self.scope)
        count = scoped(select(func.count()).select_from(Form), Form, self.scope)
        if is_active is not None:
            stmt = stmt.where(Form.is_active.is_(is_active))
            count = count.where(Form.is_active.is_(is_active))
        stmt = stmt.order_by(Form.created_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count) or 0)
        return rows, total

    async def get(self, form_id: str) -> Form:
        return await self._row(form_id)

    async def update(self, form_id: str, body, *, actor) -> Form:
        row = await self._row(form_id)
        data = body.model_dump(exclude_none=True)
        if "fields" in data and body.fields is not None:
            data["fields"] = [f.model_dump(mode="json") for f in body.fields]
        for k, v in data.items():
            setattr(row, k, v)
        row.updated_by = _actor_id(actor)
        row.updated_at = utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def delete(self, form_id: str) -> None:
        row = await self._row(form_id)
        row.is_active = False
        row.updated_at = utcnow()
        await self.db.commit()


# ── Notification templates + channels ──────────────────────────────────


class NotificationService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    # -- templates --
    async def _template(self, template_id: str) -> NotificationTemplate:
        row = await self.db.get(NotificationTemplate, template_id)
        assert_owned(row, self.scope, message="Template not found")
        return row

    async def create_template(self, body, *, actor) -> NotificationTemplate:
        row = NotificationTemplate(
            tenant_id=self.scope.tenant_id, name=body.name, description=body.description,
            channel_type=body.channel_type, subject=body.subject, body=body.body,
            is_active=body.is_active, created_by=_actor_id(actor), updated_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def list_templates(self, *, skip=0, limit=50):
        stmt = scoped(select(NotificationTemplate), NotificationTemplate, self.scope)
        count = scoped(select(func.count()).select_from(NotificationTemplate), NotificationTemplate, self.scope)
        stmt = stmt.order_by(NotificationTemplate.created_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count) or 0)
        return rows, total

    async def update_template(self, template_id: str, body, *, actor) -> NotificationTemplate:
        row = await self._template(template_id)
        for k, v in body.model_dump(exclude_none=True).items():
            setattr(row, k, v)
        row.updated_by = _actor_id(actor)
        row.updated_at = utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def delete_template(self, template_id: str) -> None:
        row = await self._template(template_id)
        await self.db.delete(row)
        await self.db.commit()

    # -- channels --
    async def _channel(self, channel_id: str) -> NotificationChannel:
        row = await self.db.get(NotificationChannel, channel_id)
        assert_owned(row, self.scope, message="Channel not found")
        return row

    async def create_channel(self, body, *, actor) -> NotificationChannel:
        row = NotificationChannel(
            tenant_id=self.scope.tenant_id, name=body.name, channel_type=body.channel_type,
            config=body.config, is_enabled=body.is_enabled, is_default=body.is_default,
            created_by=_actor_id(actor), updated_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def list_channels(self, *, skip=0, limit=50):
        stmt = scoped(select(NotificationChannel), NotificationChannel, self.scope)
        count = scoped(select(func.count()).select_from(NotificationChannel), NotificationChannel, self.scope)
        stmt = stmt.order_by(NotificationChannel.created_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count) or 0)
        return rows, total

    async def update_channel(self, channel_id: str, body, *, actor) -> NotificationChannel:
        row = await self._channel(channel_id)
        for k, v in body.model_dump(exclude_none=True).items():
            setattr(row, k, v)
        row.updated_by = _actor_id(actor)
        row.updated_at = utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def delete_channel(self, channel_id: str) -> None:
        row = await self._channel(channel_id)
        await self.db.delete(row)
        await self.db.commit()


# ── Threat level ───────────────────────────────────────────────────────


class ThreatLevelService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def get_current(self, *, site_id: str | None = None) -> ThreatLevel | None:
        stmt = scoped(select(ThreatLevel), ThreatLevel, self.scope)
        if site_id is None:
            stmt = stmt.where(ThreatLevel.site_id.is_(None))
        else:
            stmt = stmt.where(ThreatLevel.site_id == site_id)
        return (await self.db.execute(stmt.limit(1))).scalars().first()

    async def list_(self) -> list[ThreatLevel]:
        stmt = scoped(select(ThreatLevel), ThreatLevel, self.scope).order_by(ThreatLevel.set_at.desc())
        return list((await self.db.execute(stmt)).scalars().all())

    async def set_level(self, body, *, actor) -> ThreatLevel:
        row = await self.get_current(site_id=body.site_id)
        now = utcnow()
        prev = row.level if row else "normal"
        if row is None:
            row = ThreatLevel(
                tenant_id=self.scope.tenant_id, site_id=body.site_id, level=body.level.value,
                reason=body.reason, set_by=_actor_id(actor), set_at=now, history=[],
            )
            self.db.add(row)
        else:
            row.level = body.level.value
            row.reason = body.reason
            row.set_by = _actor_id(actor)
            row.set_at = now
            row.history = (row.history or []) + [{
                "from_level": prev, "to_level": body.level.value,
                "reason": body.reason, "set_by": _actor_id(actor), "set_at": now.isoformat(),
            }]
            row.updated_at = now
        await self.db.commit()
        await self.db.refresh(row)
        # Distinct event so the correlation engine can match posture changes.
        await emit(row.tenant_id, "threat_level", "changed",
                   {"site_id": body.site_id, "from_level": prev, "to_level": body.level.value})
        return row


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
                    sop_id=None, assigned_to=None):
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
        stmt = stmt.order_by(WorkflowInstance.created_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count) or 0)
        return rows, total

    async def get(self, instance_id: str) -> WorkflowInstance:
        return await self._row(instance_id)

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
