"""SOP / state / transition services — CRUD over the playbook graph.

Three service classes, one module, because they are one feature and they enforce
each other's invariants: creating a state can clear another state's ``is_initial``
and re-point ``SOP.initial_state``; deleting a SOP cascades to both child tables.
Splitting them apart would put those writes on opposite sides of an import.
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped

from ..core.actor import actor_id as _actor_id
from ..core.primitives import utcnow
from ..runtime.events import emit
from .models import SOP, State, Transition


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


