"""DB-backed tests for the trigger side — what turns an event into an incident.

``core/matching.py`` is covered by ``test_pure_rules.py``. What was untested is
the SERVICE around it: which of the stored triggers is even OFFERED to the
matcher, what the alert-code lookup does, and what the simulator reports and
persists. Those are separate decisions from the operator semantics, and they are
where a regression would silently stop incidents being created.

``SimulatorService`` is tested rather than ``CorrelationEngine`` because it is
the one that reaches into the engine for the SAME create helpers the live NATS
consumer uses — so these assertions cover both, without a broker.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from kernel.auth import Scope
from kernel.errors import ConflictError, NotFoundError

from app.workflow.correlation.models import CorrelationDedup
from app.workflow.instances.models import WorkflowInstance
from app.workflow.sops.models import SOP, State, Transition
from app.workflow.triggers.models import AlertFormat, Trigger
from app.workflow.triggers.service import (
    AlertFormatService,
    SimulatorService,
    TriggerService,
)
from app.workflow.triggers import schemas as T

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
        SOP.__table__, State.__table__, Transition.__table__,
        WorkflowInstance.__table__, Trigger.__table__, AlertFormat.__table__,
        CorrelationDedup.__table__,
    )


async def _sop(session, *, tenant=TENANT_A, name="Intrusion", is_active=True, with_state=True,
               priority="medium"):
    """Add a SOP (+ its initial state) and flush.

    The flush is load-bearing: ``sop_id`` comes from a column default applied at
    INSERT, so it is still None on the freshly constructed object.
    """
    sop = SOP(tenant_id=tenant, name=name, priority=priority, version=1, is_active=is_active)
    session.add(sop)
    await session.flush()
    if with_state:
        session.add(State(tenant_id=tenant, sop_id=sop.sop_id, name="Open", is_initial=True,
                          entry_actions=[], exit_actions=[], required_role_ids=[]))
        await session.flush()
    return sop


def _trigger(session, sop, *, tenant=TENANT_A, **kw):
    row = Trigger(tenant_id=tenant, name=kw.pop("name", "Motion"), sop_id=sop.sop_id,
                  event_source=kw.pop("event_source", ""),
                  event_type=kw.pop("event_type", "vms.camera.motion"),
                  conditions=kw.pop("conditions", []), dedup={}, enabled=kw.pop("enabled", True),
                  priority=kw.pop("priority", "medium"), fire_count=0, **kw)
    session.add(row)
    return row


def _sim(event_type="vms.camera.motion", **kw):
    return T.SimulateEventRequest(event_type=event_type, **kw)


# ── Which triggers the matcher is even shown ──────────────────────────


def test_only_enabled_triggers_of_the_right_event_type_are_considered():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _sop(session)
                await session.flush()
                wanted = _trigger(session, sop, name="wanted")
                _trigger(session, sop, name="disabled", enabled=False)
                _trigger(session, sop, name="other-type", event_type="access.door.forced")
                wildcard = _trigger(session, sop, name="wildcard", event_type="")
                _trigger(session, sop, name="other-tenant", tenant=TENANT_B)
                await session.commit()
                # Read the ids BEFORE simulating: a dry run ends in rollback(),
                # which expires every instance in the session.
                wanted_id, wildcard_id = wanted.trigger_id, wildcard.trigger_id

                out = await SimulatorService(session, SCOPE_A).simulate(_sim(), actor=ACTOR)
                assert sorted(m["name"] for m in out["matched_triggers"]) == [
                    "wanted", "wildcard"]
                assert {m["trigger_id"] for m in out["matched_triggers"]} == {
                    wanted_id, wildcard_id}
                assert all(m["would_create"] for m in out["matched_triggers"])
        finally:
            await engine.dispose()

    _run(go())


def test_conditions_are_matched_against_the_event_envelope_it_builds():
    """The simulator constructs the envelope the matcher walks; a condition on
    ``payload.x`` must reach the request's payload, and one on ``type`` the
    request's event_type."""

    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _sop(session)
                await session.flush()
                _trigger(session, sop, name="cam-1-only", conditions=[
                    {"field": "payload.camera_id", "operator": "eq", "value": "cam-1"}])
                _trigger(session, sop, name="by-type", conditions=[
                    {"field": "type", "operator": "eq", "value": "vms.camera.motion"}])
                _trigger(session, sop, name="loud-only", conditions=[
                    {"field": "payload.confidence", "operator": "gte", "value": 0.9}])
                await session.commit()

                svc = SimulatorService(session, SCOPE_A)
                out = await svc.simulate(
                    _sim(payload={"camera_id": "cam-1", "confidence": 0.5}), actor=ACTOR)
                assert sorted(m["name"] for m in out["matched_triggers"]) == [
                    "by-type", "cam-1-only"]

                out = await svc.simulate(
                    _sim(payload={"camera_id": "cam-9", "confidence": 0.95}), actor=ACTOR)
                assert sorted(m["name"] for m in out["matched_triggers"]) == [
                    "by-type", "loud-only"]
        finally:
            await engine.dispose()

    _run(go())


