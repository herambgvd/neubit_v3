"""SOP / state / transition services — CRUD over the playbook graph.

Three classes in one module because one writes another's table: creating,
promoting or deleting a state clears another state's ``is_initial`` and re-derives
``SOP.initial_state`` (``StateService._sync_pointer``).

``SopService.delete`` is a SOFT delete and does not cascade — states and
transitions stay, so an incident already running on that SOP is still resolvable.
There are no foreign keys in this schema.
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped

from ..core.actor import actor_id as _actor_id
from ..core.primitives import utcnow
from ..runtime.events import emit
from .models import SOP, State, Transition
from .starters import (
    STARTERS,
    STARTER_TAG,
    position_of,
    slug_tag,
    starter_states,
    starter_transitions,
)


# ── SOP ────────────────────────────────────────────────────────────────


class SopService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _row(self, sop_id: str, *, for_write: bool = False) -> SOP:
        """The row, refusing a PLATFORM row when this is a write.

        `owns()` treats a NULL tenant_id as readable by everyone, which is right
        for a shared catalog a tenant may USE. It is not right for `update` and
        `delete`, which reach the same row through this helper: a tenant could
        rewrite or deactivate a platform SOP that every other tenant runs on.
        `for_write` is what separates the two.
        """
        row = await self.db.get(SOP, sop_id)
        assert_owned(row, self.scope, message="SOP not found",
                     allow_shared=not for_write)
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

    async def install_starters(self, *, actor) -> tuple[list[SOP], list[str]]:
        """Install the starter playbooks this tenant does not have yet.

        Returns ``(created, skipped_slugs)``. Idempotent by the ``starter:<slug>``
        tag rather than by name, so a tenant who RENAMED a starter still has it and
        does not get a second copy — the name is theirs to change, the marker is
        how the installer recognises its own work.

        The whole install is ONE transaction. A half-installed playbook is worse
        than none: a SOP whose initial state never landed cannot start an incident,
        and it would sit in the picker looking exactly like one that can.
        """
        have = await self._starter_slugs()
        created: list[SOP] = []
        skipped: list[str] = []

        for spec in STARTERS:
            if spec.slug in have:
                skipped.append(spec.slug)
                continue

            sop = SOP(
                tenant_id=self.scope.tenant_id,
                name=spec.name,
                description=spec.description,
                priority=spec.priority.value,
                trigger_event_types=list(spec.event_types),
                sla_hours=spec.sla_hours,
                tags=[STARTER_TAG, slug_tag(spec.slug)],
                escalation_rules=[],
                is_active=True,
                created_by=_actor_id(actor),
                updated_by=_actor_id(actor),
            )
            self.db.add(sop)
            await self.db.flush()  # sop_id

            by_name: dict[str, State] = {}
            for order, st in enumerate(starter_states()):
                x, y = position_of(st.name)
                row = State(
                    tenant_id=self.scope.tenant_id,
                    sop_id=sop.sop_id,
                    name=st.name,
                    description=st.description,
                    color=st.color,
                    position_x=x,
                    position_y=y,
                    is_initial=st.is_initial,
                    is_terminal=st.is_terminal,
                    is_cancellation=st.is_cancellation,
                    order=order,
                    created_by=_actor_id(actor),
                    updated_by=_actor_id(actor),
                )
                self.db.add(row)
                by_name[st.name] = row
            await self.db.flush()  # state ids, for the edges below

            # The pointer is DERIVED from the flag, the same way StateService does
            # it — assigning it from the spec would be a second source of truth for
            # which node starts the graph.
            initial = next((r for r in by_name.values() if r.is_initial), None)
            sop.initial_state = initial.state_id if initial else None

            for tr in starter_transitions():
                self.db.add(Transition(
                    tenant_id=self.scope.tenant_id,
                    sop_id=sop.sop_id,
                    from_state_id=by_name[tr.from_state].state_id,
                    to_state_id=by_name[tr.to_state].state_id,
                    label=tr.label,
                    requires_note=tr.requires_note,
                    created_by=_actor_id(actor),
                    updated_by=_actor_id(actor),
                ))

            created.append(sop)

        await self.db.commit()
        for sop in created:
            await self.db.refresh(sop)
            await emit(sop.tenant_id, "sop", "created", {"sop_id": sop.sop_id, "name": sop.name})
        return created, skipped

    async def _starter_slugs(self) -> set[str]:
        """Which starter slugs this tenant already holds, by their marker tag."""
        rows = (await self.db.execute(scoped(select(SOP), SOP, self.scope))).scalars().all()
        marker = f"{STARTER_TAG}:"
        return {
            t[len(marker):]
            for r in rows
            for t in (r.tags or [])
            if isinstance(t, str) and t.startswith(marker)
        }

    async def list_(self, *, skip=0, limit=50, is_active=None, tag=None):
        stmt = scoped(select(SOP), SOP, self.scope)
        count = scoped(select(func.count()).select_from(SOP), SOP, self.scope)
        if is_active is not None:
            stmt = stmt.where(SOP.is_active.is_(is_active))
            count = count.where(SOP.is_active.is_(is_active))
        stmt = stmt.order_by(SOP.created_at.desc())
        if tag:
            # ``tags`` is a portable JSON column (Postgres and SQLite), so there is
            # no containment operator to push this into SQL. Filter the whole scoped
            # set and page THAT, so rows and ``total`` agree — paging first would
            # give a page of matches and a count of everything.
            matched = [r for r in (await self.db.execute(stmt)).scalars().all()
                       if tag in (r.tags or [])]
            return matched[skip:skip + limit], len(matched)
        rows = (await self.db.execute(stmt.offset(skip).limit(limit))).scalars().all()
        total = int(await self.db.scalar(count) or 0)
        return rows, total

    async def get(self, sop_id: str) -> SOP:
        return await self._row(sop_id)

    async def update(self, sop_id: str, body, *, actor) -> SOP:
        row = await self._row(sop_id, for_write=True)
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
        row = await self._row(sop_id, for_write=True)
        row.is_active = False
        row.updated_at = utcnow()
        await self.db.commit()
        await emit(row.tenant_id, "sop", "deleted", {"sop_id": row.sop_id})


# ── State ──────────────────────────────────────────────────────────────


class StateService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _sop(self, sop_id: str, *, for_write: bool = False) -> SOP:
        row = await self.db.get(SOP, sop_id)
        assert_owned(row, self.scope, message="SOP not found",
                     allow_shared=not for_write)
        return row

    async def _row(self, state_id: str, *, for_write: bool = False) -> State:
        """The row, refusing a PLATFORM row when this is a write.

        `owns()` treats a NULL tenant_id as readable by everyone, which is right
        for a shared catalog a tenant may USE. It is not right for `update` and
        `delete`, which reach the same row through this helper: a tenant could
        rewrite or deactivate a platform state that every other tenant runs on.
        `for_write` is what separates the two.
        """
        row = await self.db.get(State, state_id)
        assert_owned(row, self.scope, message="State not found",
                     allow_shared=not for_write)
        return row

    async def list_(self, sop_id: str) -> list[State]:
        await self._sop(sop_id)
        stmt = scoped(select(State).where(State.sop_id == sop_id), State, self.scope)
        stmt = stmt.order_by(State.order.asc(), State.created_at.asc())
        return list((await self.db.execute(stmt)).scalars().all())

    async def create(self, sop_id: str, body, *, actor) -> State:
        # Adding a state to a platform SOP is editing that SOP.
        sop = await self._sop(sop_id, for_write=True)
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
        row = await self._row(state_id, for_write=True)
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
        row = await self._row(state_id, for_write=True)
        sop_id = row.sop_id
        await self.db.delete(row)
        await self._sync_pointer(await self._sop(sop_id))
        await self.db.commit()
        await emit(self.scope.tenant_id, "state", "deleted", {"state_id": state_id})

    async def _sync_pointer(self, sop: SOP) -> None:
        """Recompute ``SOP.initial_state`` from the state actually flagged is_initial.

        Always derived here, never assigned by a caller — reading the flag back
        cannot produce a pointer the flag disagrees with.

        The flush is load-bearing twice: it gives a pending State its id, and it
        applies a pending delete, so the flag read back is the post-commit one.
        """
        await self.db.flush()
        initial = await self.find_initial(sop.sop_id)
        sop.initial_state = initial.state_id if initial else None

    async def _clear_initial(self, sop_id: str, keep: str | None = None) -> None:
        """Demote every other initial state of this SOP, and flush the demotion.

        The flush orders the demoting UPDATE before the promotion that follows;
        otherwise SQLAlchemy may emit them in either order and
        ``uq_workflow_states_one_initial_per_sop`` rejects the promotion.
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

        ``scoped`` because a state row carrying a foreign tenant_id is corruption,
        and the pointer this feeds must not name it.
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

    async def _sop(self, sop_id: str, *, for_write: bool = False) -> SOP:
        row = await self.db.get(SOP, sop_id)
        assert_owned(row, self.scope, message="SOP not found",
                     allow_shared=not for_write)
        return row

    async def _row(self, transition_id: str, *, for_write: bool = False) -> Transition:
        """The row, refusing a PLATFORM row when this is a write.

        `owns()` treats a NULL tenant_id as readable by everyone, which is right
        for a shared catalog a tenant may USE. It is not right for `update` and
        `delete`, which reach the same row through this helper: a tenant could
        rewrite or deactivate a platform transition that every other tenant runs on.
        `for_write` is what separates the two.
        """
        row = await self.db.get(Transition, transition_id)
        assert_owned(row, self.scope, message="Transition not found",
                     allow_shared=not for_write)
        return row

    async def list_(self, sop_id: str) -> list[Transition]:
        await self._sop(sop_id)
        stmt = scoped(select(Transition).where(Transition.sop_id == sop_id), Transition, self.scope)
        return list((await self.db.execute(stmt.order_by(Transition.created_at.asc()))).scalars().all())

    async def create(self, sop_id: str, body, *, actor) -> Transition:
        # Adding a transition to a platform SOP is editing that SOP.
        await self._sop(sop_id, for_write=True)
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
        row = await self._row(transition_id, for_write=True)
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
        row = await self._row(transition_id, for_write=True)
        await self.db.delete(row)
        await self.db.commit()
        await emit(self.scope.tenant_id, "transition", "deleted", {"transition_id": transition_id})


