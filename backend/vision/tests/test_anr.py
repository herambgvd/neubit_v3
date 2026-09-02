"""P6-A ANR fulfiller tests (no network, no real ffmpeg).

Exercises the vision side of ANR (edge-recording backfill) against an in-memory SQLite
DB with the brand driver + the ffmpeg pull stubbed:

  * request → source-resolution (NVR channel vs edge/Profile-G camera) → P4-B footage
    search → ffmpeg pull → the pulled segment lands under the segment-tracker layout;
  * the AnrConsumer end-to-end: publish an ``anr.request`` on a fake bus → the request is
    consumed, the driver search invoked, and an ``anr.result{status,job_id}`` published;
  * graceful failure: an unreachable device / no footage / an ffmpeg error →
    ``result{status:failed}`` with no crash;
  * idempotency: a duplicate in-flight ``job_id`` redelivery is dropped;
  * tenant isolation: a foreign camera → a clean failed result.

Mirrors the P4-B footage-test discipline: every boundary is a fabricated stub;
``pytest-asyncio`` auto mode runs the ``async def test_*`` coroutines.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope

from app.db import Base
from app.vms.anr.consumer import AnrConsumer
from app.vms.anr.service import AnrFulfiller, AnrRequest, scope_for
from app.vms.common.crypto import encrypt_secret
from app.vms.models import NVR, Camera

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()

GAP_FROM = datetime(2026, 7, 9, 10, 0, 0, tzinfo=timezone.utc)
GAP_TO = datetime(2026, 7, 9, 10, 5, 0, tzinfo=timezone.utc)


# ── stubs ──────────────────────────────────────────────────────────────────


class _StubDriver:
    """Brand-driver stub: canned search matches + a playback URI (or None). Records calls."""

    def __init__(self, *, matches=None, playback_uri="rtsp://dev/playback?start=x&end=y", raise_search=False):
        self._matches = matches if matches is not None else [
            {"start_time": GAP_FROM.isoformat(), "end_time": GAP_TO.isoformat(), "recording_token": "rec-7"}
        ]
        self._playback_uri = playback_uri
        self._raise_search = raise_search
        self.searched: list[dict] = []
        self.playback_calls: list[dict] = []
        self.aclosed = False

    async def search_recordings(self, host, creds, *, channel=None, start_time=None, end_time=None):
        self.searched.append({"host": host, "channel": channel, "start": start_time, "end": end_time})
        if self._raise_search:
            raise RuntimeError("device unreachable")
        return self._matches

    async def get_playback_uri(self, host, creds, *, channel=None, start_time=None, end_time=None, recording_token=None):
        self.playback_calls.append({"host": host, "channel": channel, "token": recording_token})
        return self._playback_uri

    async def aclose(self):
        self.aclosed = True


class _FakeBus:
    """A minimal EventBus stand-in: captures published events + drives a subscribed handler."""

    def __init__(self):
        self.published: list[tuple[str, dict]] = []
        self._handlers: list = []

    async def subscribe(self, pattern, handler, *, durable=None):
        self._handlers.append(handler)

    async def publish(self, subj, payload=None):
        self.published.append((subj, payload or {}))

    async def deliver(self, tenant_id, payload):
        """Simulate the nvr publishing an anr.request into the subscribed handler."""
        env = {"tenant_id": tenant_id, "payload": payload, "type": "vms.anr.request"}
        for h in list(self._handlers):
            await h(env)


# ── fixtures ─────────────────────────────────────────────────────────────────


@pytest_asyncio.fixture
async def engine():
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def sessionmaker(engine):
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


@pytest_asyncio.fixture
async def db(sessionmaker):
    async with sessionmaker() as s:
        yield s


async def _add_nvr_camera(db) -> tuple[Camera, NVR]:
    nvr = NVR(
        id=str(uuid.uuid4()), tenant_id=TENANT, name="NVR One", brand="hikvision",
        host="10.0.0.5", port=80, username="admin", enc_creds=encrypt_secret("pw"),
        status="online",
    )
    cam = Camera(
        id=str(uuid.uuid4()), tenant_id=TENANT, name="Ch 3", connection_type="nvr_channel",
        brand="hikvision", nvr_id=nvr.id, nvr_channel_number=3, anr_enabled=True,
        recording_mode="continuous",
    )
    db.add(nvr)
    db.add(cam)
    await db.commit()
    return cam, nvr


async def _add_edge_camera(db) -> Camera:
    cam = Camera(
        id=str(uuid.uuid4()), tenant_id=TENANT, name="Edge Cam", connection_type="onvif",
        brand="onvif", onvif_host="10.0.0.9", onvif_port=80, onvif_user="admin",
        onvif_enc_pass=encrypt_secret("pw"), anr_enabled=True, recording_mode="continuous",
    )
    db.add(cam)
    await db.commit()
    return cam


def _request(camera_id: str, *, tenant=str(TENANT), job_id=42, profile="main", record_path=None) -> AnrRequest:
    return AnrRequest.from_event(
        tenant,
        {
            "job_id": job_id, "camera_id": camera_id, "profile": profile,
            "gap_from": GAP_FROM.isoformat(), "gap_to": GAP_TO.isoformat(),
            "record_path": record_path,
        },
    )


@pytest.fixture(autouse=True)
def _isolate_recordings(tmp_path, monkeypatch):
    """Point the recordings volume at a temp dir so pulled segments don't touch /recordings."""
    monkeypatch.setenv("VE_RECORDINGS_DIR", str(tmp_path))


