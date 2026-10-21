"""A RECORDER THAT STOPS ANSWERING KEEPS ITS CAMERAS ON SCREEN (SCRUM-334).

The VMS kept no copy of any recorder's cameras. Every list was a live fan-out, and a
recorder the heartbeat had marked offline was skipped before the call and reported
nowhere: not in ``items``, not in ``unreachable``. The endpoint answered 200 with
fewer cameras, every client replaced its data, and closing one recorder emptied the
live wall, the camera list and that recorder's own detail pane ("runs no cameras
yet"). Pulse lost it from its totals, and nothing anywhere said a recorder was down.

Every VMS treats a camera as configuration: the server going down switches its
cameras to offline, keeps them in the tree and the layouts, and raises a "server not
responding" event. These tests hold this one to that.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.vms.events import service as events_svc
from app.vms.federation import client as fed
from app.vms.federation import inventory
from app.vms.media_nodes import service as node_service
from app.vms.media_nodes.service import NodeHeartbeatMonitor
from app.vms.models import MediaNode, NodeCamera, VmsEvent

from .conftest import PREFIX, auth, client

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()
CAMERAS_URL = f"{PREFIX}/vms/federation/cameras"
PULSE_URL = f"{PREFIX}/vms/pulse/overview"


def _headers() -> dict:
    return auth(tenant_id=TENANT, permissions=["vms.camera.read"])


async def _node(sm, name: str, status: str) -> MediaNode:
    async with sm() as s:
        n = MediaNode(
            id=str(uuid.uuid4()), tenant_id=TENANT, name=name, host=name,
            api_url=f"http://{name}:8000", credential=f"key-{name}", status=status,
        )
        s.add(n)
        await s.commit()
        await s.refresh(n)
        return n


def _cam(cid: str, name: str, channel: int | None = None) -> dict:
    return {"id": cid, "name": name, "status": "online", "channel_number": channel,
            "recording": {"mode": "continuous"}}


async def _keep(sm, node: MediaNode, cams: list[dict]) -> None:
    async with sm() as s:
        await inventory.sync_node_cameras(s, node, cams)
        await s.commit()


async def _kept(sm, node: MediaNode) -> set[str]:
    async with sm() as s:
        rows = (await s.execute(select(NodeCamera).where(NodeCamera.node_id == node.id))).scalars()
        return {r.remote_id for r in rows}


@pytest.fixture
def published(monkeypatch):
    out: list[tuple[str, dict]] = []

    async def _emit(tenant_id, event_type, payload, **kw):
        out.append((event_type, payload))
        return f"tenant.{tenant_id}.vms.camera.{event_type}"

    monkeypatch.setattr(events_svc, "emit_camera_event", _emit)
    return out


def _probe(monkeypatch, up: dict[str, bool]):
    """Each recorder answers /health per ``up[name]``."""

    async def _p(api_url, *, timeout=None):
        name = api_url.removeprefix("http://").removesuffix(":8000")
        return up.get(name, False), {}

    monkeypatch.setattr(node_service, "probe_node", _p)


def _lists(monkeypatch, cams: dict[str, list[dict]]):
    """Each recorder's camera list, as the heartbeat and the estate read it."""

    async def _l(api_url, credential=None, **kw):
        name = api_url.removeprefix("http://").removesuffix(":8000")
        if name not in cams:
            raise fed.NodeUnavailable("[Errno 111] Connection refused")
        return [dict(c) for c in cams[name]]

    monkeypatch.setattr(fed, "list_estate_cameras", _l)


# ── the estate list ──────────────────────────────────────────────────────────


async def test_a_down_recorders_cameras_stay_listed_as_recorder_offline(
    app, http_sessionmaker, monkeypatch
):
    """The bug, exactly: the recorder is closed, the heartbeat has it offline."""
    up = await _node(http_sessionmaker, "rec-up", "online")
    down = await _node(http_sessionmaker, "rec-down", "offline")
    await _keep(http_sessionmaker, down, [_cam("c2", "Gate", 2), _cam("c1", "Lobby", 1)])
    _lists(monkeypatch, {"rec-up": [_cam("u1", "Yard")]})

    async with client(app) as c:
        r = await c.get(CAMERAS_URL, headers=_headers())

    assert r.status_code == 200, r.text
    body = r.json()
    by_node = {}
    for cam in body["items"]:
        by_node.setdefault(cam["node_name"], []).append(cam)

    assert [c["name"] for c in by_node["rec-down"]] == ["Lobby", "Gate"], (
        "a down recorder's cameras must stay listed, in channel order"
    )
    for cam in by_node["rec-down"]:
        assert cam["status"] == "offline"  # so nothing dials it
        assert cam["node_reachable"] is False
        assert cam["status_reason"] == inventory.RECORDER_OFFLINE
        assert cam["last_synced_at"]
        assert cam["node_id"] == str(down.id)
        assert cam["recording"] == {"mode": "continuous"}, "the kept row keeps its shape"

    assert by_node["rec-up"][0]["node_reachable"] is True
    assert by_node["rec-up"][0]["status"] == "online"
    assert {u["name"] for u in body["unreachable"]} == {"rec-down"}, (
        "a down recorder must be NAMED as unreachable, not silently left out"
    )
    assert body["nodes"] == 2
    assert up.id != down.id


async def test_a_recorder_that_fails_the_read_is_served_from_its_kept_copy(
    app, http_sessionmaker, monkeypatch
):
    """Still "online" on the heartbeat, but this read failed — the window before the
    next heartbeat notices. Its cameras must not blink out either."""
    node = await _node(http_sessionmaker, "rec-flaky", "online")
    await _keep(http_sessionmaker, node, [_cam("c1", "Lobby")])
    _lists(monkeypatch, {})  # every read fails

    async with client(app) as c:
        body = (await c.get(CAMERAS_URL, headers=_headers())).json()

    assert [c["status_reason"] for c in body["items"]] == [inventory.RECORDER_UNREACHABLE]
    assert body["unreachable"][0]["error"] == "[Errno 111] Connection refused"


