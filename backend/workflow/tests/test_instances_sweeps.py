"""DB-backed tests for the escalation + timeout sweeps — the clock's half of the
incident state machine.

``instances/jobs.py`` claims, in its own docstring, that both sweeps are
"idempotent by construction — re-running a sweep re-derives the same decision from
the row, so a Celery redelivery cannot double-escalate". That is a promise about
what happens on the SECOND run, and every test here runs the sweep twice.

The other half is the collision the package was grouped around: an SLA breach and
an operator move the same row, one by the clock and one by hand. Both orderings
are exercised.

TWO SEAMS ARE PATCHED, both of them process plumbing rather than domain code:

  * ``jobs._task_session`` — production opens its own NullPool engine against
    ``settings.database_url``. A test must not reach the live database, so the
    context manager is replaced with one yielding the in-memory session. The SAME
    session is yielded to every call on purpose: SQLite's DATETIME storage drops
    tzinfo, so a row re-read through a second session would come back naive and
    the sweep's ``deadline < now`` would raise instead of compare. Assertions
    therefore read through that session too.
  * ``jobs.EventBus`` — a recorder. The published subjects ARE the sweep's
    contract with the rest of the platform (correlation and the notify consumer
    subscribe to them), so "did it publish, and how many times" is behaviour,
    not implementation.
"""

from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from datetime import timedelta

from sqlalchemy import select

from app.workflow.core.primitives import utcnow
from app.workflow.instances import jobs as J
from app.workflow.instances.models import WorkflowInstance
from app.workflow.notifications.models import Notification
from app.workflow.sops.models import SOP, State, Transition

from conftest import make_sqlite_session, run_async as _run


TENANT_A = uuid.uuid4()


class _RecordingBus:
    """Stands in for the NATS EventBus; remembers every subject published."""

    instances: list["_RecordingBus"] = []

    def __init__(self, *_a, **_kw):
        self.published: list[tuple[str, dict]] = []
        _RecordingBus.instances.append(self)

    async def connect(self):
        return None

    async def close(self):
        return None

    async def publish(self, subj, payload=None):
        self.published.append((subj, payload or {}))

    @classmethod
    def all_subjects(cls) -> list[str]:
        return [s for b in cls.instances for s, _ in b.published]

    @classmethod
    def reset(cls):
        cls.instances = []


class _Harness:
    """Patches the two seams for the duration of a scenario."""

    def __init__(self, session):
        self.session = session
        self._bus = None
        self._sess = None

    def __enter__(self):
        _RecordingBus.reset()
        self._bus, J.EventBus = J.EventBus, _RecordingBus
        session = self.session

        @asynccontextmanager
        async def fake_task_session():
            yield session

        self._sess, J._task_session = J._task_session, fake_task_session
        return self

    def __exit__(self, *exc):
        J.EventBus = self._bus
        J._task_session = self._sess
        return False

    @property
    def subjects(self):
        return _RecordingBus.all_subjects()


async def _session():
    return await make_sqlite_session(
        SOP.__table__, State.__table__, Transition.__table__,
        WorkflowInstance.__table__, Notification.__table__,
    )


def _sop(session, **kw):
    row = SOP(tenant_id=TENANT_A, name=kw.pop("name", "Intrusion"),
              priority=kw.pop("priority", "medium"), version=1, is_active=True, **kw)
    session.add(row)
    return row


def _state(session, sop, **kw):
    row = State(tenant_id=TENANT_A, sop_id=sop.sop_id, name=kw.pop("name", "Open"),
                is_initial=True, entry_actions=[], exit_actions=[],
                required_role_ids=[], **kw)
    session.add(row)
    return row


def _instance(session, sop, state=None, **kw):
    now = utcnow()
    row = WorkflowInstance(
        tenant_id=TENANT_A, sop_id=sop.sop_id, sop_name=sop.name, sop_version=1,
        name=kw.pop("name", "Incident"), priority=kw.pop("priority", "medium"),
        status=kw.pop("status", "active"),
        current_state=state.state_id if state else None,
        current_state_name=state.name if state else None,
        state_entered_at=kw.pop("state_entered_at", now),
        created_at=kw.pop("created_at", now), updated_at=now,
        timeline=[], tags=[], **kw)
    session.add(row)
    return row


# ── SLA breach ────────────────────────────────────────────────────────


