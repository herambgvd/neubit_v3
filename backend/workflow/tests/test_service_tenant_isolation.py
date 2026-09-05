"""The one property whose failure is a breach rather than a bug.

Every service in this package routes list reads through ``kernel.auth.scoped``
and every by-id fetch through ``assert_owned``. That is a house rule, and a house
rule with no test is a convention. This file proves it AS A PROPERTY, entity by
entity: with one row belonging to tenant A and one to tenant B, a service holding
B's scope must not READ, UPDATE or DELETE A's row, and must not see it in a
listing.

The table below is the whole point. A new entity added to this service is a new
row in it, and a service that forgets ``scoped``/``assert_owned`` fails here
rather than in production.

WHAT IS NOT COVERED, and why:
  * ``notifications`` (NotificationService, DeviceTokenService) — owned by
    another change in flight; ``test_device_tokens.py`` covers the token side.
  * ``correlation_dedup`` has no tenant_id by design (its key embeds a
    tenant-scoped trigger id), which ``core/mixins.py`` documents.

Two shapes are asserted deliberately:
  * a by-id miss is ``NotFoundError``, NOT ``ForbiddenError`` — the caller must
    not be able to probe whether an id exists in another tenant;
  * a super-admin scope DOES see across tenants, because that is the documented
    behaviour of ``scoped`` and a test that only proved "nobody sees anything"
    would pass on a service that returns nothing at all.
"""

from __future__ import annotations

import uuid

import pytest

from kernel.auth import Scope
from kernel.errors import NotFoundError

from app.workflow.forms.models import Form
from app.workflow.forms.service import FormService
from app.workflow.forms import schemas as FS
from app.workflow.instances.models import WorkflowInstance
from app.workflow.instances.service import InstanceService
from app.workflow.instances import schemas as IS
from app.workflow.sops.models import SOP, State, Transition
from app.workflow.sops.service import SopService, StateService, TransitionService
from app.workflow.sops import schemas as SS
from app.workflow.threat_levels.models import ThreatLevel
from app.workflow.threat_levels.service import ThreatLevelService
from app.workflow.threat_levels import schemas as TLS
from app.workflow.triggers.models import AlertFormat, Trigger
from app.workflow.triggers.service import (
    AlertFormatService,
    SimulatorService,
    TriggerService,
)
from app.workflow.triggers import schemas as TS

from conftest import make_sqlite_session, run_async as _run


TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()
SCOPE_A = Scope(tenant_id=TENANT_A, is_superadmin=False)
SCOPE_B = Scope(tenant_id=TENANT_B, is_superadmin=False)
SCOPE_ROOT = Scope(tenant_id=None, is_superadmin=True)


class _Actor:
    user_id = "user-1"


ACTOR = _Actor()

ALL_TABLES = (
    SOP.__table__, State.__table__, Transition.__table__,
    WorkflowInstance.__table__, Trigger.__table__, AlertFormat.__table__,
    Form.__table__, ThreatLevel.__table__,
)


# ── Per-entity seeding + the operations each service exposes ──────────
#
# Each seeder plants one row for the given tenant and returns (id, row). The
# op-lambdas below name the by-id calls; a service that skipped assert_owned in
# ANY of them is a service that leaks, so all three are checked, not just read.


async def _seed_sop(session, tenant):
    row = await SopService(session, Scope(tenant_id=tenant, is_superadmin=False)).create(
        SS.CreateSopRequest(name=f"SOP-{tenant}"), actor=ACTOR)
    return row.sop_id, row


async def _seed_state(session, tenant):
    scope = Scope(tenant_id=tenant, is_superadmin=False)
    sop_id, _ = await _seed_sop(session, tenant)
    row = await StateService(session, scope).create(
        sop_id, SS.CreateStateRequest(name="Open", is_initial=True), actor=ACTOR)
    return row.state_id, row


async def _seed_transition(session, tenant):
    scope = Scope(tenant_id=tenant, is_superadmin=False)
    sop_id, _ = await _seed_sop(session, tenant)
    states = StateService(session, scope)
    a = await states.create(sop_id, SS.CreateStateRequest(name="Open", is_initial=True),
                            actor=ACTOR)
    b = await states.create(sop_id, SS.CreateStateRequest(name="Shut", is_terminal=True),
                            actor=ACTOR)
    row = await TransitionService(session, scope).create(
        sop_id, SS.CreateTransitionRequest(from_state_id=a.state_id, to_state_id=b.state_id,
                                           label="Close"), actor=ACTOR)
    return row.transition_id, row


async def _seed_instance(session, tenant):
    scope = Scope(tenant_id=tenant, is_superadmin=False)
    _, state = await _seed_state(session, tenant)
    row = await InstanceService(session, scope).create(
        IS.CreateInstanceRequest(sop_id=state.sop_id, name=f"INC-{tenant}"), actor=ACTOR)
    return row.instance_id, row


