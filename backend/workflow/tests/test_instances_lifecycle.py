"""DB-backed tests for the running incident — ``InstanceService``'s state machine.

The service promises a specific set of refusals, and the refusals are the part
that matters: a closed incident cannot be moved, a transition that does not start
from the current state is not a transition, a note-requiring transition without a
note is a 422 and not a silent success, and a gated transition whose conditions
fail is a 409. Each of those is asserted together with "and the row did not
change", because a refusal that still writes is the same bug as no refusal.

The happy paths asserted are the ones other features read: the terminal/
cancellation states that CLOSE an incident, the timeline entry the incident report
renders, and the notification rows a transition enqueues.
"""

from __future__ import annotations

import uuid

import pytest

from kernel.auth import Scope
from kernel.errors import ConflictError, ValidationError

from app.workflow.forms.models import Form
from app.workflow.instances.models import WorkflowInstance
from app.workflow.instances.service import InstanceService
from app.workflow.instances import schemas as IS
from app.workflow.notifications.models import Notification, NotificationTemplate
from app.workflow.sops.models import SOP, State, Transition
from app.workflow.sops.service import SopService, StateService, TransitionService
from app.workflow.sops import schemas as S

from conftest import make_sqlite_session, run_async as _run


TENANT_A = uuid.uuid4()
SCOPE_A = Scope(tenant_id=TENANT_A, is_superadmin=False)


class _Actor:
    user_id = "operator-7"


ACTOR = _Actor()


async def _session():
    return await make_sqlite_session(
        SOP.__table__, State.__table__, Transition.__table__,
        WorkflowInstance.__table__, Form.__table__,
        Notification.__table__, NotificationTemplate.__table__,
    )


async def _playbook(session, *, sla_hours=None, to_kwargs=None, trans_kwargs=None):
    """A two-state SOP: Open --Close--> Closed(terminal). Returns the parts."""
    sop = await SopService(session, SCOPE_A).create(
        S.CreateSopRequest(name="Intrusion", sla_hours=sla_hours), actor=ACTOR)
    states = StateService(session, SCOPE_A)
    start = await states.create(sop.sop_id, S.CreateStateRequest(name="Open", is_initial=True),
                                actor=ACTOR)
    end = await states.create(
        sop.sop_id, S.CreateStateRequest(name="Closed", **(to_kwargs or {"is_terminal": True})),
        actor=ACTOR)
    trans = await TransitionService(session, SCOPE_A).create(
        sop.sop_id,
        S.CreateTransitionRequest(from_state_id=start.state_id, to_state_id=end.state_id,
                                  label="Close", **(trans_kwargs or {})),
        actor=ACTOR)
    return sop, start, end, trans


# ── create ────────────────────────────────────────────────────────────


def test_create_lands_in_the_initial_state_and_derives_the_sla_deadline():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop, start, _end, _t = await _playbook(session, sla_hours=4)
                inst = await InstanceService(session, SCOPE_A).create(
                    IS.CreateInstanceRequest(sop_id=sop.sop_id, event_type="fire.alarm"),
                    actor=ACTOR)
                assert inst.current_state == start.state_id
                assert inst.current_state_name == "Open"
                assert inst.status == "active"
                assert inst.priority == sop.priority       # inherited when unset
                assert inst.sop_name == sop.name           # denormalised at launch
                assert inst.name == "Intrusion: fire.alarm"
                assert inst.sla_hours == 4
                assert inst.sla_deadline is not None
                delta = (inst.sla_deadline - inst.state_entered_at).total_seconds()
                assert abs(delta - 4 * 3600) < 5
                assert inst.is_sla_breached is False
        finally:
            await engine.dispose()

    _run(go())


def test_create_without_an_sla_leaves_the_deadline_unset():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop, *_ = await _playbook(session)
                inst = await InstanceService(session, SCOPE_A).create(
                    IS.CreateInstanceRequest(sop_id=sop.sop_id), actor=ACTOR)
                assert inst.sla_deadline is None
        finally:
            await engine.dispose()

    _run(go())


