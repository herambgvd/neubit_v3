"""G6 audio backend tests (no network).

Two features:
  1. Audio RECORDING — the ``audio_enabled`` flag persists on camera create/update
     and on the recording-config get/put, AND the flag reaches the Go nvr on the
     start-recording call (asserted on the stub payload).
  2. Two-way audio (TALK) — the talk-session issuer mints a talk token + backchannel
     target for a backchannel-capable camera, rejects a non-capable one (409), and is
     tenant-isolated.

Every network boundary is a fabricated stub (the Go nvr client + the camera driver);
``pytest-asyncio`` auto mode runs the ``async def test_*`` coroutines.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import NotFoundError

from app.db import Base
from app.vms.audio.service import AudioTalkService, TalkNotSupported
from app.vms.common.media_token import verify_media_token, verify_talk_token
from app.vms.drivers import TalkTarget
from app.vms.models import Camera, MediaProfile
from app.vms.recording.service import RecordingService

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()


class _Actor:
    user_id = uuid.uuid4()


class _RecBody:
    """RecordingConfigBody-shaped object for RecordingService.set_config."""

    def __init__(self, mode="continuous", audio_enabled=False, record_substream=False):
        self.mode = mode
        self.schedule = {}
        self.retention_days = 30
        self.record_substream = record_substream
        self.audio_enabled = audio_enabled


class _StubNvr:
    def __init__(self):
        self.started: list[dict] = []
        self.stopped: list[tuple[str, str]] = []

    async def start_recording(self, *, camera_id, profile, rtsp_url, trigger="continuous", audio=False):
        self.started.append(
            {"camera_id": camera_id, "profile": profile, "trigger": trigger, "audio": audio}
        )
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


async def _make_camera(db, *, backchannel: bool, audio_enabled: bool = False) -> Camera:
    cam = Camera(
        id=str(uuid.uuid4()),
        tenant_id=TENANT,
        name=f"Cam {uuid.uuid4().hex[:6]}",
        connection_type="rtsp",
        onvif_host="cam.local",
        onvif_user="admin",
        recording_mode="continuous",
        audio_enabled=audio_enabled,
        onvif_capabilities={"backchannel": backchannel},
    )
    db.add(cam)
    db.add(MediaProfile(camera_id=cam.id, tenant_id=TENANT, name="main", rtsp_path="rtsp://cam.local:554/main"))
    await db.commit()
    return cam


def _scope(tenant=TENANT):
    return Scope(tenant_id=tenant, is_superadmin=False)


def _rec_svc(db, stub, tenant=TENANT):
    svc = RecordingService(db, _scope(tenant), bearer="fake.jwt")
    svc.nvr = stub
    return svc


def _talk_svc(db, tenant=TENANT):
    return AudioTalkService(db, _scope(tenant), bearer="fake.jwt")


# ── audio_enabled on the camera model (create/update parity) ─────────────────


async def test_audio_enabled_defaults_false(db):
    cam = await _make_camera(db, backchannel=False)
    await db.refresh(cam)
    assert cam.audio_enabled is False


async def test_camera_public_surfaces_audio_and_talk(db):
    from app.vms.cameras.schemas import CameraPublic

    cam = await _make_camera(db, backchannel=True, audio_enabled=True)
    pub = CameraPublic.from_row(cam, profiles=[])
    assert pub.recording.audio_enabled is True
    assert pub.talk_capable is True

    cam2 = await _make_camera(db, backchannel=False, audio_enabled=False)
    pub2 = CameraPublic.from_row(cam2, profiles=[])
    assert pub2.recording.audio_enabled is False
    assert pub2.talk_capable is False


# ── recording-config get/put carries audio + reaches the nvr ─────────────────


async def test_set_config_persists_and_sends_audio_flag(db):
    cam = await _make_camera(db, backchannel=False)
    stub = _StubNvr()
    out = await _rec_svc(db, stub).set_config(
        cam.id, _RecBody(mode="continuous", audio_enabled=True), actor=_Actor()
    )
    # Public config echoes audio_enabled.
    assert out.audio_enabled is True
    # Persisted on the camera.
    await db.refresh(cam)
    assert cam.audio_enabled is True
    # The nvr start-recording call carried audio=True (the contract flag).
    assert stub.started and stub.started[0]["audio"] is True


async def test_set_config_audio_off_sends_false(db):
    cam = await _make_camera(db, backchannel=False, audio_enabled=True)
    stub = _StubNvr()
    await _rec_svc(db, stub).set_config(
        cam.id, _RecBody(mode="continuous", audio_enabled=False), actor=_Actor()
    )
    assert stub.started[0]["audio"] is False
    await db.refresh(cam)
    assert cam.audio_enabled is False


async def test_get_config_returns_audio(db):
    cam = await _make_camera(db, backchannel=False, audio_enabled=True)
    out = await _rec_svc(db, _StubNvr()).get_config(cam.id)
    assert out.audio_enabled is True


async def test_manual_start_uses_stored_audio_flag(db):
    cam = await _make_camera(db, backchannel=False, audio_enabled=True)
    stub = _StubNvr()
    await _rec_svc(db, stub).start(cam.id, actor=_Actor())
    assert stub.started[0]["audio"] is True


# ── two-way audio (talk) session issuer ──────────────────────────────────────


async def test_talk_session_for_backchannel_camera(db, monkeypatch):
    cam = await _make_camera(db, backchannel=True)

    # Stub the driver's talk_target so no device is touched.
    async def _fake_talk_target(self, host, creds, *, profile=None):
        return TalkTarget(supported=True, kind="rtsp_backchannel",
                          url="rtsp://cam.local:554/main", codec="PCMU",
                          extra={"require": "www.onvif.org/ver20/backchannel"})

    from app.vms.drivers.base import CameraDriver
    monkeypatch.setattr(CameraDriver, "talk_target", _fake_talk_target)

    out = await _talk_svc(db).start_talk(cam.id, "main", actor=_Actor())
    assert out.camera_id == cam.id
    assert out.session_id
    assert out.token
    assert out.live_validate is True
    # The talk token verifies as a TALK token, and is NOT accepted as a media token.
    claims = verify_talk_token(out.token)
    assert claims["camera_id"] == cam.id and claims["dir"] == "uplink"
    with pytest.raises(Exception):
        verify_media_token(out.token)


async def test_talk_session_capable_even_if_device_unreachable(db, monkeypatch):
    """Capability is stored in onvif_capabilities → session issues even when the live
    driver resolve raises (device momentarily unreachable)."""
    cam = await _make_camera(db, backchannel=True)

    async def _boom(self, host, creds, *, profile=None):
        raise RuntimeError("device offline")

    from app.vms.drivers.base import CameraDriver
    monkeypatch.setattr(CameraDriver, "talk_target", _boom)

    out = await _talk_svc(db).start_talk(cam.id, "main", actor=_Actor())
    assert out.token  # still issued off the stored capability flag


async def test_talk_session_rejects_non_backchannel(db, monkeypatch):
    cam = await _make_camera(db, backchannel=False)

    async def _fake_talk_target(self, host, creds, *, profile=None):
        return TalkTarget(supported=False)

    from app.vms.drivers.base import CameraDriver
    monkeypatch.setattr(CameraDriver, "talk_target", _fake_talk_target)

    with pytest.raises(TalkNotSupported) as ei:
        await _talk_svc(db).start_talk(cam.id, "main", actor=_Actor())
    assert ei.value.status_code == 409


async def test_talk_session_whip_url_when_configured(db, monkeypatch):
    cam = await _make_camera(db, backchannel=True)

    async def _fake_talk_target(self, host, creds, *, profile=None):
        return TalkTarget(supported=True, url="rtsp://cam.local:554/main")

    from app.vms.drivers.base import CameraDriver
    monkeypatch.setattr(CameraDriver, "talk_target", _fake_talk_target)
    monkeypatch.setenv("VE_TALK_WHIP_BASE", "/api/v1/vms/media/whip")

    out = await _talk_svc(db).start_talk(cam.id, "main", actor=_Actor())
    assert out.kind == "whip"
    assert out.whip_url and cam.id in out.whip_url and "token=" in out.whip_url


async def test_talk_session_tenant_isolation(db, monkeypatch):
    cam = await _make_camera(db, backchannel=True)

    async def _fake_talk_target(self, host, creds, *, profile=None):
        return TalkTarget(supported=True)

    from app.vms.drivers.base import CameraDriver
    monkeypatch.setattr(CameraDriver, "talk_target", _fake_talk_target)

    with pytest.raises(NotFoundError):
        await _talk_svc(db, tenant=OTHER_TENANT).start_talk(cam.id, "main", actor=_Actor())