async def _seed_trigger(session, tenant):
    scope = Scope(tenant_id=tenant, is_superadmin=False)
    sop_id, _ = await _seed_sop(session, tenant)
    row = await TriggerService(session, scope).create(
        TS.CreateTriggerRequest(name=f"TRG-{tenant}", sop_id=sop_id, event_type="e"),
        actor=ACTOR)
    return row.trigger_id, row


async def _seed_alert_format(session, tenant):
    scope = Scope(tenant_id=tenant, is_superadmin=False)
    row = await AlertFormatService(session, scope).create(
        TS.CreateAlertFormatRequest(alert_code="SHARED_CODE", name=f"AF-{tenant}"),
        actor=ACTOR)
    return row.format_id, row


async def _seed_form(session, tenant):
    scope = Scope(tenant_id=tenant, is_superadmin=False)
    row = await FormService(session, scope).create(
        FS.CreateFormRequest(name=f"FORM-{tenant}"), actor=ACTOR)
    return row.form_id, row


# name, seeder, service class, by-id ops as (label, callable(svc, row_id))
ENTITIES = [
    ("sop", _seed_sop, SopService, [
        ("read", lambda s, i: s.get(i)),
        ("update", lambda s, i: s.update(i, SS.UpdateSopRequest(name="pwned"), actor=ACTOR)),
        ("delete", lambda s, i: s.delete(i, actor=ACTOR)),
    ]),
    ("state", _seed_state, StateService, [
        ("update", lambda s, i: s.update(i, SS.UpdateStateRequest(name="pwned"), actor=ACTOR)),
        ("delete", lambda s, i: s.delete(i)),
    ]),
    ("transition", _seed_transition, TransitionService, [
        ("update", lambda s, i: s.update(i, SS.UpdateTransitionRequest(label="pwned"),
                                         actor=ACTOR)),
        ("delete", lambda s, i: s.delete(i)),
    ]),
    ("instance", _seed_instance, InstanceService, [
        ("read", lambda s, i: s.get(i)),
        ("available_transitions", lambda s, i: s.get_available_transitions(i)),
        ("assign", lambda s, i: s.assign(i, IS.AssignInstanceRequest(assigned_to="x"),
                                         actor=ACTOR)),
        ("change_status", lambda s, i: s.change_status(
            i, IS.StatusChangeRequest(status="cancelled"), actor=ACTOR)),
        ("escalate", lambda s, i: s.escalate(i, IS.EscalateInstanceRequest(reason="x"),
                                             actor=ACTOR)),
        ("transition", lambda s, i: s.transition(
            i, IS.TransitionInstanceRequest(transition_id="whatever"), actor=ACTOR)),
        ("render_pdf", lambda s, i: s.render_pdf(i)),
    ]),
    ("trigger", _seed_trigger, TriggerService, [
        ("read", lambda s, i: s.get(i)),
        ("update", lambda s, i: s.update(i, TS.UpdateTriggerRequest(name="pwned"),
                                         actor=ACTOR)),
        ("set_enabled", lambda s, i: s.set_enabled(i, False, actor=ACTOR)),
        ("delete", lambda s, i: s.delete(i)),
    ]),
    ("alert_format", _seed_alert_format, AlertFormatService, [
        ("read", lambda s, i: s.get(i)),
        ("update", lambda s, i: s.update(i, TS.UpdateAlertFormatRequest(name="pwned"),
                                         actor=ACTOR)),
        ("delete", lambda s, i: s.delete(i)),
    ]),
    ("form", _seed_form, FormService, [
        ("read", lambda s, i: s.get(i)),
        ("update", lambda s, i: s.update(i, FS.UpdateFormRequest(name="pwned"), actor=ACTOR)),
        ("delete", lambda s, i: s.delete(i)),
    ]),
]

_OPS = [(name, seeder, cls, op_label, op)
        for name, seeder, cls, ops in ENTITIES for op_label, op in ops]


@pytest.mark.parametrize(
    "entity,seeder,service_cls,op_label,op",
    _OPS, ids=[f"{n}.{o}" for n, _s, _c, o, _f in _OPS])
def test_tenant_b_cannot_touch_tenant_a_by_id(entity, seeder, service_cls, op_label, op):
    async def go():
        engine, sm = await make_sqlite_session(*ALL_TABLES)
        try:
            async with sm() as session:
                a_id, _ = await seeder(session, TENANT_A)
                with pytest.raises(NotFoundError):
                    await op(service_cls(session, SCOPE_B), a_id)
        finally:
            await engine.dispose()

    _run(go())


@pytest.mark.parametrize(
    "entity,seeder,service_cls",
    [(n, s, c) for n, s, c, _ops in ENTITIES],
    ids=[n for n, _s, _c, _o in ENTITIES])
