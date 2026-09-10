"""The rule tester must answer the engine's question, not a narrower one.

FOUND ON A LIVE ESTATE. A camera event reaches the bus as
``type = "vms.camera.tamper"`` carrying ``payload.event_type = "tamper"``, and the
correlation engine matches a trigger against EITHER name — so a rule written as
"tamper" fires. The simulator compared a trigger's event_type against the
submitted ``event_type`` alone, so the same rule reported NO MATCH there.

That is worse than a missing feature. An operator testing a rule that works in
production is told it is broken, and goes and changes the rule that was right.
"""

from __future__ import annotations

import uuid

import pytest

from app.workflow.correlation.engine import candidate_event_types
from app.workflow.sops.models import SOP, State
from app.workflow.triggers.models import Trigger
from conftest import PREFIX, auth, client, run_async  # noqa: F401

TENANT = uuid.uuid4()

#: What vision actually publishes for a camera tamper (see
#: vision/app/vms/events/normalize.py + common/events.py).
CAMERA_ENVELOPE = {
    "type": "vms.camera.tamper",
    "tenant_id": str(TENANT),
    "payload": {
        "event_id": "ev-1",
        "camera_id": "cam-9",
        "event_type": "tamper",
        "severity": "alarm",
    },
}


def test_both_names_are_matchable():
    names = candidate_event_types(CAMERA_ENVELOPE)
    # The subject-derived name, which is what an operator reading the bus sees…
    assert "vms.camera.tamper" in names
    # …and the bare semantic one, which is what they read on the events screen.
    assert "tamper" in names


def test_an_envelope_with_no_payload_type_still_matches_its_subject():
    assert candidate_event_types({"type": "sites.threat_level_changed"}) == {
        "sites.threat_level_changed"
    }


def test_an_empty_envelope_names_nothing():
    # Not {""} — an empty name would match a trigger written with a blank type,
    # which already means "any event" and does not need help.
    assert candidate_event_types({}) == set()


@pytest.mark.asyncio
async def test_the_simulator_matches_a_rule_written_the_way_the_engine_matches_it(
    app, http_sessionmaker
):
    async with http_sessionmaker() as db:
        sop = SOP(tenant_id=TENANT, name="Camera tamper", priority="high", is_active=True)
        db.add(sop)
        await db.flush()
        db.add(State(tenant_id=TENANT, sop_id=sop.sop_id, name="Open", is_initial=True))
        db.add(Trigger(
            tenant_id=TENANT, name="Auto: Tamper", sop_id=sop.sop_id, event_source="vision",
            event_type="tamper", conditions=[], dedup={}, enabled=True, priority="high",
            fire_count=0,
        ))
        await db.commit()

    async with client(app) as c:
        r = await c.post(
            f"{PREFIX}/workflow/events/simulate",
            headers=auth(tenant_id=TENANT, permissions=["workflow.instance.create"]),
            json={
                # Exactly what the bus carries: the subject-derived type outside,
                # the semantic one in the payload.
                "event_type": "vms.camera.tamper",
                "payload": {"event_type": "tamper", "camera_id": "cam-9", "event_id": "ev-1"},
                "dry_run": True,
            },
        )
        assert r.status_code == 200, r.text
        matched = r.json()["matched_triggers"]
        assert len(matched) == 1, "the rule fires in production; the tester must say so"
        assert matched[0]["would_create"] is True