def test_create_on_a_sop_with_no_initial_state_is_refused():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = await SopService(session, SCOPE_A).create(
                    S.CreateSopRequest(name="Empty"), actor=ACTOR)
                with pytest.raises(ConflictError):
                    await InstanceService(session, SCOPE_A).create(
                        IS.CreateInstanceRequest(sop_id=sop.sop_id), actor=ACTOR)
            async with sm() as check:
                rows, total = await InstanceService(check, SCOPE_A).list_()
                assert (rows, total) == ([], 0)
        finally:
            await engine.dispose()

    _run(go())


# ── transition ────────────────────────────────────────────────────────


def test_terminal_state_resolves_and_stamps_the_timeline():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop, start, end, trans = await _playbook(session)
                svc = InstanceService(session, SCOPE_A)
                inst = await svc.create(IS.CreateInstanceRequest(sop_id=sop.sop_id),
                                        actor=ACTOR)
                moved = await svc.transition(
                    inst.instance_id,
                    IS.TransitionInstanceRequest(transition_id=trans.transition_id,
                                                 notes="cleared on site"),
                    actor=ACTOR, actor_name="Ops 7")
                assert moved.status == "resolved"
                assert moved.closed_at is not None
            async with sm() as check:
                row = await check.get(WorkflowInstance, inst.instance_id)
                assert row.current_state == end.state_id
                assert row.current_state_name == "Closed"
                assert row.status == "resolved"
                assert len(row.timeline) == 1
                entry = row.timeline[0]
                assert entry["from_state_id"] == start.state_id
                assert entry["to_state_id"] == end.state_id
                assert entry["transition_id"] == trans.transition_id
                assert entry["notes"] == "cleared on site"
                assert entry["executed_by"] == "operator-7"
                assert entry["executed_by_name"] == "Ops 7"
        finally:
            await engine.dispose()

    _run(go())


def test_cancellation_state_cancels_rather_than_resolves():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop, _s, _e, trans = await _playbook(
                    session, to_kwargs={"is_terminal": True, "is_cancellation": True})
                svc = InstanceService(session, SCOPE_A)
                inst = await svc.create(IS.CreateInstanceRequest(sop_id=sop.sop_id),
                                        actor=ACTOR)
                moved = await svc.transition(
                    inst.instance_id,
                    IS.TransitionInstanceRequest(transition_id=trans.transition_id),
                    actor=ACTOR)
                # is_cancellation wins over is_terminal — a false alarm is not a
                # resolved incident, and the stats strip counts them separately.
                assert moved.status == "cancelled"
        finally:
            await engine.dispose()

    _run(go())


def test_a_closed_incident_refuses_every_mutation():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop, _s, _e, trans = await _playbook(session)
                svc = InstanceService(session, SCOPE_A)
                inst = await svc.create(IS.CreateInstanceRequest(sop_id=sop.sop_id),
                                        actor=ACTOR)
                await svc.transition(
                    inst.instance_id,
                    IS.TransitionInstanceRequest(transition_id=trans.transition_id),
                    actor=ACTOR)

                for call in (
                    svc.transition(inst.instance_id, IS.TransitionInstanceRequest(
                        transition_id=trans.transition_id), actor=ACTOR),
                    svc.assign(inst.instance_id, IS.AssignInstanceRequest(assigned_to="u2"),
                               actor=ACTOR),
                    svc.change_status(inst.instance_id, IS.StatusChangeRequest(status="active"),
                                      actor=ACTOR),
                    svc.escalate(inst.instance_id, IS.EscalateInstanceRequest(reason="late"),
                                 actor=ACTOR),
                ):
                    with pytest.raises(ConflictError):
                        await call
            async with sm() as check:
                row = await check.get(WorkflowInstance, inst.instance_id)
                assert row.status == "resolved"
                assert row.assigned_to is None
                assert row.escalation is None
                assert len(row.timeline) == 1
        finally:
            await engine.dispose()

    _run(go())