def test_a_listing_shows_only_the_callers_tenant(entity, seeder, service_cls):
    """Both tenants hold a row; each sees exactly one, and a super-admin sees both."""

    async def go():
        engine, sm = await make_sqlite_session(*ALL_TABLES)
        try:
            async with sm() as session:
                a_id, _ = await seeder(session, TENANT_A)
                b_id, _ = await seeder(session, TENANT_B)

                def ids(result):
                    rows = result[0] if isinstance(result, tuple) else result
                    key = {"sop": "sop_id", "state": "state_id",
                           "transition": "transition_id", "instance": "instance_id",
                           "trigger": "trigger_id", "alert_format": "format_id",
                           "form": "form_id"}[entity]
                    return {getattr(r, key) for r in rows}

                # State/Transition list per-SOP; call them through their parent.
                if entity in ("state", "transition"):
                    a_row = await session.get(
                        {"state": State, "transition": Transition}[entity], a_id)
                    seen_a = ids(await service_cls(session, SCOPE_A).list_(a_row.sop_id))
                    assert seen_a == {a_id}
                    with pytest.raises(NotFoundError):
                        await service_cls(session, SCOPE_B).list_(a_row.sop_id)
                    return

                seen_a = ids(await service_cls(session, SCOPE_A).list_())
                seen_b = ids(await service_cls(session, SCOPE_B).list_())
                assert seen_a == {a_id}, f"{entity}: tenant A saw {seen_a}"
                assert seen_b == {b_id}, f"{entity}: tenant B saw {seen_b}"
                assert ids(await service_cls(session, SCOPE_ROOT).list_()) == {a_id, b_id}
        finally:
            await engine.dispose()

    _run(go())


def test_a_by_id_miss_is_not_found_and_not_forbidden():
    """The refusal must not leak the existence of the id. NotFoundError is the
    only shape allowed — ForbiddenError would answer 'yes, but not for you'."""

    async def go():
        engine, sm = await make_sqlite_session(*ALL_TABLES)
        try:
            async with sm() as session:
                a_id, _ = await _seed_sop(session, TENANT_A)
                svc = SopService(session, SCOPE_B)
                with pytest.raises(NotFoundError) as real:
                    await svc.get(a_id)
                with pytest.raises(NotFoundError) as absent:
                    await svc.get("00000000-0000-0000-0000-000000000000")
                # Indistinguishable to the caller.
                assert type(real.value) is type(absent.value)
                assert str(real.value) == str(absent.value)
        finally:
            await engine.dispose()

    _run(go())


def test_instance_stats_do_not_count_another_tenants_incidents():
    async def go():
        engine, sm = await make_sqlite_session(*ALL_TABLES)
        try:
            async with sm() as session:
                await _seed_instance(session, TENANT_A)
                await _seed_instance(session, TENANT_B)
                await _seed_instance(session, TENANT_B)
                assert (await InstanceService(session, SCOPE_A).stats())["total"] == 1
                assert (await InstanceService(session, SCOPE_B).stats())["total"] == 2
                assert (await InstanceService(session, SCOPE_ROOT).stats())["total"] == 3
        finally:
            await engine.dispose()

    _run(go())


def test_threat_posture_is_read_and_written_per_tenant():
    """ThreatLevelService has no by-id surface — ``set_level`` upserts THE row for
    the scope, so the leak to prove absent is one tenant overwriting another's."""

    async def go():
        engine, sm = await make_sqlite_session(*ALL_TABLES)
        try:
            async with sm() as session:
                a = ThreatLevelService(session, SCOPE_A)
                b = ThreatLevelService(session, SCOPE_B)
                await a.set_level(TLS.SetThreatLevelRequest(level="lockdown",
                                                            reason="A drill"), actor=ACTOR)
                await b.set_level(TLS.SetThreatLevelRequest(level="normal"), actor=ACTOR)

                assert (await a.get_current()).level == "lockdown"
                assert (await b.get_current()).level == "normal"
                assert [r.level for r in await a.list_()] == ["lockdown"]
                assert [r.level for r in await b.list_()] == ["normal"]

                # B raising its own posture leaves A's alone.
                await b.set_level(TLS.SetThreatLevelRequest(level="high"), actor=ACTOR)
                assert (await a.get_current()).level == "lockdown"
                assert (await b.get_current()).level == "high"
                # …and the change is recorded in B's own history only.
                assert (await b.get_current()).history[-1]["from_level"] == "normal"
                assert not (await a.get_current()).history
            async with sm() as check:
                rows = await ThreatLevelService(check, SCOPE_ROOT).list_()
                assert {str(r.tenant_id) for r in rows} == {str(TENANT_A), str(TENANT_B)}
        finally:
            await engine.dispose()

    _run(go())


def test_the_simulator_never_matches_another_tenants_trigger_or_format():
    async def go():
        engine, sm = await make_sqlite_session(*ALL_TABLES)
        try:
            async with sm() as session:
                await _seed_trigger(session, TENANT_A)
                await _seed_alert_format(session, TENANT_A)
                body = TS.SimulateEventRequest(event_type="e", alert_code="SHARED_CODE",
                                               dry_run=False)
                out = await SimulatorService(session, SCOPE_B).simulate(body, actor=ACTOR)
                assert out["matched_triggers"] == []
                assert out["matched_format"] is None
                assert out["created_instance_ids"] == []
            async with sm() as check:
                rows, total = await InstanceService(check, SCOPE_ROOT).list_()
                assert (rows, total) == ([], 0)
        finally:
            await engine.dispose()

    _run(go())
