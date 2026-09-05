"""DB-backed tests for the SOP graph services — the playbook's own state machine.

``sops/service.py`` holds three service classes in one module for one stated
reason: creating or updating a state can clear ANOTHER state's ``is_initial`` and
re-point ``SOP.initial_state``. That is a write touching two tables, it is the
invariant the whole package's shape was justified by, and it had no test.

What is asserted here is what the DATABASE holds after the call (read back in a
fresh session, so an uncommitted in-memory mutation cannot pass), not which
method called which.

Also covered: the SOP soft-delete, the version bump, and the two edges the
invariant does NOT cover — deleting the initial state, and a transition whose
endpoint state was deleted underneath it.
"""

from __future__ import annotations

import uuid

import pytest

from sqlalchemy.exc import IntegrityError

from kernel.auth import Scope
from kernel.errors import ConflictError, NotFoundError

from app.workflow.sops.models import SOP, State, Transition
from app.workflow.sops.service import SopService, StateService, TransitionService
from app.workflow.sops import schemas as S
from app.workflow.instances.models import WorkflowInstance
from app.workflow.instances.service import InstanceService
from app.workflow.instances import schemas as IS

from conftest import make_sqlite_session, run_async as _run


TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()
SCOPE_A = Scope(tenant_id=TENANT_A, is_superadmin=False)
SCOPE_B = Scope(tenant_id=TENANT_B, is_superadmin=False)


class _Actor:
    user_id = "user-1"


ACTOR = _Actor()


async def _session():
    return await make_sqlite_session(
        SOP.__table__, State.__table__, Transition.__table__, WorkflowInstance.__table__
    )


async def _new_sop(session, scope=SCOPE_A, **kw):
    body = S.CreateSopRequest(name=kw.pop("name", "Intrusion"), **kw)
    return await SopService(session, scope).create(body, actor=ACTOR)


def _state_body(name, **kw):
    return S.CreateStateRequest(name=name, **kw)


# ── The is_initial invariant ───────────────────────────────────────────


def test_the_created_state_is_flagged_initial_on_its_own_row():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _new_sop(session)
                svc = StateService(session, SCOPE_A)
                first = await svc.create(sop.sop_id, _state_body("Triage", is_initial=True),
                                         actor=ACTOR)
            # Read back in a FRESH session: the flag must be committed, not merely
            # set on the in-memory object.
            async with sm() as check:
                assert (await check.get(State, first.state_id)).is_initial is True
        finally:
            await engine.dispose()

    _run(go())


def test_second_initial_state_demotes_the_first():
    """The two-row write ``fa18bb2`` named: exactly one initial state survives."""

    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _new_sop(session)
                svc = StateService(session, SCOPE_A)
                first = await svc.create(sop.sop_id, _state_body("Triage", is_initial=True),
                                         actor=ACTOR)
                second = await svc.create(sop.sop_id, _state_body("Dispatch", is_initial=True),
                                          actor=ACTOR)
            async with sm() as check:
                assert (await check.get(State, first.state_id)).is_initial is False
                assert (await check.get(State, second.state_id)).is_initial is True
                # Exactly one row claims it, which is what the launch path reads.
                rows = await StateService(check, SCOPE_A).list_(sop.sop_id)
                assert [r.state_id for r in rows if r.is_initial] == [second.state_id]
        finally:
            await engine.dispose()

    _run(go())


# The denormalised pointer. ``SOP.initial_state`` is documented in the model as
# "a convenience pointer the service keeps in sync"; it is now DERIVED from the
# is_initial flag on every write path rather than assigned, so these two assert
# the pointer and the flag can no longer disagree by which endpoint was used.

def test_creating_an_initial_state_points_the_sop_at_it():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _new_sop(session)
                first = await StateService(session, SCOPE_A).create(
                    sop.sop_id, _state_body("Triage", is_initial=True), actor=ACTOR)
            async with sm() as check:
                assert (await check.get(SOP, sop.sop_id)).initial_state == first.state_id
        finally:
            await engine.dispose()

    _run(go())


def test_creating_a_new_initial_state_does_not_null_the_existing_pointer():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _new_sop(session)
                svc = StateService(session, SCOPE_A)
                first = await svc.create(sop.sop_id, _state_body("Triage"), actor=ACTOR)
                # Promotion via update DOES set the pointer …
                await svc.update(first.state_id, S.UpdateStateRequest(is_initial=True),
                                 actor=ACTOR)
                async with sm() as mid:
                    assert (await mid.get(SOP, sop.sop_id)).initial_state == first.state_id
                # … and creating a replacement wipes it instead of moving it.
                second = await svc.create(sop.sop_id, _state_body("Dispatch", is_initial=True),
                                          actor=ACTOR)
            async with sm() as check:
                assert (await check.get(SOP, sop.sop_id)).initial_state == second.state_id
        finally:
            await engine.dispose()

    _run(go())