def test_a_transition_that_does_not_start_here_is_refused():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop, start, end, trans = await _playbook(session)
                # A second edge that starts from the END state.
                back = await TransitionService(session, SCOPE_A).create(
                    sop.sop_id,
                    S.CreateTransitionRequest(from_state_id=end.state_id,
                                              to_state_id=start.state_id, label="Reopen"),
                    actor=ACTOR)
                svc = InstanceService(session, SCOPE_A)
                inst = await svc.create(IS.CreateInstanceRequest(sop_id=sop.sop_id),
                                        actor=ACTOR)
                with pytest.raises(ConflictError):
                    await svc.transition(
                        inst.instance_id,
                        IS.TransitionInstanceRequest(transition_id=back.transition_id),
                        actor=ACTOR)
                with pytest.raises(ConflictError):
                    await svc.transition(
                        inst.instance_id,
                        IS.TransitionInstanceRequest(transition_id="no-such-transition"),
                        actor=ACTOR)
            async with sm() as check:
                row = await check.get(WorkflowInstance, inst.instance_id)
                assert row.current_state == start.state_id
                assert row.timeline == []
                assert trans.transition_id  # the legal edge was never used
        finally:
            await engine.dispose()

    _run(go())


def test_requires_note_is_enforced_on_blank_as_well_as_missing():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop, start, _e, trans = await _playbook(
                    session, trans_kwargs={"requires_note": True})
                svc = InstanceService(session, SCOPE_A)
                inst = await svc.create(IS.CreateInstanceRequest(sop_id=sop.sop_id),
                                        actor=ACTOR)
                for notes in (None, "", "   "):
                    with pytest.raises(ValidationError):
                        await svc.transition(
                            inst.instance_id,
                            IS.TransitionInstanceRequest(transition_id=trans.transition_id,
                                                         notes=notes),
                            actor=ACTOR)
                moved = await svc.transition(
                    inst.instance_id,
                    IS.TransitionInstanceRequest(transition_id=trans.transition_id, notes="ok"),
                    actor=ACTOR)
                assert moved.current_state != start.state_id
            async with sm() as check:
                assert len((await check.get(WorkflowInstance, inst.instance_id)).timeline) == 1
        finally:
            await engine.dispose()

    _run(go())


def test_transition_conditions_gate_the_move_and_the_available_list():
    """The gate reads the INSTANCE context, so the same edge is offered or not
    depending on the incident's own fields."""

    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop, start, _e, trans = await _playbook(session, trans_kwargs={
                    "conditions": [{"field": "priority", "operator": "eq", "value": "critical"}]})
                svc = InstanceService(session, SCOPE_A)
                low = await svc.create(
                    IS.CreateInstanceRequest(sop_id=sop.sop_id, priority="low"), actor=ACTOR)
                crit = await svc.create(
                    IS.CreateInstanceRequest(sop_id=sop.sop_id, priority="critical"), actor=ACTOR)

                assert await svc.get_available_transitions(low.instance_id) == []
                offered = await svc.get_available_transitions(crit.instance_id)
                assert [t.transition_id for t in offered] == [trans.transition_id]

                with pytest.raises(ConflictError):
                    await svc.transition(
                        low.instance_id,
                        IS.TransitionInstanceRequest(transition_id=trans.transition_id),
                        actor=ACTOR)
                moved = await svc.transition(
                    crit.instance_id,
                    IS.TransitionInstanceRequest(transition_id=trans.transition_id),
                    actor=ACTOR)
                assert moved.status == "resolved"
            async with sm() as check:
                assert (await check.get(WorkflowInstance, low.instance_id)).status == "active"
        finally:
            await engine.dispose()

    _run(go())


def test_available_transitions_is_empty_once_the_incident_is_closed():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop, _s, end, trans = await _playbook(session)
                await TransitionService(session, SCOPE_A).create(
                    sop.sop_id,
                    S.CreateTransitionRequest(from_state_id=end.state_id,
                                              to_state_id=end.state_id, label="Loop"),
                    actor=ACTOR)
                svc = InstanceService(session, SCOPE_A)
                inst = await svc.create(IS.CreateInstanceRequest(sop_id=sop.sop_id),
                                        actor=ACTOR)
                await svc.transition(
                    inst.instance_id,
                    IS.TransitionInstanceRequest(transition_id=trans.transition_id),
                    actor=ACTOR)
                assert await svc.get_available_transitions(inst.instance_id) == []
        finally:
            await engine.dispose()

    _run(go())