def _patch_driver(monkeypatch, driver):
    import app.vms.anr.service as mod
    monkeypatch.setattr(mod, "get_driver", lambda brand: driver)


def _patch_pull(monkeypatch, *, fail=False, record: list | None = None):
    """Replace the real ffmpeg pull with a stub that writes a small file (or fails)."""
    import app.vms.anr.service as mod
    from app.vms.anr.ffmpeg import AnrFfmpegError

    async def _fake_pull(source_uri, out_path, *, duration_sec=None):
        if record is not None:
            record.append({"uri": source_uri, "out": out_path, "dur": duration_sec})
        if fail:
            raise AnrFfmpegError("ffmpeg exited 1: boom")
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "wb") as fh:
            fh.write(b"\x00" * 1024)
        return 1024

    monkeypatch.setattr(mod, "pull_segment", _fake_pull)


# ── fulfiller: source resolution + pull ──────────────────────────────────────


async def test_fulfill_nvr_channel_searches_and_pulls(db, monkeypatch):
    cam, nvr = await _add_nvr_camera(db)
    driver = _StubDriver()
    pulls: list = []
    _patch_driver(monkeypatch, driver)
    _patch_pull(monkeypatch, record=pulls)

    svc = AnrFulfiller(db, scope_for(str(TENANT)))
    result = await svc.fulfill(_request(cam.id))

    assert result.status == "done"
    assert result.backfilled_segments == 1
    # P4-B search was invoked over the gap window for the NVR channel.
    assert driver.searched and driver.searched[0]["channel"] == 3
    assert driver.playback_calls and driver.playback_calls[0]["token"] == "rec-7"
    assert driver.aclosed is True
    # The pulled segment landed under the tracker layout cameras/<tenant>/<cam>/main/…mp4
    assert pulls, "pull was not invoked"
    out = pulls[0]["out"]
    assert f"/cameras/{TENANT}/{cam.id}/main/" in out
    assert out.endswith(".mp4")
    assert os.path.exists(out)
    # filename is the gap-start timestamp (MediaMTX %Y-%m-%d_%H-%M-%S-%f)
    assert os.path.basename(out).startswith("2026-07-09_10-00-00-")


async def test_fulfill_edge_camera_uses_its_own_driver(db, monkeypatch):
    cam = await _add_edge_camera(db)
    driver = _StubDriver()
    _patch_driver(monkeypatch, driver)
    _patch_pull(monkeypatch)

    svc = AnrFulfiller(db, scope_for(str(TENANT)))
    result = await svc.fulfill(_request(cam.id))

    assert result.status == "done"
    # Edge source → the camera's own host, not an NVR host.
    assert driver.searched[0]["host"] == "10.0.0.9"


async def test_fulfill_honours_nvr_record_path(db, monkeypatch):
    cam, nvr = await _add_nvr_camera(db)
    driver = _StubDriver()
    pulls: list = []
    _patch_driver(monkeypatch, driver)
    _patch_pull(monkeypatch, record=pulls)

    rec_path = "/recordings/cameras/tenantX/camY/main"
    svc = AnrFulfiller(db, scope_for(str(TENANT)))
    result = await svc.fulfill(_request(cam.id, record_path=rec_path))

    assert result.status == "done"
    assert pulls[0]["out"].startswith(rec_path + "/")


# ── fulfiller: graceful failure ──────────────────────────────────────────────


async def test_fulfill_no_footage_fails_gracefully(db, monkeypatch):
    cam, nvr = await _add_nvr_camera(db)
    driver = _StubDriver(matches=[])  # device reachable but has no footage for the gap
    _patch_driver(monkeypatch, driver)
    _patch_pull(monkeypatch)

    result = await AnrFulfiller(db, scope_for(str(TENANT))).fulfill(_request(cam.id))
    assert result.status == "failed"
    assert "no on-device footage" in (result.error or "")


async def test_fulfill_unreachable_search_fails_gracefully(db, monkeypatch):
    cam, nvr = await _add_nvr_camera(db)
    driver = _StubDriver(raise_search=True)
    _patch_driver(monkeypatch, driver)
    _patch_pull(monkeypatch)

    result = await AnrFulfiller(db, scope_for(str(TENANT))).fulfill(_request(cam.id))
    assert result.status == "failed"
    assert "footage search failed" in (result.error or "")
    assert driver.aclosed is True  # driver still cleaned up


