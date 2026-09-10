"""Starter playbooks — the four procedures a fresh deployment begins with.

WHY THEY EXIST, and therefore what these tests hold: creating an incident REQUIRES
a SOP with an initial state. On a deployment with none — which is every new one —
"escalate this event into an alarm" opens a picker with nothing in it and stops.
So the starters must be installable in one call, must be immediately usable to
start an incident, and must be safe to install twice.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from kernel.auth import Scope

from app.workflow.sops.models import SOP, State, Transition
from app.workflow.sops.service import SopService
from app.workflow.sops.starters import STARTERS
from conftest import PREFIX, auth, client, make_sqlite_session, run_async

TENANT = uuid.uuid4()


class _Actor:
    user_id = "operator-1"
    id = "operator-1"


def _service(sm):
    return sm, Scope(tenant_id=TENANT, is_superadmin=False)


async def _install(sm, scope):
    async with sm() as db:
        return await SopService(db, scope).install_starters(actor=_Actor())


def test_a_fresh_tenant_gets_every_starter():
    async def go():
        engine, sm = await make_sqlite_session(SOP.__table__, State.__table__, Transition.__table__)
        try:
            sm, scope = _service(sm)
            created, skipped = await _install(sm, scope)
            assert len(created) == len(STARTERS)
            assert skipped == []
            names = {s.name for s in created}
            assert "General alarm" in names, "the catch-all is the one that must always exist"
        finally:
            await engine.dispose()

    run_async(go())


def test_every_starter_can_actually_start_an_incident():
    """The whole point. A SOP with no state flagged initial raises ConflictError in
    InstanceService.create — it would sit in the picker looking usable and refuse."""

    async def go():
        engine, sm = await make_sqlite_session(SOP.__table__, State.__table__, Transition.__table__)
        try:
            sm, scope = _service(sm)
            created, _ = await _install(sm, scope)
            async with sm() as db:
                for sop in created:
                    initial = (
                        await db.execute(
                            select(State).where(State.sop_id == sop.sop_id, State.is_initial.is_(True))
                        )
                    ).scalars().all()
                    assert len(initial) == 1, f"{sop.name} has {len(initial)} initial states"
                    # The denormalised pointer must name that row, not some other.
                    assert sop.initial_state == initial[0].state_id
        finally:
            await engine.dispose()

    run_async(go())


def test_every_starter_can_be_closed_both_ways():
    """An incident that can be opened and not closed is a queue that only grows.
    Each starter needs a terminal (resolved) and a cancellation (false alarm), and
    an edge reaching each."""

    async def go():
        engine, sm = await make_sqlite_session(SOP.__table__, State.__table__, Transition.__table__)
        try:
            sm, scope = _service(sm)
            created, _ = await _install(sm, scope)
            async with sm() as db:
                for sop in created:
                    states = (
                        await db.execute(select(State).where(State.sop_id == sop.sop_id))
                    ).scalars().all()
                    trans = (
                        await db.execute(select(Transition).where(Transition.sop_id == sop.sop_id))
                    ).scalars().all()
                    terminal = {s.state_id for s in states if s.is_terminal}
                    cancel = {s.state_id for s in states if s.is_cancellation}
                    assert terminal and cancel, f"{sop.name} cannot be closed"
                    reached = {t.to_state_id for t in trans}
                    assert terminal <= reached, f"{sop.name}: nothing leads to Resolved"
                    assert cancel <= reached, f"{sop.name}: nothing leads to Dismissed"
                    # Every edge points at states of this SOP — a dangling edge is a
                    # button that fails when an operator presses it.
                    ids = {s.state_id for s in states}
                    assert {t.from_state_id for t in trans} <= ids
                    assert reached <= ids
        finally:
            await engine.dispose()

    run_async(go())


def test_installing_twice_does_not_duplicate():
    async def go():
        engine, sm = await make_sqlite_session(SOP.__table__, State.__table__, Transition.__table__)
        try:
            sm, scope = _service(sm)
            await _install(sm, scope)
            created, skipped = await _install(sm, scope)
            assert created == []
            assert len(skipped) == len(STARTERS)
            async with sm() as db:
                rows = (await db.execute(select(SOP))).scalars().all()
                assert len(rows) == len(STARTERS)
        finally:
            await engine.dispose()

    run_async(go())


def test_a_renamed_starter_is_still_recognised():
    """The marker is a tag, not the name. An operator renaming "General alarm" to
    "Site B general" owns that name; installing again must not hand them a second
    copy of the same procedure."""

    async def go():
        engine, sm = await make_sqlite_session(SOP.__table__, State.__table__, Transition.__table__)
        try:
            sm, scope = _service(sm)
            await _install(sm, scope)
            async with sm() as db:
                row = (await db.execute(select(SOP).limit(1))).scalars().one()
                row.name = "Renamed by the operator"
                await db.commit()

            created, skipped = await _install(sm, scope)
            assert created == []
            assert len(skipped) == len(STARTERS)
        finally:
            await engine.dispose()

    run_async(go())


def test_another_tenant_gets_its_own_copies():
    async def go():
        engine, sm = await make_sqlite_session(SOP.__table__, State.__table__, Transition.__table__)
        try:
            await _install(sm, Scope(tenant_id=TENANT, is_superadmin=False))
            other = uuid.uuid4()
            created, skipped = await _install(sm, Scope(tenant_id=other, is_superadmin=False))
            assert len(created) == len(STARTERS), "a tenant cannot run on another's playbooks"
            assert skipped == []
            assert all(s.tenant_id == other for s in created)
        finally:
            await engine.dispose()

    run_async(go())


@pytest.mark.asyncio
async def test_the_route_installs_and_reports_what_it_did(app):
    async with client(app) as c:
        first = await c.post(
            f"{PREFIX}/workflow/sops/starters",
            headers=auth(tenant_id=TENANT, permissions=["workflow.sop.create"]),
        )
        assert first.status_code == 201, first.text
        assert first.json()["created"] == len(STARTERS)

        again = await c.post(
            f"{PREFIX}/workflow/sops/starters",
            headers=auth(tenant_id=TENANT, permissions=["workflow.sop.create"]),
        )
        assert again.json()["created"] == 0
        assert len(again.json()["skipped"]) == len(STARTERS)


@pytest.mark.asyncio
async def test_the_route_is_gated(app):
    """Installing playbooks is creating SOPs, and is gated as such — a reader must
    not be able to write four procedures into a tenant."""
    async with client(app) as c:
        r = await c.post(
            f"{PREFIX}/workflow/sops/starters",
            headers=auth(tenant_id=TENANT, permissions=["workflow.sop.read"]),
        )
        assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_the_literal_path_is_not_swallowed_by_the_by_id_route(app):
    """Nothing POSTs to /{sop_id} today, so ordering is not a live collision — but
    a by-id POST added later above this route would silently turn "starters" into a
    sop_id. This pins that the literal path still answers."""
    async with client(app) as c:
        r = await c.post(
            f"{PREFIX}/workflow/sops/starters",
            headers=auth(tenant_id=uuid.uuid4(), permissions=["workflow.sop.create"]),
        )
        assert r.status_code == 201, r.text