def test_form_backed_transition_rejects_bad_data_and_records_labels_for_good_data():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                form = Form(tenant_id=TENANT_A, name="Closure", is_active=True, fields=[
                    {"id": "reason", "label": "Reason", "type": "text", "required": True},
                ])
                session.add(form)
                await session.commit()
                sop, _s, _e, trans = await _playbook(session,
                                                     trans_kwargs={"form_id": form.form_id})
                svc = InstanceService(session, SCOPE_A)
                bad = await svc.create(IS.CreateInstanceRequest(sop_id=sop.sop_id), actor=ACTOR)
                with pytest.raises(ValidationError) as err:
                    await svc.transition(
                        bad.instance_id,
                        IS.TransitionInstanceRequest(transition_id=trans.transition_id,
                                                     form_data={}),
                        actor=ACTOR)
                assert err.value.details["fields"] == ["Reason: required"]

                await svc.transition(
                    bad.instance_id,
                    IS.TransitionInstanceRequest(transition_id=trans.transition_id,
                                                 form_data={"reason": "false alarm"}),
                    actor=ACTOR)
            async with sm() as check:
                entry = (await check.get(WorkflowInstance, bad.instance_id)).timeline[0]
                assert entry["form_data"] == {"reason": "false alarm"}
                # Labels are snapshotted so the report still reads correctly after
                # the form definition is later edited.
                assert entry["form_labels"] == {"reason": "Reason"}
        finally:
            await engine.dispose()

    _run(go())


def test_transition_enqueues_one_notification_per_recipient():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop, _s, _e, trans = await _playbook(session, trans_kwargs={
                    "notification_config": {
                        "type": "email",
                        "recipients": ["a@example.com", "b@example.com"],
                        "email_subject": "[{{ priority|upper }}] {{ instance_name }}",
                    }})
                svc = InstanceService(session, SCOPE_A)
                inst = await svc.create(
                    IS.CreateInstanceRequest(sop_id=sop.sop_id, name="Door forced",
                                             priority="high"),
                    actor=ACTOR)
                await svc.transition(
                    inst.instance_id,
                    IS.TransitionInstanceRequest(transition_id=trans.transition_id),
                    actor=ACTOR)
            async with sm() as check:
                from sqlalchemy import select
                rows = (await check.execute(select(Notification))).scalars().all()
                assert sorted(r.recipient for r in rows) == ["a@example.com", "b@example.com"]
                assert {r.status for r in rows} == {"pending"}
                assert {r.channel_type for r in rows} == {"email"}
                assert {r.instance_id for r in rows} == {inst.instance_id}
                assert rows[0].subject == "[HIGH] Door forced"
        finally:
            await engine.dispose()

    _run(go())


def test_transition_with_notifications_off_enqueues_nothing():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop, _s, _e, trans = await _playbook(session, trans_kwargs={
                    "notification_config": {"type": "none",
                                            "recipients": ["a@example.com"]}})
                svc = InstanceService(session, SCOPE_A)
                inst = await svc.create(IS.CreateInstanceRequest(sop_id=sop.sop_id), actor=ACTOR)
                await svc.transition(
                    inst.instance_id,
                    IS.TransitionInstanceRequest(transition_id=trans.transition_id),
                    actor=ACTOR)
            async with sm() as check:
                from sqlalchemy import select
                assert (await check.execute(select(Notification))).scalars().all() == []
        finally:
            await engine.dispose()

    _run(go())


# ── status machine / assign / escalate ─────────────────────────────────