def test_sla_breach_is_flagged_once_and_announced_once():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = _sop(session)
                await session.flush()
                inst = _instance(session, sop, sla_hours=1,
                                 sla_deadline=utcnow() - timedelta(hours=2))
                await session.commit()

                with _Harness(session) as h:
                    assert await J.escalation_sweep() == 1
                    assert inst.is_sla_breached is True
                    breaches = [s for s in h.subjects if s.endswith("incident.sla_breached")]
                    assert len(breaches) == 1
                    assert str(TENANT_A) in breaches[0]

                    # Redelivery: same row, same clock-derived decision, no repeat.
                    assert await J.escalation_sweep() == 0
                    assert len([s for s in h.subjects
                                if s.endswith("incident.sla_breached")]) == 1
        finally:
            await engine.dispose()

    _run(go())


def test_an_unbreached_deadline_is_left_alone():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = _sop(session)
                await session.flush()
                inst = _instance(session, sop, sla_hours=8,
                                 sla_deadline=utcnow() + timedelta(hours=8))
                await session.commit()
                with _Harness(session) as h:
                    assert await J.escalation_sweep() == 0
                    assert inst.is_sla_breached is False
                    assert h.subjects == []
        finally:
            await engine.dispose()

    _run(go())


def test_an_operator_who_resolves_first_takes_the_row_out_of_the_sweep():
    """The collision, operator-first: a resolved incident is no longer swept, so
    a breach is never stamped onto a closed row."""

    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = _sop(session)
                await session.flush()
                inst = _instance(session, sop, status="resolved",
                                 closed_at=utcnow(), sla_hours=1,
                                 sla_deadline=utcnow() - timedelta(hours=2))
                await session.commit()
                with _Harness(session) as h:
                    assert await J.escalation_sweep() == 0
                    assert inst.is_sla_breached is False
                    assert h.subjects == []
        finally:
            await engine.dispose()

    _run(go())


def test_a_breach_already_stamped_survives_the_operator_closing_the_incident():
    """The collision, clock-first: the breach is a historical fact about the
    incident and closing it afterwards must not erase the flag."""

    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = _sop(session)
                await session.flush()
                inst = _instance(session, sop, sla_hours=1,
                                 sla_deadline=utcnow() - timedelta(hours=2))
                await session.commit()
                with _Harness(session):
                    assert await J.escalation_sweep() == 1

                from kernel.auth import Scope
                from app.workflow.instances.service import InstanceService
                from app.workflow.instances import schemas as IS

                class _A:
                    user_id = "op-1"

                closed = await InstanceService(
                    session, Scope(tenant_id=TENANT_A, is_superadmin=False)
                ).change_status(inst.instance_id,
                                IS.StatusChangeRequest(status="resolved"), actor=_A())
                assert closed.status == "resolved"
                assert closed.is_sla_breached is True
        finally:
            await engine.dispose()

    _run(go())


# ── Per-state timeout ─────────────────────────────────────────────────


def test_state_timeout_escalates_one_level_and_not_again():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = _sop(session)
                await session.flush()
                state = _state(session, sop, sla_hours=1)
                await session.flush()
                inst = _instance(session, sop, state,
                                 state_entered_at=utcnow() - timedelta(hours=3))
                await session.commit()

                with _Harness(session) as h:
                    assert await J.escalation_sweep() == 1
                    assert inst.escalation["level"] == 1
                    assert inst.escalation["escalated_by"] == "system:escalation"
                    assert "Open" in inst.escalation["reason"]
                    assert len([s for s in h.subjects
                                if s.endswith("incident.escalated")]) == 1

                    # The recorded escalated_at is at/after the deadline, so the
                    # second pass recognises its own work.
                    assert await J.escalation_sweep() == 0
                    assert inst.escalation["level"] == 1
                    assert len([s for s in h.subjects
                                if s.endswith("incident.escalated")]) == 1
        finally:
            await engine.dispose()

    _run(go())


def test_a_state_with_no_timeout_never_escalates():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = _sop(session)
                await session.flush()
                state = _state(session, sop)          # sla_hours unset
                await session.flush()
                inst = _instance(session, sop, state,
                                 state_entered_at=utcnow() - timedelta(days=30))
                await session.commit()
                with _Harness(session):
                    assert await J.escalation_sweep() == 0
                    assert inst.escalation is None
        finally:
            await engine.dispose()

    _run(go())


# ── SOP escalation rules ──────────────────────────────────────────────