def test_a_matched_trigger_whose_sop_cannot_run_is_reported_with_the_reason():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                inactive = await _sop(session, name="inactive", is_active=False)
                stateless = await _sop(session, name="stateless", with_state=False)
                await session.flush()
                t_inactive = _trigger(session, inactive, name="t-inactive")
                t_stateless = _trigger(session, stateless, name="t-stateless")
                t_missing = Trigger(tenant_id=TENANT_A, name="t-missing", sop_id="gone",
                                    event_type="vms.camera.motion", conditions=[], dedup={},
                                    enabled=True, priority="medium", fire_count=0)
                session.add(t_missing)
                await session.commit()
                ids = (t_inactive.trigger_id, t_stateless.trigger_id, t_missing.trigger_id)

                out = await SimulatorService(session, SCOPE_A).simulate(
                    _sim(dry_run=False), actor=ACTOR)
                assert all(m["would_create"] is False for m in out["matched_triggers"])
                reasons = {s["trigger_id"]: s["reason"] for s in out["skipped"]}
                assert reasons[ids[0]] == "SOP inactive"
                assert reasons[ids[1]] == "SOP has no initial state"
                assert reasons[ids[2]] == "SOP missing"
                assert out["created_instance_ids"] == []
            async with sm() as check:
                assert (await check.execute(
                    select(WorkflowInstance))).scalars().all() == []
        finally:
            await engine.dispose()

    _run(go())


# ── Dry run vs. the real thing ────────────────────────────────────────


def test_a_dry_run_writes_nothing():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _sop(session)
                await session.flush()
                trig = _trigger(session, sop)
                await session.commit()
                trig_id = trig.trigger_id

                out = await SimulatorService(session, SCOPE_A).simulate(
                    _sim(dry_run=True), actor=ACTOR)
                assert out["dry_run"] is True
                assert out["matched_triggers"][0]["would_create"] is True
                assert out["created_instance_id"] is None
                assert out["created_instance_ids"] == []
            async with sm() as check:
                assert (await check.execute(select(WorkflowInstance))).scalars().all() == []
                assert (await check.get(Trigger, trig_id)).fire_count == 0
                assert (await check.get(Trigger, trig_id)).last_fired_at is None
        finally:
            await engine.dispose()

    _run(go())


def test_a_live_run_creates_the_incident_and_marks_the_trigger_fired():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _sop(session, priority="low")
                await session.flush()
                trig = _trigger(session, sop, priority="critical")
                await session.commit()

                out = await SimulatorService(session, SCOPE_A).simulate(
                    _sim(dry_run=False, site_id="site-4",
                         payload={"camera_id": "cam-1"}), actor=ACTOR)
                assert out["created_instance_id"] == out["created_instance_ids"][0]
                created = out["created_instance_id"]
            async with sm() as check:
                inst = await check.get(WorkflowInstance, created)
                assert inst.tenant_id == TENANT_A
                assert inst.status == "active"
                assert inst.sop_id == sop.sop_id
                assert inst.current_state_name == "Open"
                assert inst.site_id == "site-4"
                # The trigger's priority overrides the SOP's.
                assert inst.priority == "critical"
                assert inst.trigger_data["payload"] == {"camera_id": "cam-1"}
                assert inst.extra["source"] == "simulator"
                assert inst.extra["trigger_id"] == trig.trigger_id

                fired = await check.get(Trigger, trig.trigger_id)
                assert fired.fire_count == 1
                assert fired.last_fired_at is not None
        finally:
            await engine.dispose()

    _run(go())