def test_promoting_an_existing_state_via_update_demotes_the_other():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _new_sop(session)
                svc = StateService(session, SCOPE_A)
                first = await svc.create(sop.sop_id, _state_body("Triage", is_initial=True),
                                         actor=ACTOR)
                second = await svc.create(sop.sop_id, _state_body("Dispatch"), actor=ACTOR)
                await svc.update(second.state_id, S.UpdateStateRequest(is_initial=True),
                                 actor=ACTOR)
            async with sm() as check:
                assert (await check.get(State, first.state_id)).is_initial is False
                assert (await check.get(State, second.state_id)).is_initial is True
                assert (await check.get(SOP, sop.sop_id)).initial_state == second.state_id
        finally:
            await engine.dispose()

    _run(go())


def test_promoting_the_already_initial_state_does_not_demote_itself():
    """``_clear_initial(keep=...)`` — re-saving the initial state must be a no-op."""

    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _new_sop(session)
                svc = StateService(session, SCOPE_A)
                only = await svc.create(sop.sop_id, _state_body("Triage", is_initial=True),
                                        actor=ACTOR)
                await svc.update(only.state_id,
                                 S.UpdateStateRequest(is_initial=True, name="Triage v2"),
                                 actor=ACTOR)
            async with sm() as check:
                row = await check.get(State, only.state_id)
                assert row.is_initial is True, "the state demoted itself"
                assert row.name == "Triage v2"
                assert (await check.get(SOP, sop.sop_id)).initial_state == only.state_id
        finally:
            await engine.dispose()

    _run(go())


def test_a_second_initial_state_is_refused_by_the_database_itself():
    """The service demotes the old one first, so it never hits this. Anything that
    does not -- a second writer, a partial update, a hand-run UPDATE at a psql
    prompt -- must be stopped by ``uq_workflow_states_one_initial_per_sop`` rather
    than leave the launch path picking whichever row LIMIT 1 happened to return."""

    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _new_sop(session)
                await StateService(session, SCOPE_A).create(
                    sop.sop_id, _state_body("Triage", is_initial=True), actor=ACTOR)
                session.add(State(tenant_id=TENANT_A, sop_id=sop.sop_id, name="Second",
                                  is_initial=True, entry_actions=[], exit_actions=[],
                                  required_role_ids=[]))
                with pytest.raises(IntegrityError):
                    await session.commit()
        finally:
            await engine.dispose()

    _run(go())


def test_demotion_never_reaches_another_tenants_state():
    """``_clear_initial`` runs through ``scoped``; a same-sop_id row in another
    tenant is a different tenant's data and must not be written to."""

    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop_a = await _new_sop(session, name="A")
                # A hand-built foreign row sharing the sop_id — the only way to
                # reach the branch, and exactly what a leak would look like.
                foreign = State(tenant_id=TENANT_B, sop_id=sop_a.sop_id, name="B-initial",
                                is_initial=True, entry_actions=[], exit_actions=[],
                                required_role_ids=[])
                session.add(foreign)
                await session.commit()
                await StateService(session, SCOPE_A).create(
                    sop_a.sop_id, _state_body("A-initial", is_initial=True), actor=ACTOR)
            async with sm() as check:
                assert (await check.get(State, foreign.state_id)).is_initial is True
        finally:
            await engine.dispose()

    _run(go())


# ── Deleting the initial state ─────────────────────────────────────────


def test_deleting_the_initial_state_makes_the_sop_unlaunchable():
    """Whatever the pointer does, an incident must not be created into a state
    that no longer exists: the launch path reads ``is_initial``, so it 409s."""

    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _new_sop(session)
                svc = StateService(session, SCOPE_A)
                initial = await svc.create(sop.sop_id, _state_body("Triage", is_initial=True),
                                           actor=ACTOR)
                await svc.delete(initial.state_id)

                with pytest.raises(ConflictError):
                    await InstanceService(session, SCOPE_A).create(
                        IS.CreateInstanceRequest(sop_id=sop.sop_id), actor=ACTOR)
            async with sm() as check:
                assert await check.get(State, initial.state_id) is None
        finally:
            await engine.dispose()

    _run(go())


def test_deleting_the_initial_state_clears_the_sop_pointer():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _new_sop(session)
                svc = StateService(session, SCOPE_A)
                initial = await svc.create(sop.sop_id, _state_body("Triage"), actor=ACTOR)
                await svc.update(initial.state_id, S.UpdateStateRequest(is_initial=True),
                                 actor=ACTOR)
                async with sm() as mid:
                    assert (await mid.get(SOP, sop.sop_id)).initial_state == initial.state_id
                await svc.delete(initial.state_id)
            async with sm() as check:
                assert (await check.get(SOP, sop.sop_id)).initial_state is None
        finally:
            await engine.dispose()

    _run(go())