def test_sop_rule_bumps_priority_once_and_enqueues_its_recipients():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = _sop(session, escalation_rules=[
                    {"after_hours": 2, "to_priority": "high",
                     "notify_role_ids": ["role-a", "role-b"]}])
                await session.flush()
                inst = _instance(session, sop, priority="low",
                                 created_at=utcnow() - timedelta(hours=5))
                await session.commit()

                with _Harness(session) as h:
                    assert await J.escalation_sweep() == 1
                    assert inst.priority == "high"
                    assert inst.escalation["escalated_by"] == "system:sop_rule"
                    notes = (await session.execute(select(Notification))).scalars().all()
                    assert sorted(n.recipient for n in notes) == ["role:role-a", "role:role-b"]
                    assert {n.status for n in notes} == {"pending"}
                    assert {n.instance_id for n in notes} == {inst.instance_id}
                    assert all(n.extra["needs_recipient_resolution"] for n in notes)
                    assert "HIGH" in notes[0].subject

                    # Second pass: the row is already at/above the rule's target,
                    # so nothing moves and no duplicate notifications appear.
                    assert await J.escalation_sweep() == 0
                    assert inst.priority == "high"
                    assert len((await session.execute(
                        select(Notification))).scalars().all()) == 2
                    assert len([s for s in h.subjects
                                if s.endswith("incident.priority_escalated")]) == 1
        finally:
            await engine.dispose()

    _run(go())


def test_a_rule_never_de_escalates_a_higher_priority_incident():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = _sop(session, escalation_rules=[
                    {"after_hours": 1, "to_priority": "medium", "notify_role_ids": ["r"]}])
                await session.flush()
                inst = _instance(session, sop, priority="critical",
                                 created_at=utcnow() - timedelta(hours=9))
                await session.commit()
                with _Harness(session):
                    assert await J.escalation_sweep() == 0
                    assert inst.priority == "critical"
                    assert (await session.execute(
                        select(Notification))).scalars().all() == []
        finally:
            await engine.dispose()

    _run(go())


def test_a_rule_whose_hour_has_not_come_does_nothing():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = _sop(session, escalation_rules=[
                    {"after_hours": 12, "to_priority": "critical"}])
                await session.flush()
                inst = _instance(session, sop, priority="low",
                                 created_at=utcnow() - timedelta(hours=1))
                await session.commit()
                with _Harness(session):
                    assert await J.escalation_sweep() == 0
                    assert inst.priority == "low"
        finally:
            await engine.dispose()

    _run(go())


def test_two_due_rules_land_on_the_highest_target():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = _sop(session, escalation_rules=[
                    {"after_hours": 1, "to_priority": "high"},
                    {"after_hours": 2, "to_priority": "critical"}])
                await session.flush()
                inst = _instance(session, sop, priority="low",
                                 created_at=utcnow() - timedelta(hours=6))
                await session.commit()
                with _Harness(session):
                    assert await J.escalation_sweep() == 1
                    assert inst.priority == "critical"
                    assert inst.escalation["level"] == 2   # one per applied rule
                    assert await J.escalation_sweep() == 0
        finally:
            await engine.dispose()

    _run(go())


# ── Timeout sweep ─────────────────────────────────────────────────────


def test_timeout_sweep_cancels_only_the_stale_and_only_once():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = _sop(session)
                await session.flush()
                stale = _instance(session, sop, name="stale",
                                  state_entered_at=utcnow() - timedelta(hours=100))
                fresh = _instance(session, sop, name="fresh",
                                  state_entered_at=utcnow() - timedelta(hours=1))
                paused = _instance(session, sop, name="paused", status="paused",
                                   state_entered_at=utcnow() - timedelta(hours=100))
                done = _instance(session, sop, name="done", status="resolved",
                                 state_entered_at=utcnow() - timedelta(hours=100))
                await session.commit()

                with _Harness(session) as h:
                    assert await J.timeout_sweep(72) == 2      # stale + paused
                    assert stale.status == "cancelled"
                    assert stale.outcome == "instance_timeout"
                    assert stale.closed_at is not None
                    assert paused.status == "cancelled"
                    assert fresh.status == "active"
                    assert done.status == "resolved"
                    assert done.outcome is None
                    assert len([s for s in h.subjects
                                if s.endswith("incident.timed_out")]) == 2

                    # Cancelled rows fall out of the status filter → second run is a
                    # no-op, which is what makes a redelivery safe.
                    assert await J.timeout_sweep(72) == 0
                    assert len([s for s in h.subjects
                                if s.endswith("incident.timed_out")]) == 2
        finally:
            await engine.dispose()

    _run(go())


def test_timeout_sweep_disabled_by_a_non_positive_window():
    async def go():
        engine, sm = await _session()
        try:
            async with sm() as session:
                sop = _sop(session)
                await session.flush()
                stale = _instance(session, sop,
                                  state_entered_at=utcnow() - timedelta(days=365))
                await session.commit()
                with _Harness(session) as h:
                    assert await J.timeout_sweep(0) == 0
                    assert await J.timeout_sweep(-1) == 0
                    assert stale.status == "active"
                    assert h.subjects == []
        finally:
            await engine.dispose()

    _run(go())