# ── the heartbeat keeps the copy ─────────────────────────────────────────────


async def test_the_heartbeat_keeps_the_list_and_drops_only_what_the_recorder_removed(
    http_sessionmaker, monkeypatch, published
):
    node = await _node(http_sessionmaker, "rec-a", "online")
    monitor = NodeHeartbeatMonitor(http_sessionmaker)

    _probe(monkeypatch, {"rec-a": True})
    _lists(monkeypatch, {"rec-a": [_cam("c1", "Lobby"), _cam("c2", "Gate")]})
    await monitor.run_cycle()
    assert await _kept(http_sessionmaker, node) == {"c1", "c2"}

    # Deleted ON the recorder: gone here on the next successful sync.
    _lists(monkeypatch, {"rec-a": [_cam("c1", "Lobby (renamed)")]})
    await monitor.run_cycle()
    assert await _kept(http_sessionmaker, node) == {"c1"}
    async with http_sessionmaker() as s:
        row = (await s.execute(select(NodeCamera).where(NodeCamera.node_id == node.id))).scalar_one()
    assert row.name == "Lobby (renamed)"

    # Down: the copy is exactly what it was.
    _probe(monkeypatch, {"rec-a": False})
    await monitor.run_cycle()
    assert await _kept(http_sessionmaker, node) == {"c1"}
    async with http_sessionmaker() as s:
        assert (await s.get(MediaNode, node.id)).status == "offline"


async def test_a_full_page_never_removes_a_camera(http_sessionmaker, monkeypatch, published):
    """A list as long as the page may be cut short, so it proves nothing about the
    cameras past it."""
    monkeypatch.setattr(inventory, "ESTATE_CAMERA_PAGE", 2)
    node = await _node(http_sessionmaker, "rec-big", "online")
    await _keep(http_sessionmaker, node, [_cam("c1", "a"), _cam("c2", "b"), _cam("c3", "c")])

    _probe(monkeypatch, {"rec-big": True})
    _lists(monkeypatch, {"rec-big": [_cam("c1", "a"), _cam("c2", "b")]})
    await NodeHeartbeatMonitor(http_sessionmaker).run_cycle()

    assert await _kept(http_sessionmaker, node) == {"c1", "c2", "c3"}


async def test_deleting_the_recorder_deletes_its_kept_cameras():
    """The copy belongs to the recorder: deleting the recorder from the VMS takes its
    cameras with it. Asserted on the schema, which SQLite does not enforce."""
    fk = next(iter(NodeCamera.__table__.c.node_id.foreign_keys))
    assert fk.column.table.name == "media_nodes"
    assert fk.ondelete == "CASCADE"


# ── a recorder going down is news ────────────────────────────────────────────


async def test_a_recorder_going_down_and_coming_back_is_announced(
    http_sessionmaker, monkeypatch, published
):
    node = await _node(http_sessionmaker, "rec-a", "online")
    monitor = NodeHeartbeatMonitor(http_sessionmaker)
    _lists(monkeypatch, {"rec-a": [_cam("c1", "Lobby")]})

    _probe(monkeypatch, {"rec-a": False})
    await monitor.run_cycle()
    await monitor.run_cycle()  # still down: not news twice

    _probe(monkeypatch, {"rec-a": True})
    await monitor.run_cycle()

    assert [t for t, _ in published] == ["recorder_offline", "recorder_online"]
    async with http_sessionmaker() as s:
        rows = (await s.execute(select(VmsEvent).order_by(VmsEvent.occurred_at))).scalars().all()
    offline = next(r for r in rows if r.event_type == "recorder_offline")
    assert offline.severity == "critical"
    assert offline.camera_id is None
    assert offline.raw["node_id"] == str(node.id)
    assert "rec-a" in offline.title
    back = next(r for r in rows if r.event_type == "recorder_online")
    assert back.severity == "info"


async def test_two_recorders_down_at_once_are_two_events(
    http_sessionmaker, monkeypatch, published
):
    """A camera-less event used to dedupe on (type, time-bucket) alone, so the second
    recorder to drop in the same window would never have been raised."""
    await _node(http_sessionmaker, "rec-a", "online")
    await _node(http_sessionmaker, "rec-b", "online")
    _probe(monkeypatch, {})
    _lists(monkeypatch, {})

    await NodeHeartbeatMonitor(http_sessionmaker).run_cycle()

    assert sorted(p["title"] for t, p in published if t == "recorder_offline") == [
        "Recorder offline · rec-a",
        "Recorder offline · rec-b",
    ]


async def test_an_unknown_or_draining_recorder_announces_nothing(
    http_sessionmaker, monkeypatch, published
):
    await _node(http_sessionmaker, "rec-new", "unknown")
    await _node(http_sessionmaker, "rec-drain", "draining")
    _probe(monkeypatch, {})
    await NodeHeartbeatMonitor(http_sessionmaker).run_cycle()
    assert published == []


# ── Pulse counts it ──────────────────────────────────────────────────────────


async def test_pulse_counts_a_down_recorder_and_says_so(app, http_sessionmaker):
    await _node(http_sessionmaker, "rec-down", "offline")

    async with client(app) as c:
        r = await c.get(PULSE_URL, headers=_headers())

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["totals"]["recorders"] == 1, "a down recorder vanished from the estate count"
    kinds = [(i["kind"], i["where"]) for i in body["attention"]]
    assert ("recorder_unreachable", "rec-down") in kinds