def test_a_transition_whose_endpoint_was_deleted_is_refused_not_crashed():
    """A dangling edge must fail the transition with a 409, not a 500 / a move
    into a state id that no longer resolves to a name."""

    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _new_sop(session)
                states = StateService(session, SCOPE_A)
                start = await states.create(sop.sop_id, _state_body("Open", is_initial=True),
                                            actor=ACTOR)
                end = await states.create(sop.sop_id, _state_body("Closed", is_terminal=True),
                                          actor=ACTOR)
                trans = await TransitionService(session, SCOPE_A).create(
                    sop.sop_id,
                    S.CreateTransitionRequest(from_state_id=start.state_id,
                                              to_state_id=end.state_id, label="Close"),
                    actor=ACTOR)
                inst = await InstanceService(session, SCOPE_A).create(
                    IS.CreateInstanceRequest(sop_id=sop.sop_id), actor=ACTOR)

                await states.delete(end.state_id)

                with pytest.raises(ConflictError):
                    await InstanceService(session, SCOPE_A).transition(
                        inst.instance_id,
                        IS.TransitionInstanceRequest(transition_id=trans.transition_id),
                        actor=ACTOR)
            async with sm() as check:
                row = await check.get(WorkflowInstance, inst.instance_id)
                assert row.current_state == start.state_id, "instance moved anyway"
                assert row.status == "active"
                assert row.timeline == []
        finally:
            await engine.dispose()

    _run(go())


# ── SOP CRUD promises ──────────────────────────────────────────────────


def test_update_bumps_version_and_leaves_unsent_fields_alone():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _new_sop(session, description="original", tags=["a"])
                assert sop.version == 1
                await SopService(session, SCOPE_A).update(
                    sop.sop_id, S.UpdateSopRequest(name="Renamed"), actor=ACTOR)
            async with sm() as check:
                row = await check.get(SOP, sop.sop_id)
                assert row.name == "Renamed"
                assert row.version == 2
                assert row.description == "original"   # exclude_none, not a wipe
                assert row.tags == ["a"]
        finally:
            await engine.dispose()

    _run(go())


def test_delete_is_a_soft_delete_the_row_survives():
    """``delete`` deactivates. An incident already running on the SOP still has
    a SOP to read, which is why it is not a row removal."""

    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                svc = SopService(session, SCOPE_A)
                sop = await _new_sop(session)
                await svc.delete(sop.sop_id, actor=ACTOR)
                still_there = await svc.get(sop.sop_id)
                assert still_there.is_active is False
                rows, total = await svc.list_(is_active=True)
                assert sop.sop_id not in [r.sop_id for r in rows]
                assert total == 0
            async with sm() as check:
                assert await check.get(SOP, sop.sop_id) is not None
        finally:
            await engine.dispose()

    _run(go())


def test_tag_filter_agrees_with_its_own_total():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                svc = SopService(session, SCOPE_A)
                for i in range(3):
                    await _new_sop(session, name=f"tagged-{i}", tags=["fire"])
                for i in range(3):
                    await _new_sop(session, name=f"plain-{i}", tags=["flood"])
                rows, total = await svc.list_(tag="fire")
                assert len(rows) == 3
                assert total == 3
                # …and the filter is applied BEFORE paging, so a page of a tagged
                # listing is a page of the MATCHES, not of everything.
                page, total = await svc.list_(tag="fire", limit=2)
                assert [r.name for r in page] == ["tagged-2", "tagged-1"]
                assert total == 3
                page2, total = await svc.list_(tag="fire", skip=2, limit=2)
                assert [r.name for r in page2] == ["tagged-0"]
                assert total == 3
        finally:
            await engine.dispose()

    _run(go())


# ── Child services validate the parent ─────────────────────────────────


def test_listing_states_of_another_tenants_sop_is_not_found():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop_a = await _new_sop(session)
                with pytest.raises(NotFoundError):
                    await StateService(session, SCOPE_B).list_(sop_a.sop_id)
                with pytest.raises(NotFoundError):
                    await TransitionService(session, SCOPE_B).list_(sop_a.sop_id)
                with pytest.raises(NotFoundError):
                    await StateService(session, SCOPE_B).create(
                        sop_a.sop_id, _state_body("Sneaky"), actor=ACTOR)
            async with sm() as check:
                rows = await StateService(check, SCOPE_A).list_(sop_a.sop_id)
                assert rows == []
        finally:
            await engine.dispose()

    _run(go())


def test_states_list_in_order_then_creation_time():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _new_sop(session)
                svc = StateService(session, SCOPE_A)
                await svc.create(sop.sop_id, _state_body("third", order=3), actor=ACTOR)
                await svc.create(sop.sop_id, _state_body("first", order=1), actor=ACTOR)
                await svc.create(sop.sop_id, _state_body("second", order=2), actor=ACTOR)
                assert [s.name for s in await svc.list_(sop.sop_id)] == [
                    "first", "second", "third"]
        finally:
            await engine.dispose()

    _run(go())
