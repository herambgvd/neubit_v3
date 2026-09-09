"""What an incident born from an ingest event is CALLED.

``kernel.events`` derives ``envelope["type"]`` from the subject, so everything
the ingest service publishes arrives as ``ingest.event.received`` whatever it
actually is. The engine already MATCHES on the semantic type the payload carries
(``payload.event_type`` — a fire alarm, a turnstile, a tamper), but it used to
stamp the transport type onto the incident it created. That produced an incident
list where every ingest incident read "SOP: ingest.event.received", and a dedup
key of ``type:ingest.event.received:site:None`` under which a fire alarm and a
badge-reject suppressed each other for the whole window.

The simulator has always reported the semantic type (it echoes the operator's
``event_type``), so this is also what makes a dry run and the live consumer agree.
"""

from __future__ import annotations

import uuid

from app.workflow.correlation.engine import CorrelationEngine, event_identity
from app.workflow.correlation.models import CorrelationDedup
from app.workflow.instances.models import WorkflowInstance
from app.workflow.sops.models import SOP, State, Transition
from app.workflow.triggers.models import AlertFormat, Trigger

from conftest import make_sqlite_session, run_async as _run

TENANT = uuid.uuid4()

INGEST_ENVELOPE = {
    "event_id": "evt-1",
    "tenant_id": str(TENANT),
    "type": "ingest.event.received",
    "payload": {"event_type": "fire.alarm", "webhook_slug": "panel-a", "data": {"zone": "Z9"}},
}


def test_event_identity_prefers_the_semantic_type_over_the_subject():
    assert event_identity(INGEST_ENVELOPE) == "fire.alarm"


def test_event_identity_falls_back_to_the_transport_type():
    # A publisher that names nothing in the payload still has an identity.
    assert event_identity({"type": "vms.camera.motion", "payload": {}}) == "vms.camera.motion"
    assert event_identity({"type": "vms.camera.motion"}) == "vms.camera.motion"


class _Bus:
    def __init__(self) -> None:
        self.published: list[tuple[str, dict]] = []

    async def publish(self, subject, body):
        self.published.append((subject, body))


async def _fixture():
    engine, sm = await make_sqlite_session(
        SOP.__table__, State.__table__, Transition.__table__,
        WorkflowInstance.__table__, Trigger.__table__, AlertFormat.__table__,
        CorrelationDedup.__table__,
    )
    return engine, sm


def test_an_ingest_incident_is_named_for_what_actually_happened():
    async def go():
        db_engine, sm = await _fixture()
        try:
            async with sm() as session:
                sop = SOP(tenant_id=TENANT, name="Fire response", priority="high", version=1,
                          is_active=True)
                session.add(sop)
                await session.flush()
                session.add(State(tenant_id=TENANT, sop_id=sop.sop_id, name="Open",
                                  is_initial=True, entry_actions=[], exit_actions=[],
                                  required_role_ids=[]))
                trig = Trigger(tenant_id=TENANT, name="Fire", sop_id=sop.sop_id, event_source="",
                               event_type="fire.alarm", conditions=[], dedup={}, enabled=True,
                               priority="high", fire_count=0)
                session.add(trig)
                await session.flush()

                ce = CorrelationEngine(bus=_Bus())
                assert await ce._fire(session, trig, INGEST_ENVELOPE) is True
                await session.commit()

                inst = (await session.execute(
                    WorkflowInstance.__table__.select())).mappings().one()
                assert inst["name"] == "Fire response: fire.alarm"
                assert inst["event_type"] == "fire.alarm"

                # …and the dedup claim is per semantic type, so a second ingest
                # event of a DIFFERENT kind is not suppressed by this one.
                claim = (await session.execute(
                    CorrelationDedup.__table__.select())).mappings().one()
                assert "fire.alarm" in claim["dedup_key"]
        finally:
            await db_engine.dispose()

    _run(go())