def test_two_matching_triggers_create_two_incidents():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _sop(session)
                await session.flush()
                _trigger(session, sop, name="a")
                _trigger(session, sop, name="b")
                await session.commit()
                out = await SimulatorService(session, SCOPE_A).simulate(
                    _sim(dry_run=False), actor=ACTOR)
                assert len(out["created_instance_ids"]) == 2
            async with sm() as check:
                assert len((await check.execute(
                    select(WorkflowInstance))).scalars().all()) == 2
        finally:
            await engine.dispose()

    _run(go())


# ── Alert formats ─────────────────────────────────────────────────────


def _format(session, sop, *, code="FIRE_1", tenant=TENANT_A, mode="manual", **kw):
    row = AlertFormat(tenant_id=tenant, alert_code=code, name=kw.pop("name", "Fire"),
                      category="security", severity="high",
                      priority=kw.pop("priority", "high"), sop_mode=mode,
                      sop_id=sop.sop_id if sop else None,
                      is_active=kw.pop("is_active", True), alert_sound=False, **kw)
    session.add(row)
    return row


def test_the_alert_code_is_lifted_out_of_the_payload_when_not_given():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _sop(session)
                await session.flush()
                fmt = _format(session, sop)
                await session.commit()
                fmt_id = fmt.format_id
                out = await SimulatorService(session, SCOPE_A).simulate(
                    _sim(payload={"alert_code": "fire_1"}), actor=ACTOR)
                assert out["alert_code"] == "fire_1"
                # Matching is case-insensitive.
                assert out["matched_format"]["format_id"] == fmt_id
                assert out["matched_format"]["would_create"] is True
        finally:
            await engine.dispose()

    _run(go())


def test_sop_mode_decides_whether_the_alert_incident_starts_active_or_pending():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                manual_sop = await _sop(session, name="manual-sop")
                auto_sop = await _sop(session, name="auto-sop")
                await session.flush()
                _format(session, manual_sop, code="M1", mode="manual")
                _format(session, auto_sop, code="A1", mode="automatic")
                await session.commit()

                svc = SimulatorService(session, SCOPE_A)
                m = await svc.simulate(_sim(alert_code="M1", dry_run=False), actor=ACTOR)
                a = await svc.simulate(_sim(alert_code="A1", dry_run=False), actor=ACTOR)
            async with sm() as check:
                assert (await check.get(
                    WorkflowInstance, m["created_instance_id"])).status == "pending"
                assert (await check.get(
                    WorkflowInstance, a["created_instance_id"])).status == "active"
        finally:
            await engine.dispose()

    _run(go())


def test_an_unmapped_or_foreign_alert_format_does_not_fire():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                _format(session, None, code="UNMAPPED")
                other = await _sop(session, tenant=TENANT_B, name="B's SOP")
                await session.flush()
                _format(session, other, code="B_ONLY", tenant=TENANT_B)
                await session.commit()

                svc = SimulatorService(session, SCOPE_A)
                out = await svc.simulate(_sim(alert_code="UNMAPPED", dry_run=False),
                                         actor=ACTOR)
                assert out["matched_format"]["would_create"] is False
                assert out["skipped"][0]["reason"] == "no SOP mapped"

                foreign = await svc.simulate(_sim(alert_code="B_ONLY", dry_run=False),
                                             actor=ACTOR)
                assert foreign["matched_format"] is None
                assert foreign["created_instance_ids"] == []
            async with sm() as check:
                assert (await check.execute(select(WorkflowInstance))).scalars().all() == []
        finally:
            await engine.dispose()

    _run(go())


def test_alert_codes_are_unique_within_a_tenant_but_not_across_them():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                body = T.CreateAlertFormatRequest(alert_code="DUP", name="Dup")
                await AlertFormatService(session, SCOPE_A).create(body, actor=ACTOR)
                with pytest.raises(ConflictError):
                    await AlertFormatService(session, SCOPE_A).create(body, actor=ACTOR)
                # Another tenant may hold the same code.
                b_row = await AlertFormatService(session, SCOPE_B).create(body, actor=ACTOR)
                assert b_row.alert_code == "DUP"

                other = await AlertFormatService(session, SCOPE_A).create(
                    T.CreateAlertFormatRequest(alert_code="OTHER", name="Other"), actor=ACTOR)
                with pytest.raises(ConflictError):
                    await AlertFormatService(session, SCOPE_A).update(
                        other.format_id,
                        T.UpdateAlertFormatRequest(alert_code="DUP"), actor=ACTOR)
                # Renaming to its own code is not a clash with itself.
                same = await AlertFormatService(session, SCOPE_A).update(
                    other.format_id,
                    T.UpdateAlertFormatRequest(alert_code="OTHER", name="Renamed"), actor=ACTOR)
                assert same.name == "Renamed"
            async with sm() as check:
                rows = (await check.execute(select(AlertFormat))).scalars().all()
                assert sorted((str(r.tenant_id), r.alert_code) for r in rows) == sorted(
                    [(str(TENANT_A), "DUP"), (str(TENANT_B), "DUP"), (str(TENANT_A), "OTHER")])
        finally:
            await engine.dispose()

    _run(go())


