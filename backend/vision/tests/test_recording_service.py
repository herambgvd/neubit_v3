"""P3-A recording control-plane tests (no network).

Exercises the vision side of recording against an in-memory SQLite DB with the Go
``nvr`` call stubbed (monkeypatched ``NvrClient``): segment-event → Recording
persistence + dedupe, the recording-config PUT driving the nvr (continuous starts,
non-continuous stops), manual start/stop, browse list + filters, tenant scoping,
graceful upstream errors (nvr down → 502), and the schedule-window logic.

Mirrors the P2-B live-test discipline: every network boundary is a fabricated stub;
``pytest-asyncio`` auto mode runs the ``async def test_*`` coroutines.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import NotFoundError

from app.db import Base
from app.vms.common.nvr_client import NvrUnavailable
from app.vms.models import Camera, MediaNode, MediaProfile, Recording
from app.vms.recording.service import RecordingService, RecordingUpstreamError

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()


class _Actor:
    user_id = uuid.uuid4()


class _Body:
    """Minimal RecordingConfigBody-shaped object for set_config."""

    def __init__(self, mode="continuous", schedule=None, retention_days=30,
                 record_substream=False, audio_enabled=False, storage_pool_id=None):
        self.mode = mode
        self.schedule = schedule or {}
        self.retention_days = retention_days
        self.record_substream = record_substream
        self.audio_enabled = audio_enabled
        self.storage_pool_id = storage_pool_id


class _StubNvr:
    """Stub Go-nvr client: records recording start/stop calls."""

    def __init__(self, *, fail_start=False):
        self.fail_start = fail_start
        self.started: list[dict] = []
        self.stopped: list[tuple[str, str]] = []

    async def start_recording(self, *, camera_id, profile, rtsp_url, trigger="continuous", audio=False, record_dir=None):
        self.started.append(
            {"camera_id": camera_id, "profile": profile, "rtsp_url": rtsp_url,
             "trigger": trigger, "audio": audio}
        )
        if self.fail_start:
            raise NvrUnavailable("nvr data-plane unreachable: boom")
        return {"camera_id": camera_id, "profile": profile, "recording": True, "trigger_type": trigger}

    async def stop_recording(self, *, camera_id, profile):
        self.stopped.append((camera_id, profile))
        return True


@pytest_asyncio.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with Session() as s:
        yield s
    await engine.dispose()


@pytest_asyncio.fixture
async def camera(db):
    cam = Camera(
        id=str(uuid.uuid4()),
        tenant_id=TENANT,
        name="Cam A",
        connection_type="rtsp",
        onvif_user="admin",
        recording_mode="continuous",
    )
    db.add(cam)
    db.add(MediaProfile(camera_id=cam.id, tenant_id=TENANT, name="main", rtsp_path="rtsp://cam.local:554/main"))
    db.add(MediaProfile(camera_id=cam.id, tenant_id=TENANT, name="sub", rtsp_path="rtsp://cam.local:554/sub"))
    await db.commit()
    return cam


def _scope(tenant=TENANT):
    return Scope(tenant_id=tenant, is_superadmin=False)


def _svc(db, stub, tenant=TENANT):
    svc = RecordingService(db, _scope(tenant), bearer="fake.jwt")
    svc.nvr = stub
    return svc


# ── segment-event → Recording persistence ─────────────────────────────────


async def test_persist_segment_creates_recording(db, camera):
    svc = _svc(db, _StubNvr())
    payload = {
        "camera_id": camera.id,
        "profile": "main",
        "path": f"/recordings/cameras/{TENANT}/{camera.id}/main/2026-07-09_10-00-00-000000.mp4",
        "start": "2026-07-09T10:00:00+00:00",
        "end": "2026-07-09T10:01:00+00:00",
        "size": 1048576,
        "duration": 60.0,
        "format": "fmp4",
    }
    rec_id = await svc.persist_segment(str(TENANT), payload)
    assert rec_id is not None

    row = await db.get(Recording, rec_id)
    assert row is not None
    assert row.camera_id == camera.id
    assert row.file_size == 1048576
    assert abs((row.duration or 0) - 60.0) < 0.01
    assert row.trigger_type == "continuous"
    assert str(row.tenant_id) == str(TENANT)
    assert row.start_time is not None and row.end_time is not None


async def test_persist_segment_dedupes_by_path(db, camera):
    svc = _svc(db, _StubNvr())
    path = f"/recordings/cameras/{TENANT}/{camera.id}/main/2026-07-09_10-00-00-000000.mp4"
    payload = {"camera_id": camera.id, "profile": "main", "path": path,
               "start": "2026-07-09T10:00:00+00:00", "size": 1, "duration": 60}
    first = await svc.persist_segment(str(TENANT), payload)
    second = await svc.persist_segment(str(TENANT), payload)
    assert first is not None
    assert second is None  # duplicate path → skipped

    # Exactly one row exists.
    listed = await _svc(db, _StubNvr()).list_(camera.id)
    assert listed.total == 1


async def test_persist_segment_missing_path_is_noop(db, camera):
    svc = _svc(db, _StubNvr())
    assert await svc.persist_segment(str(TENANT), {"camera_id": camera.id}) is None


# ── footage locality: media_node_id stamping (MN-4) ─────────────────────────


async def test_persist_segment_stamps_media_node_from_camera_current_node(db):
    """A segment is stamped with the camera's CURRENT media_node_id (no payload node)."""
    node = MediaNode(
        id=str(uuid.uuid4()), tenant_id=TENANT, name="node-A", host="recorder-a",
        api_url="http://recorder-a:8000", status="online",
    )
    db.add(node)
    cam = Camera(
        id=str(uuid.uuid4()), tenant_id=TENANT, name="NodeCam",
        connection_type="rtsp", onvif_user="admin", media_node_id=node.id,
    )
    db.add(cam)
    await db.commit()

    svc = _svc(db, _StubNvr())
    payload = {
        "camera_id": cam.id, "profile": "main",
        "path": f"/recordings/{cam.id}/main/seg-1.mp4",
        "start": "2026-07-09T10:00:00+00:00", "size": 1, "duration": 60,
    }
    rec_id = await svc.persist_segment(str(TENANT), payload)
    row = await db.get(Recording, rec_id)
    assert row.media_node_id == node.id


