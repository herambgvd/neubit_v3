"""P5-A camera device-event ingestion tests (no network, no NATS).

Exercises the vision events domain against an in-memory SQLite DB with the NATS emit
captured (monkeypatched ``emit_camera_event``): the normalize→dedupe→persist→publish
path (device + system events), the topic allow-list filter, the events feed
(filters + tenant scoping), ack, and the graceful supervisor reconcile / subscription
lifecycle driven by a FABRICATED ONVIF notification (no real ONVIF device).

Mirrors the P3-A recording-test discipline: every boundary is a stub; ``pytest-asyncio``
auto mode runs the ``async def test_*`` coroutines.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import NotFoundError

from app.db import Base
from app.vms.events import normalize as norm
from app.vms.events import service as events_svc
from app.vms.events import supervisor as sup_mod
from app.vms.events.normalize import dedup_key, normalize_event_type
from app.vms.events.service import VmsEventService
from app.vms.events.supervisor import EventSupervisor
from app.vms.models import Camera, MediaNode, VmsEvent

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()
PLATFORM = Scope(tenant_id=None, is_superadmin=True)


class _Actor:
    user_id = uuid.uuid4()


@pytest_asyncio.fixture
async def engine():
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def db(engine):
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with Session() as s:
        yield s


@pytest_asyncio.fixture
async def camera(db):
    cam = Camera(
        id=str(uuid.uuid4()),
        tenant_id=TENANT,
        name="Cam A",
        brand="onvif",
        connection_type="onvif",
        onvif_host="10.0.0.5",
        onvif_port=80,
        onvif_user="admin",
        onvif_events_enabled=True,
    )
    db.add(cam)
    await db.commit()
    return cam


@pytest.fixture
def capture(monkeypatch):
    """Capture every ``emit_camera_event`` call (subject-ish + payload)."""
    published: list[tuple] = []

    async def _emit(tenant_id, event_type, payload, **kw):
        published.append((tenant_id, event_type, payload))
        return f"tenant.{tenant_id or 'platform'}.vms.camera.{event_type}"

    monkeypatch.setattr(events_svc, "emit_camera_event", _emit)
    return published


# ── normalize (pure) ──────────────────────────────────────────────────────


def test_normalize_folds_driver_types():
    assert normalize_event_type("motion_detected") == "motion"
    assert normalize_event_type("camera_tamper") == "tamper"
    assert normalize_event_type("digital_input_change") == "io_input"
    assert normalize_event_type("line_crossing") == "line_crossing"
    assert normalize_event_type("zone_intrusion") == "zone_intrusion"
    assert normalize_event_type("audio_alarm") == "audio"
    assert normalize_event_type("video_loss") == "video_loss"
    # Already-normalized passes through; unknown → system (never dropped).
    assert normalize_event_type("motion") == "motion"
    assert normalize_event_type("something_weird") == "system"


def test_dedup_key_buckets_time():
    t0 = datetime(2026, 7, 9, 10, 0, 0, tzinfo=timezone.utc)
    t1 = t0 + timedelta(seconds=3)   # same 10s bucket
    t2 = t0 + timedelta(seconds=30)  # different bucket
    assert dedup_key("cam-1", "motion", t0, window_sec=10) == dedup_key("cam-1", "motion", t1, window_sec=10)
    assert dedup_key("cam-1", "motion", t0, window_sec=10) != dedup_key("cam-1", "motion", t2, window_sec=10)
    # Different camera / type → different key.
    assert dedup_key("cam-2", "motion", t0, window_sec=10) != dedup_key("cam-1", "motion", t0, window_sec=10)
    assert dedup_key("cam-1", "tamper", t0, window_sec=10) != dedup_key("cam-1", "motion", t0, window_sec=10)


# ── ingest: normalize → dedupe → persist → publish ─────────────────────────


async def test_ingest_device_event_persists_and_publishes(db, camera, capture):
    svc = VmsEventService(db, PLATFORM)
    eid = await svc.ingest_device_event(
        tenant_id=camera.tenant_id,
        camera_id=camera.id,
        driver_event_type="motion_detected",
        severity="alarm",
        title="Motion detected",
        raw={"onvif_topic": "tns1:VideoSource/MotionAlarm"},
        occurred_at="2026-07-09T10:00:00+00:00",
    )
    assert eid is not None

    row = await db.get(VmsEvent, eid)
    assert row.event_type == "motion"          # normalized
    assert row.severity == "alarm"
    assert row.source == "onvif"
    assert str(row.tenant_id) == str(TENANT)
    assert row.published is True

    # Published on the EXACT camera-event stream (subject vms.camera.motion).
    assert len(capture) == 1
    tid, etype, payload = capture[0]
    assert str(tid) == str(TENANT)
    assert etype == "motion"
    assert payload["camera_id"] == camera.id
    assert payload["event_type"] == "motion"
    assert payload["severity"] == "alarm"
    # SQLite drops tz on round-trip (Postgres keeps it); assert the instant.
    assert payload["occurred_at"].startswith("2026-07-09T10:00:00")


async def test_ingest_dedupes_rapid_duplicate(db, camera, capture):
    svc = VmsEventService(db, PLATFORM)
    kw = dict(
        tenant_id=camera.tenant_id, camera_id=camera.id,
        driver_event_type="motion_detected", severity="alarm", title="Motion",
        occurred_at="2026-07-09T10:00:00+00:00",
    )
    first = await svc.ingest_device_event(**kw)
    # Same camera+type, 2s later → same 10s bucket → deduped.
    second = await svc.ingest_device_event(**{**kw, "occurred_at": "2026-07-09T10:00:02+00:00"})
    assert first is not None
    assert second is None                     # duplicate dropped
    assert len(capture) == 1                   # only one publish

    listed = await svc.list_()
    assert listed.total == 1


async def test_ingest_topic_allow_list_filters(db, camera, capture):
    svc = VmsEventService(db, PLATFORM)
    # Camera only wants "tamper" — a motion event is filtered out.
    out = await svc.ingest_device_event(
        tenant_id=camera.tenant_id, camera_id=camera.id,
        driver_event_type="motion_detected", severity="alarm", title="Motion",
        topic_allow=["tamper"],
    )
    assert out is None
    assert capture == []


async def test_ingest_system_event(db, camera, capture):
    svc = VmsEventService(db, PLATFORM)
    eid = await svc.ingest_system_event(
        tenant_id=camera.tenant_id, camera_id=camera.id,
        event_type="camera_offline", title="Camera offline",
    )
    row = await db.get(VmsEvent, eid)
    assert row.event_type == "camera_offline"
    assert row.source == "system"
    assert row.severity == "warning"
    assert capture and capture[0][1] == "camera_offline"


# ── events feed: filters + tenant scoping ──────────────────────────────────


async def test_list_filters(db, camera, capture):
    svc = VmsEventService(db, PLATFORM)
    await svc.ingest_device_event(tenant_id=camera.tenant_id, camera_id=camera.id,
        driver_event_type="motion_detected", severity="alarm", title="m",
        occurred_at="2026-07-09T10:00:00+00:00")
    await svc.ingest_device_event(tenant_id=camera.tenant_id, camera_id=camera.id,
        driver_event_type="camera_tamper", severity="alarm", title="t",
        occurred_at="2026-07-09T11:00:00+00:00")

    tenant_svc = VmsEventService(db, Scope(tenant_id=TENANT, is_superadmin=False))
    assert (await tenant_svc.list_()).total == 2
    assert (await tenant_svc.list_(event_type="motion")).total == 1
    assert (await tenant_svc.list_(severity="alarm")).total == 2
    windowed = await tenant_svc.list_(from_=datetime(2026, 7, 9, 10, 30, tzinfo=timezone.utc))
    assert windowed.total == 1  # only the 11:00 tamper


async def test_list_tenant_isolation(db, camera, capture):
    svc = VmsEventService(db, PLATFORM)
    await svc.ingest_device_event(tenant_id=camera.tenant_id, camera_id=camera.id,
        driver_event_type="motion_detected", severity="alarm", title="m")
    # Another tenant sees nothing.
    other = VmsEventService(db, Scope(tenant_id=OTHER_TENANT, is_superadmin=False))
    assert (await other.list_()).total == 0


async def test_list_for_camera_ownership(db, camera, capture):
    svc = VmsEventService(db, PLATFORM)
    await svc.ingest_device_event(tenant_id=camera.tenant_id, camera_id=camera.id,
        driver_event_type="motion_detected", severity="alarm", title="m")
    other = VmsEventService(db, Scope(tenant_id=OTHER_TENANT, is_superadmin=False))
    with pytest.raises(NotFoundError):
        await other.list_for_camera(camera.id)


# ── ack ─────────────────────────────────────────────────────────────────────


async def test_ack_sets_acknowledged(db, camera, capture):
    svc = VmsEventService(db, PLATFORM)
    eid = await svc.ingest_device_event(tenant_id=camera.tenant_id, camera_id=camera.id,
        driver_event_type="motion_detected", severity="alarm", title="m")
    tenant_svc = VmsEventService(db, Scope(tenant_id=TENANT, is_superadmin=False))
    pub = await tenant_svc.ack(eid, actor=_Actor())
    assert pub.acknowledged is True
    assert pub.acknowledged_by == str(_Actor.user_id)
    assert pub.acknowledged_at is not None

    row = await db.get(VmsEvent, eid)
    assert row.acknowledged is True


async def test_ack_other_tenant_cannot(db, camera, capture):
    svc = VmsEventService(db, PLATFORM)
    eid = await svc.ingest_device_event(tenant_id=camera.tenant_id, camera_id=camera.id,
        driver_event_type="motion_detected", severity="alarm", title="m")
    other = VmsEventService(db, Scope(tenant_id=OTHER_TENANT, is_superadmin=False))
    with pytest.raises(NotFoundError):
        await other.ack(eid, actor=_Actor())


# ── supervisor: polls each recorder's ledger ─────────────────────────────────
#
# The supervisor no longer subscribes to cameras — the recorder that owns a camera
# does that, and a second subscriber on a device that permits one gets silence rather
# than an error. So these exercise the poll: what it asks each node for, that it
# ingests what comes back, that an overlapping re-read does NOT duplicate an event,
# and that an unreachable recorder neither crashes the tick nor advances past events
# it has not seen.


def _node_event(**over):
    """One event shaped as the recorder serves it (store.Event)."""
    ev = {
        "id": "ev-1",
        "camera_id": None,  # filled by the caller
        "camera_name": "Gate",
        "type": "motion",
        "topic": "tns1:VideoSource/MotionAlarm",
        "severity": "alarm",
        "source": "onvif_pullpoint",
        "payload": {"state": True},
        "stateful": True,
        "started_at": "2026-07-09T10:00:00Z",
        "ended_at": None,
        "created_at": "2026-07-09T10:00:01Z",
    }
    ev.update(over)
    return ev


def _stub_node_events(monkeypatch, batches):
    """Answer list_events_node from `batches` (one per call), recording the asks."""
    asks = []
    seq = list(batches)

    async def _list(api_url, *, since=None, limit=200, credential=None):
        asks.append({"api_url": api_url, "since": since, "limit": limit, "credential": credential})
        return {"items": seq.pop(0) if seq else [], "total": 0}

    monkeypatch.setattr("app.vms.events.supervisor.fed.list_events_node", _list)
    return asks


async def _mk_node(db):
    node = MediaNode(
        id=str(uuid.uuid4()), tenant_id=TENANT, name="recorder-a", host="rec-a",
        api_url="http://rec-a:8000", credential="scoped-key", status="online",
    )
    db.add(node)
    await db.commit()
    return node


async def test_poll_ingests_a_recorder_event(engine, db, camera, capture, monkeypatch):
    node = await _mk_node(db)
    asks = _stub_node_events(monkeypatch, [[_node_event(camera_id=camera.id)]])

    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    sup = EventSupervisor(maker)
    await sup._tick()

    # It asked the right recorder, with the recorder's own scoped credential.
    assert asks and asks[0]["api_url"] == "http://rec-a:8000"
    assert asks[0]["credential"] == "scoped-key"

    async with maker() as s:
        listed = await VmsEventService(s, PLATFORM).list_()
    assert listed.total == 1 and listed.items[0].event_type == "motion"
    assert capture and capture[0][1] == "motion"
    assert node.id in sup._watermark  # noqa: SLF001 — the watermark is the point


async def test_an_overlapping_poll_does_not_duplicate(engine, db, camera, monkeypatch):
    """`since` is inclusive on the node, so consecutive polls overlap BY DESIGN.

    The same event served twice must land once, and the reason is specific: the dedup
    key buckets ``occurred_at``, and occurred_at is taken from the NODE's own
    started_at — a fixed value, the same on every re-read.

    The two polls are deliberately separated by more than one dedup window (the
    supervisor's clock is advanced an hour between them). Without that gap this test
    passes whatever occurred_at is stamped with, because both ticks land in the same
    bucket anyway — it proves nothing, which is exactly what an earlier version of it
    did. With the gap, stamping the poll time instead of started_at puts the two
    reads in different buckets and the alarm doubles.
    """
    await _mk_node(db)
    ev = _node_event(camera_id=camera.id)
    _stub_node_events(monkeypatch, [[ev], [ev]])

    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    sup = EventSupervisor(maker)
    await sup._tick()

    later = datetime.now(timezone.utc) + timedelta(hours=1)
    monkeypatch.setattr(sup_mod, "_utcnow", lambda: later)
    await sup._tick()

    async with maker() as s:
        listed = await VmsEventService(s, PLATFORM).list_()
    assert listed.total == 1, "the same recorder event was ingested twice"


async def test_an_unreachable_recorder_does_not_advance_the_watermark(engine, db, monkeypatch):
    """A recorder that is rebooting must not cause its events to be SKIPPED.

    Advancing the watermark on a failed poll would ask for everything after a window
    that was never read — the events in it are gone from the estate feed for good.
    """
    node = await _mk_node(db)
    from app.vms.federation import client as fed_client

    async def _down(api_url, *, since=None, limit=200, credential=None):
        raise fed_client.NodeUnavailable("connection refused")

    monkeypatch.setattr("app.vms.events.supervisor.fed.list_events_node", _down)

    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    sup = EventSupervisor(maker)
    await sup._tick()  # must not raise
    assert node.id not in sup._watermark  # noqa: SLF001


async def test_one_bad_recorder_does_not_stop_the_others(engine, db, camera, monkeypatch):
    good = await _mk_node(db)
    bad = MediaNode(
        id=str(uuid.uuid4()), tenant_id=TENANT, name="recorder-b", host="rec-b",
        api_url="http://rec-b:8000", credential="k2", status="online",
    )
    db.add(bad)
    await db.commit()

    from app.vms.federation import client as fed_client

    async def _list(api_url, *, since=None, limit=200, credential=None):
        if "rec-b" in api_url:
            raise fed_client.NodeUnavailable("down")
        return {"items": [_node_event(camera_id=camera.id)], "total": 1}

    monkeypatch.setattr("app.vms.events.supervisor.fed.list_events_node", _list)

    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    sup = EventSupervisor(maker)
    await sup._tick()

    async with maker() as s:
        listed = await VmsEventService(s, PLATFORM).list_()
    assert listed.total == 1
    assert good.id in sup._watermark and bad.id not in sup._watermark  # noqa: SLF001