def test_find_by_code_ignores_case_and_surrounding_space_and_tenant_b():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _sop(session)
                await session.flush()
                _format(session, sop, code="Fire_1")
                _format(session, sop, code="B_ONLY", tenant=TENANT_B)
                await session.commit()
                svc = AlertFormatService(session, SCOPE_A)
                assert (await svc.find_by_code("  fire_1 ")).alert_code == "Fire_1"
                assert await svc.find_by_code("nope") is None
                assert await svc.find_by_code("B_ONLY") is None
        finally:
            await engine.dispose()

    _run(go())


# ── Trigger CRUD promises ─────────────────────────────────────────────


def test_a_trigger_cannot_be_created_against_another_tenants_sop():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                b_sop = await _sop(session, tenant=TENANT_B, name="B's SOP")
                await session.commit()
                with pytest.raises(NotFoundError):
                    await TriggerService(session, SCOPE_A).create(
                        T.CreateTriggerRequest(name="Sneaky", sop_id=b_sop.sop_id,
                                               event_type="x"), actor=ACTOR)
            async with sm() as check:
                assert (await check.execute(select(Trigger))).scalars().all() == []
        finally:
            await engine.dispose()

    _run(go())


def test_a_trigger_cannot_be_repointed_at_another_tenants_sop():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                a_sop = await _sop(session, name="A's SOP")
                b_sop = await _sop(session, tenant=TENANT_B, name="B's SOP")
                await session.flush()
                await session.commit()
                svc = TriggerService(session, SCOPE_A)
                trig = await svc.create(
                    T.CreateTriggerRequest(name="Mine", sop_id=a_sop.sop_id, event_type="x"),
                    actor=ACTOR)
                with pytest.raises(NotFoundError):
                    await svc.update(trig.trigger_id,
                                     T.UpdateTriggerRequest(sop_id=b_sop.sop_id), actor=ACTOR)
        finally:
            await engine.dispose()

    _run(go())


def test_a_trigger_can_still_be_repointed_at_another_sop_of_its_own_tenant():
    """The refusal above must be about OWNERSHIP, not about sop_id being immutable:
    re-pointing a trigger is a normal operator edit and has to keep working."""

    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                first = await _sop(session, name="Intrusion")
                second = await _sop(session, name="Fire")
                await session.flush()
                await session.commit()
                svc = TriggerService(session, SCOPE_A)
                trig = await svc.create(
                    T.CreateTriggerRequest(name="Mine", sop_id=first.sop_id, event_type="x"),
                    actor=ACTOR)
                await svc.update(trig.trigger_id,
                                 T.UpdateTriggerRequest(sop_id=second.sop_id), actor=ACTOR)
                trig_id, second_id = trig.trigger_id, second.sop_id
            async with sm() as check:
                assert (await check.get(Trigger, trig_id)).sop_id == second_id
        finally:
            await engine.dispose()

    _run(go())


