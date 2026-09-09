"""PULSE routes — the fan-out, the gate, and what happens when a recorder is sick.

The page an operator opens when something is wrong is exactly the page a sick
recorder shows up on, so the failure paths are the product here:

  * one recorder timing out must degrade the view to "1 of 2 answered", never
    empty it and never delay the page by the full timeout of a serial fan-out;
  * the drill-downs must say WHICH kind of failure a node had — refused (a grant
    it does not hold) is not unreachable, and conflating them sends the reader to
    look at the network;
  * another tenant's recorder must be a 404, not a 403 that confirms it exists.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
import pytest_asyncio

from app.vms.federation import client as fed
from app.vms.models import MediaNode

from .conftest import PREFIX, auth, client

pytestmark = pytest.mark.asyncio

TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()

NORTH = "44444444-4444-4444-4444-444444444444"
SOUTH = "55555555-5555-5555-5555-555555555555"
FOREIGN = "66666666-6666-6666-6666-666666666666"

OVERVIEW = f"{PREFIX}/vms/pulse/overview"


def _board(total=2, online=2, name="Lobby") -> dict:
    return {
        "generated_at": "2026-09-09T06:00:00Z",
        "verdict": {"level": "ok", "headline": "Recorder healthy"},
        "engine": {"recording": True},
        "system": {"cpu_pct": 5},
        "sensors_reported": True,
        "volumes": [{"name": "rec", "usage": {"used_percent": 50.0}}],
        "retention_default_days": 30,
        "cameras": {
            "total": total, "online": online, "recording_active": online,
            "recording_gap_free": True,
            "items": [{"id": "c1", "name": name, "enabled": True, "status": "online"}],
        },
    }


@pytest_asyncio.fixture
async def nodes(http_sessionmaker):
    async with http_sessionmaker() as s:
        s.add(MediaNode(id=NORTH, tenant_id=TENANT_A, name="north", host="north.local",
                        api_url="http://north:8000", credential="k1", status="online"))
        s.add(MediaNode(id=SOUTH, tenant_id=TENANT_A, name="south", host="south.local",
                        api_url="http://south:8000", credential="k2", status="online"))
        s.add(MediaNode(id=FOREIGN, tenant_id=TENANT_B, name="other-tenant",
                        host="x.local", api_url="http://x:8000", status="online"))
        await s.commit()


async def test_the_overview_merges_every_recorder_that_answered(app, nodes, monkeypatch):
    async def fake(api_url, *, credential=None):
        return _board(total=3, online=3) if "north" in api_url else _board(total=2, online=1)

    monkeypatch.setattr(fed, "get_node_sysmon", fake)
    async with client(app) as c:
        r = await c.get(OVERVIEW, headers=auth(tenant_id=TENANT_A, permissions=["vms.camera.read"]))

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["totals"]["cameras_total"] == 5
    assert body["totals"]["cameras_online"] == 4
    assert body["partial"] is False
    assert {n["node_name"] for n in body["nodes"]} == {"north", "south"}
    assert body["generated_at"]


async def test_one_sick_recorder_degrades_the_view_instead_of_emptying_it(app, nodes, monkeypatch):
    async def fake(api_url, *, credential=None):
        if "south" in api_url:
            raise fed.NodeUnavailable("connection refused")
        return _board()

    monkeypatch.setattr(fed, "get_node_sysmon", fake)
    async with client(app) as c:
        r = await c.get(OVERVIEW, headers=auth(tenant_id=TENANT_A, permissions=["vms.camera.read"]))

    assert r.status_code == 200
    body = r.json()
    assert body["partial"] is True
    assert body["totals"]["recorders"] == 2 and body["totals"]["recorders_answered"] == 1
    assert body["unreachable"][0]["name"] == "south"
    # Named at the top of the list, because everything else about it is unknown.
    assert body["attention"][0]["kind"] == "recorder_unreachable"


async def test_the_recorders_are_asked_concurrently(app, nodes, monkeypatch):
    # Serially, two recorders each a second from timing out is a two-second page —
    # and the reason to open Pulse at all is that something is already timing out.
    started = []

    async def fake(api_url, *, credential=None):
        started.append(api_url)
        await asyncio.sleep(0.05)
        assert len(started) == 2, "the second node was not asked until the first returned"
        return _board()

    monkeypatch.setattr(fed, "get_node_sysmon", fake)
    async with client(app) as c:
        r = await c.get(OVERVIEW, headers=auth(tenant_id=TENANT_A, permissions=["vms.camera.read"]))
    assert r.status_code == 200


async def test_another_tenants_recorder_is_not_in_the_estate(app, nodes, monkeypatch):
    async def fake(api_url, *, credential=None):
        assert "x:8000" not in api_url, "asked another tenant's recorder"
        return _board()

    monkeypatch.setattr(fed, "get_node_sysmon", fake)
    async with client(app) as c:
        r = await c.get(OVERVIEW, headers=auth(tenant_id=TENANT_A, permissions=["vms.camera.read"]))
    assert {n["node_name"] for n in r.json()["nodes"]} == {"north", "south"}


async def test_reading_pulse_needs_the_camera_read_right(app, nodes):
    async with client(app) as c:
        r = await c.get(OVERVIEW, headers=auth(tenant_id=TENANT_A, permissions=[]))
    assert r.status_code == 403


# ── drill-down ───────────────────────────────────────────────────────────────


async def test_one_recorders_board_is_passed_through_whole(app, nodes, monkeypatch):
    # The recorder's own screen: a field this service has never heard of is still
    # a field the operator needs, so the payload is relayed rather than reshaped.
    async def fake(api_url, *, credential=None):
        return {**_board(), "some_new_field_vision_never_heard_of": 42}

    monkeypatch.setattr(fed, "get_node_sysmon", fake)
    async with client(app) as c:
        r = await c.get(f"{PREFIX}/vms/pulse/nodes/{NORTH}/sysmon",
                        headers=auth(tenant_id=TENANT_A, permissions=["vms.camera.read"]))
    assert r.status_code == 200
    assert r.json()["some_new_field_vision_never_heard_of"] == 42
    assert r.json()["node_name"] == "north"


async def test_a_refusal_is_reported_as_a_refusal_not_as_a_dead_recorder(app, nodes, monkeypatch):
    async def fake(api_url, *, credential=None):
        raise fed.NodeRefused("403 from recorder: missing grant camera:read", status_code=403)

    monkeypatch.setattr(fed, "get_node_sysmon", fake)
    async with client(app) as c:
        r = await c.get(f"{PREFIX}/vms/pulse/nodes/{NORTH}/sysmon",
                        headers=auth(tenant_id=TENANT_A, permissions=["vms.camera.read"]))
    # 502 with the node's own sentence — a re-enrolment problem, not a network one.
    assert r.status_code == 502
    assert "missing grant" in r.text


async def test_an_unreachable_recorder_is_a_retryable_503(app, nodes, monkeypatch):
    async def fake(api_url, *, credential=None):
        raise fed.NodeUnavailable("timeout")

    monkeypatch.setattr(fed, "get_node_sysmon", fake)
    async with client(app) as c:
        r = await c.get(f"{PREFIX}/vms/pulse/nodes/{NORTH}/sysmon",
                        headers=auth(tenant_id=TENANT_A, permissions=["vms.camera.read"]))
    assert r.status_code == 503


async def test_the_fault_trace_reaches_the_owning_recorder_with_the_camera(app, nodes, monkeypatch):
    seen = {}

    async def fake(api_url, camera_id, *, profile=None, credential=None):
        seen.update(api_url=api_url, camera_id=camera_id, profile=profile, credential=credential)
        return {"verdict": {"level": "fault", "attribution": "network",
                            "summary": "NETWORK SEGMENT — the NVR application is cleared",
                            "nvr_cleared": True}, "stages": []}

    monkeypatch.setattr(fed, "isolate_node_camera", fake)
    async with client(app) as c:
        r = await c.get(f"{PREFIX}/vms/pulse/nodes/{NORTH}/cameras/cam-9/isolate?profile=sub",
                        headers=auth(tenant_id=TENANT_A, permissions=["vms.camera.read"]))
    assert r.status_code == 200, r.text
    assert seen == {"api_url": "http://north:8000", "camera_id": "cam-9",
                    "profile": "sub", "credential": "k1"}
    assert r.json()["verdict"]["nvr_cleared"] is True
    assert r.json()["node_name"] == "north"


async def test_a_recorder_in_another_tenant_is_not_found(app, nodes, monkeypatch):
    # 404, not 403: a tenant admin must not be able to probe which recorder ids
    # exist elsewhere.
    monkeypatch.setattr(fed, "get_node_sysmon", lambda *a, **k: _board())
    async with client(app) as c:
        r = await c.get(f"{PREFIX}/vms/pulse/nodes/{FOREIGN}/sysmon",
                        headers=auth(tenant_id=TENANT_A, permissions=["vms.camera.read"]))
    assert r.status_code == 404