def test_change_status_walks_only_legal_edges():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop, *_ = await _playbook(session)
                svc = InstanceService(session, SCOPE_A)
                inst = await svc.create(IS.CreateInstanceRequest(sop_id=sop.sop_id), actor=ACTOR)

                paused = await svc.change_status(
                    inst.instance_id, IS.StatusChangeRequest(status="paused"), actor=ACTOR)
                assert paused.status == "paused"
                assert paused.closed_at is None
                # A no-op is allowed.
                assert (await svc.change_status(
                    inst.instance_id, IS.StatusChangeRequest(status="paused"),
                    actor=ACTOR)).status == "paused"
                # paused → pending is not an edge.
                with pytest.raises(ConflictError):
                    await svc.change_status(
                        inst.instance_id, IS.StatusChangeRequest(status="pending"), actor=ACTOR)

                resolved = await svc.change_status(
                    inst.instance_id,
                    IS.StatusChangeRequest(status="resolved", outcome="stood down"),
                    actor=ACTOR)
                assert resolved.status == "resolved"
                assert resolved.closed_at is not None
                assert resolved.outcome == "stood down"
            async with sm() as check:
                row = await check.get(WorkflowInstance, inst.instance_id)
                assert row.status == "resolved"
        finally:
            await engine.dispose()

    _run(go())


def test_escalate_counts_up_from_whatever_level_is_recorded():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop, *_ = await _playbook(session)
                svc = InstanceService(session, SCOPE_A)
                inst = await svc.create(IS.CreateInstanceRequest(sop_id=sop.sop_id), actor=ACTOR)
                first = await svc.escalate(
                    inst.instance_id, IS.EscalateInstanceRequest(reason="no response"),
                    actor=ACTOR)
                assert first.escalation["level"] == 1
                assert first.escalation["reason"] == "no response"
                assert first.escalation["escalated_by"] == "operator-7"
                second = await svc.escalate(
                    inst.instance_id, IS.EscalateInstanceRequest(reason="still nothing"),
                    actor=ACTOR)
                assert second.escalation["level"] == 2
            async with sm() as check:
                assert (await check.get(
                    WorkflowInstance, inst.instance_id)).escalation["level"] == 2
        finally:
            await engine.dispose()

    _run(go())


def test_assign_records_who_and_when():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop, *_ = await _playbook(session)
                svc = InstanceService(session, SCOPE_A)
                inst = await svc.create(IS.CreateInstanceRequest(sop_id=sop.sop_id), actor=ACTOR)
                await svc.assign(inst.instance_id, IS.AssignInstanceRequest(
                    assigned_to="guard-3", assigned_to_name="Guard Three",
                    assigned_role="responder"), actor=ACTOR)
            async with sm() as check:
                row = await check.get(WorkflowInstance, inst.instance_id)
                assert row.assigned_to == "guard-3"
                assert row.assignment["assigned_to_name"] == "Guard Three"
                assert row.assignment["assigned_role"] == "responder"
                assert row.assignment["assigned_at"]
        finally:
            await engine.dispose()

    _run(go())


def test_stats_zero_fills_every_bucket_and_aliases_completed():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop, _s, _e, trans = await _playbook(session)
                svc = InstanceService(session, SCOPE_A)
                a = await svc.create(IS.CreateInstanceRequest(sop_id=sop.sop_id,
                                                              priority="high"), actor=ACTOR)
                await svc.create(IS.CreateInstanceRequest(sop_id=sop.sop_id,
                                                          priority="low"), actor=ACTOR)
                await svc.transition(
                    a.instance_id,
                    IS.TransitionInstanceRequest(transition_id=trans.transition_id),
                    actor=ACTOR)
                stats = await svc.stats()
                assert stats["total"] == 2
                assert stats["by_status"]["active"] == 1
                assert stats["by_status"]["resolved"] == 1
                assert stats["by_status"]["completed"] == 1     # v2 alias
                assert stats["by_status"]["pending"] == 0       # zero-filled
                assert stats["by_priority"] == {"critical": 0, "high": 1,
                                                "medium": 0, "low": 1}
        finally:
            await engine.dispose()

    _run(go())