def test_an_alert_format_cannot_be_pointed_at_another_tenants_sop():
    """The same hole on the other launcher: an AlertFormat's ``sop_id`` is the
    second way an event becomes an incident, and it was never checked at all."""

    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                a_sop = await _sop(session, name="A's SOP")
                b_sop = await _sop(session, tenant=TENANT_B, name="B's SOP")
                await session.flush()
                await session.commit()
                svc = AlertFormatService(session, SCOPE_A)
                with pytest.raises(NotFoundError):
                    await svc.create(T.CreateAlertFormatRequest(
                        alert_code="STEAL", name="Steal", sop_id=b_sop.sop_id), actor=ACTOR)
                fmt = await svc.create(T.CreateAlertFormatRequest(
                    alert_code="MINE", name="Mine", sop_id=a_sop.sop_id), actor=ACTOR)
                with pytest.raises(NotFoundError):
                    await svc.update(fmt.format_id,
                                     T.UpdateAlertFormatRequest(sop_id=b_sop.sop_id), actor=ACTOR)
                fmt_id, a_id = fmt.format_id, a_sop.sop_id
            async with sm() as check:
                # The refused create left nothing behind, and the refused update
                # left the row on its own tenant's SOP.
                rows = (await check.execute(select(AlertFormat))).scalars().all()
                assert [r.alert_code for r in rows] == ["MINE"]
                assert (await check.get(AlertFormat, fmt_id)).sop_id == a_id
        finally:
            await engine.dispose()

    _run(go())


def test_the_simulator_will_not_read_a_sop_the_caller_does_not_own():
    """Defence in depth for rows written BEFORE the write side was closed: a
    trigger already holding a foreign ``sop_id`` must read as "SOP missing",
    never as an incident carrying the other tenant's SOP name."""

    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                b_sop = await _sop(session, tenant=TENANT_B, name="B's SOP")
                await session.flush()
                # Straight to the table — this is the legacy row, not a new write.
                trig = _trigger(session, b_sop, name="legacy")
                await session.commit()
                trig_id = trig.trigger_id

                out = await SimulatorService(session, SCOPE_A).simulate(
                    _sim(dry_run=False), actor=ACTOR)
                assert [m["trigger_id"] for m in out["matched_triggers"]] == [trig_id]
                assert out["matched_triggers"][0]["would_create"] is False
                assert out["skipped"] == [{"trigger_id": trig_id, "reason": "SOP missing"}]
                assert out["created_instance_ids"] == []
            async with sm() as check:
                assert (await check.execute(select(WorkflowInstance))).scalars().all() == []
        finally:
            await engine.dispose()

    _run(go())


def test_set_enabled_flips_the_flag_and_the_simulator_agrees():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _sop(session)
                await session.flush()
                await session.commit()
                svc = TriggerService(session, SCOPE_A)
                trig = await svc.create(
                    T.CreateTriggerRequest(name="Motion", sop_id=sop.sop_id,
                                           event_type="vms.camera.motion"), actor=ACTOR)
                trig_id = trig.trigger_id
                sim = SimulatorService(session, SCOPE_A)
                assert len((await sim.simulate(_sim(), actor=ACTOR))["matched_triggers"]) == 1

                await svc.set_enabled(trig_id, False, actor=ACTOR)
                assert (await sim.simulate(_sim(), actor=ACTOR))["matched_triggers"] == []
                await svc.set_enabled(trig_id, True, actor=ACTOR)
                assert len((await sim.simulate(_sim(), actor=ACTOR))["matched_triggers"]) == 1
            async with sm() as check:
                assert (await check.get(Trigger, trig_id)).enabled is True
        finally:
            await engine.dispose()

    _run(go())


def test_update_replaces_the_condition_list_wholesale():
    """Conditions are ANDed, so a partial merge would silently loosen a trigger."""

    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await _sop(session)
                await session.flush()
                await session.commit()
                svc = TriggerService(session, SCOPE_A)
                trig = await svc.create(T.CreateTriggerRequest(
                    name="Motion", sop_id=sop.sop_id, event_type="vms.camera.motion",
                    conditions=[{"field": "payload.camera_id", "operator": "eq",
                                 "value": "cam-1"},
                                {"field": "payload.zone", "operator": "eq", "value": "z1"}]),
                    actor=ACTOR)
                await svc.update(trig.trigger_id, T.UpdateTriggerRequest(conditions=[
                    {"field": "payload.camera_id", "operator": "eq", "value": "cam-2"}]),
                    actor=ACTOR)
            async with sm() as check:
                row = await check.get(Trigger, trig.trigger_id)
                assert row.conditions == [{"field": "payload.camera_id",
                                           "operator": "eq", "value": "cam-2"}]
                out = await SimulatorService(check, SCOPE_A).simulate(
                    _sim(payload={"camera_id": "cam-2"}), actor=ACTOR)
                assert len(out["matched_triggers"]) == 1
        finally:
            await engine.dispose()

    _run(go())
