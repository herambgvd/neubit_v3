"""SOP / state / transition services — CRUD over the playbook graph.

Three service classes, one module, because they are one feature and one of them
writes another's table: creating, promoting or deleting a state clears another
state's ``is_initial`` and re-derives ``SOP.initial_state`` (see
``StateService._sync_pointer``). Splitting them apart would put that two-table
write on opposite sides of an import.

NOT a reason, though it was claimed as one here until the tests went looking:
deleting a SOP does NOT cascade. ``SopService.delete`` is a SOFT delete -- it sets
``is_active = False`` and leaves every state and transition exactly where they
are, which is what makes an incident already running on that SOP still resolvable.
There are no foreign keys in this schema at all.
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
        stmt = stmt.order_by(SOP.created_at.desc())
        if tag:
            # ``tags`` is a portable JSON column — the same model has to work on
            # Postgres and on SQLite — so there is no containment operator to push
            # this into SQL. It used to be filtered in Python AFTER offset/limit and
            # was never applied to the count, so a tagged listing returned at most
            # one page's worth of matches and a ``total`` for the UNTAGGED set: page
            # 2 could come back empty while ``total`` promised more. Filtering the
            # whole scoped set and paging THAT is what makes the two agree, at the
            # cost of reading a table that is an operator-authored set of tens —
            # the same trade ``AlertFormatService.find_by_code`` already makes.
            matched = [r for r in (await self.db.execute(stmt)).scalars().all()
                       if tag in (r.tags or [])]
            return matched[skip:skip + limit], len(matched)
        rows = (await self.db.execute(stmt.offset(skip).limit(limit))).scalars().all()
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
        await self._sync_pointer(sop)
        await self.db.commit()
        await self.db.refresh(row)
        await emit(row.tenant_id, "state", "created", {"sop_id": sop_id, "state_id": row.state_id})
        return row

    async def update(self, state_id: str, body, *, actor) -> State:
        row = await self._row(state_id)
        data = body.model_dump(exclude_none=True)
        if data.get("is_initial"):
            await self._clear_initial(row.sop_id, keep=state_id)
        for k, v in data.items():
            setattr(row, k, v)
        row.updated_by = _actor_id(actor)
        row.updated_at = utcnow()
        await self._sync_pointer(await self._sop(row.sop_id))
        await self.db.commit()
        await self.db.refresh(row)
        await emit(row.tenant_id, "state", "updated", {"state_id": row.state_id})
        return row

    async def delete(self, state_id: str) -> None:
        row = await self._row(state_id)
        sop_id = row.sop_id
        await self.db.delete(row)
        await self._sync_pointer(await self._sop(sop_id))
        await self.db.commit()
        await emit(self.scope.tenant_id, "state", "deleted", {"state_id": state_id})

    async def _sync_pointer(self, sop: SOP) -> None:
        """Recompute ``SOP.initial_state`` from the state actually flagged is_initial.

        DERIVED, never assigned. The old code assigned it from whatever the caller
        was holding, which on the create path was a State not yet INSERTed — so
        ``state_id`` was still None (it comes from a column default) and creating
        an initial state set the pointer to NULL, wiping a correct one. Three
        methods each having to remember the right value is the shape of that bug;
        one method reading the flag back cannot produce a value the flag disagrees
        with, whatever the caller did.

        The flush is load-bearing twice over: it gives a pending State its id, and
        it applies a pending delete, so the flag we read back is the one the row
        will actually have after the commit.
        """
        await self.db.flush()
        initial = await self.find_initial(sop.sop_id)
        sop.initial_state = initial.state_id if initial else None

    async def _clear_initial(self, sop_id: str, keep: str | None = None) -> None:
        """Demote every other initial state of this SOP, and FLUSH the demotion.

        The flush orders the demoting UPDATE before the promoting INSERT/UPDATE
        that follows it. Without it SQLAlchemy is free to emit them in either
        order within one flush, and ``uq_workflow_states_one_initial_per_sop``
        would reject the promotion of a state that is about to be the only one.
        """
        stmt = scoped(
            select(State).where(State.sop_id == sop_id, State.is_initial.is_(True)),
            State, self.scope,
        )
        demoted = False
        for s in (await self.db.execute(stmt)).scalars().all():
            if keep and s.state_id == keep:
                continue
            s.is_initial = False
            demoted = True
        if demoted:
            await self.db.flush()

    async def find_initial(self, sop_id: str) -> State | None:
        """The caller's initial state for this SOP, or None.

        ``scoped`` for the same reason ``_clear_initial`` is: a state row carrying
        a foreign tenant_id is corruption, and the pointer this feeds must not be
        made to name it.
        """
        stmt = scoped(
            select(State).where(State.sop_id == sop_id, State.is_initial.is_(True)),
            State, self.scope,
        )
        return (await self.db.execute(stmt.limit(1))).scalars().first()


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