async def test_fulfill_ffmpeg_error_fails_gracefully(db, monkeypatch):
    cam, nvr = await _add_nvr_camera(db)
    driver = _StubDriver()
    _patch_driver(monkeypatch, driver)
    _patch_pull(monkeypatch, fail=True)

    result = await AnrFulfiller(db, scope_for(str(TENANT))).fulfill(_request(cam.id))
    assert result.status == "failed"
    assert "ffmpeg exited" in (result.error or "")


async def test_fulfill_no_source_fails(db, monkeypatch):
    # Camera with neither an NVR link nor an onvif_host / ip → no footage source.
    cam = Camera(
        id=str(uuid.uuid4()), tenant_id=TENANT, name="No Source",
        connection_type="rtsp", brand="onvif", anr_enabled=True,
    )
    db.add(cam)
    await db.commit()
    _patch_pull(monkeypatch)

    result = await AnrFulfiller(db, scope_for(str(TENANT))).fulfill(_request(cam.id))
    assert result.status == "failed"
    assert "no footage source" in (result.error or "")


async def test_fulfill_foreign_tenant_camera_fails(db, monkeypatch):
    cam, nvr = await _add_nvr_camera(db)
    _patch_driver(monkeypatch, _StubDriver())
    _patch_pull(monkeypatch)

    # Fulfil under a DIFFERENT tenant scope → the camera is not owned → clean failure.
    svc = AnrFulfiller(db, Scope(tenant_id=OTHER_TENANT, is_superadmin=False))
    result = await svc.fulfill(_request(cam.id, tenant=str(OTHER_TENANT)))
    assert result.status == "failed"
    assert "not found" in (result.error or "")


# ── request parsing ──────────────────────────────────────────────────────────


def test_request_from_event_rejects_malformed():
    assert AnrRequest.from_event(str(TENANT), {}) is None
    assert AnrRequest.from_event(str(TENANT), {"job_id": "x", "camera_id": "c"}) is None
    # gap_to <= gap_from is rejected.
    assert AnrRequest.from_event(str(TENANT), {
        "job_id": 1, "camera_id": "c",
        "gap_from": GAP_TO.isoformat(), "gap_to": GAP_FROM.isoformat(),
    }) is None
    good = AnrRequest.from_event(str(TENANT), {
        "job_id": 1, "camera_id": "c", "profile": "sub",
        "gap_from": GAP_FROM.isoformat(), "gap_to": GAP_TO.isoformat(),
    })
    assert good is not None and good.job_id == 1 and good.profile == "sub"


# ── consumer end-to-end (request → search → result) ──────────────────────────


async def test_consumer_request_to_result(db, sessionmaker, monkeypatch):
    cam, nvr = await _add_nvr_camera(db)
    driver = _StubDriver()
    _patch_driver(monkeypatch, driver)
    _patch_pull(monkeypatch)

    bus = _FakeBus()
    consumer = AnrConsumer(bus, sessionmaker)
    await consumer.start()

    await bus.deliver(str(TENANT), {
        "job_id": 99, "camera_id": cam.id, "profile": "main",
        "gap_from": GAP_FROM.isoformat(), "gap_to": GAP_TO.isoformat(),
        "record_path": None,
    })

    # request was consumed → driver search invoked → result published with the job_id.
    assert driver.searched, "search was not invoked"
    assert len(bus.published) == 1
    subj, payload = bus.published[0]
    assert subj == f"tenant.{TENANT}.vms.anr.result"
    assert payload["job_id"] == 99
    assert payload["status"] == "done"
    assert payload["backfilled_segments"] == 1


async def test_consumer_graceful_failure_publishes_failed(db, sessionmaker, monkeypatch):
    cam, nvr = await _add_nvr_camera(db)
    driver = _StubDriver(matches=[])  # no footage → failed
    _patch_driver(monkeypatch, driver)
    _patch_pull(monkeypatch)

    bus = _FakeBus()
    consumer = AnrConsumer(bus, sessionmaker)
    await consumer.start()

    await bus.deliver(str(TENANT), {
        "job_id": 7, "camera_id": cam.id, "profile": "main",
        "gap_from": GAP_FROM.isoformat(), "gap_to": GAP_TO.isoformat(),
    })

    assert len(bus.published) == 1
    _subj, payload = bus.published[0]
    assert payload["job_id"] == 7
    assert payload["status"] == "failed"
    assert payload.get("error")


async def test_consumer_malformed_request_no_publish(db, sessionmaker, monkeypatch):
    _patch_driver(monkeypatch, _StubDriver())
    _patch_pull(monkeypatch)
    bus = _FakeBus()
    consumer = AnrConsumer(bus, sessionmaker)
    await consumer.start()

    await bus.deliver(str(TENANT), {"camera_id": "c"})  # missing job_id/gap → ignored
    assert bus.published == []