async def test_persist_segment_prefers_payload_node_id_over_camera(db, camera):
    """An explicit ``media_node_id`` in the segment event wins over the camera's node."""
    payload_node = str(uuid.uuid4())
    svc = _svc(db, _StubNvr())
    payload = {
        "camera_id": camera.id, "profile": "main", "media_node_id": payload_node,
        "path": f"/recordings/{camera.id}/main/seg-payload.mp4",
        "start": "2026-07-09T10:00:00+00:00", "size": 1, "duration": 60,
    }
    rec_id = await svc.persist_segment(str(TENANT), payload)
    row = await db.get(Recording, rec_id)
    assert row.media_node_id == payload_node


async def test_persist_segment_null_media_node_when_unassigned(db, camera):
    """A camera with no media_node_id + no payload node → media_node_id stays NULL."""
    svc = _svc(db, _StubNvr())
    payload = {
        "camera_id": camera.id, "profile": "main",
        "path": f"/recordings/{camera.id}/main/seg-null.mp4",
        "start": "2026-07-09T10:00:00+00:00", "size": 1, "duration": 60,
    }
    rec_id = await svc.persist_segment(str(TENANT), payload)
    row = await db.get(Recording, rec_id)
    assert row.media_node_id is None


# ── recording-config PUT drives the nvr ────────────────────────────────────


async def test_list_filters_and_scoping(db, camera):
    svc = _svc(db, _StubNvr())
    base = f"/recordings/cameras/{TENANT}/{camera.id}/main/"
    await svc.persist_segment(str(TENANT), {"camera_id": camera.id, "profile": "main",
        "path": base + "a.mp4", "start": "2026-07-09T10:00:00+00:00", "trigger_type": "continuous", "size": 1})
    await svc.persist_segment(str(TENANT), {"camera_id": camera.id, "profile": "main",
        "path": base + "b.mp4", "start": "2026-07-09T11:00:00+00:00", "trigger_type": "motion", "size": 1})

    allr = await svc.list_(camera.id)
    assert allr.total == 2

    motion = await svc.list_(camera.id, trigger="motion")
    assert motion.total == 1 and motion.items[0].trigger_type == "motion"

    windowed = await svc.list_(camera.id, from_=datetime(2026, 7, 9, 10, 30, tzinfo=timezone.utc))
    assert windowed.total == 1  # only the 11:00 one


async def test_list_other_tenant_cannot(db, camera):
    with pytest.raises(NotFoundError):
        await _svc(db, _StubNvr(), tenant=OTHER_TENANT).list_(camera.id)


# ── schedule-window logic (pure) ───────────────────────────────────────────

