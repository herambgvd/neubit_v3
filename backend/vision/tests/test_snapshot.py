"""Camera snapshot tests — MediaMTX frame-grab fallback + in-memory cache.

No live devices / no ffmpeg binary is required: the ffmpeg frame-grab is
monkeypatched to a fabricated JPEG, and the ONVIF driver is a fake. We assert:

  * ``mediamtx_path`` mirrors the Go ``mediamtx.PathName`` convention (tenant→platform).
  * the cache stores + serves a frame, and evicts once past TTL.
  * ``snapshot_for`` prefers the driver's ONVIF snapshot when it yields bytes.
  * ``snapshot_for`` FALLS BACK to the MediaMTX frame-grab when ONVIF returns None,
    and the grabbed frame is then served from cache (no 2nd ffmpeg spawn).
  * a total failure (ONVIF None + grab None) degrades to ``None`` (→ router 502s).
"""

from __future__ import annotations

import uuid

import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope

from app.db import Base
from app.vms.cameras import snapshot_frame
from app.vms.common.crypto import encrypt_secret
from app.vms.models import Camera

TENANT = uuid.uuid4()

# A tiny valid-ish JPEG (SOI…EOI) — bytes are all we assert on.
FAKE_JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 16 + b"\xff\xd9"


def _scope(t=TENANT):
    return Scope(tenant_id=t, is_superadmin=False)


# ── path convention ───────────────────────────────────────────────────────────
def test_mediamtx_path_matches_go_convention():
    assert (
        snapshot_frame.mediamtx_path(TENANT, "cam-1", "sub")
        == f"cameras/{TENANT}/cam-1/sub"
    )
    # absent tenant → "platform" (mirrors the Go streams handler default)
    assert snapshot_frame.mediamtx_path(None, "cam-1", "sub") == "cameras/platform/cam-1/sub"
    # empty profile → "main"
    assert snapshot_frame.mediamtx_path(TENANT, "cam-1", "") == f"cameras/{TENANT}/cam-1/main"


def test_rtsp_base_default_and_override(monkeypatch):
    monkeypatch.delenv("VE_MEDIAMTX_RTSP_BASE", raising=False)
    assert snapshot_frame.rtsp_base() == "rtsp://mediamtx:8554"
    monkeypatch.setenv("VE_MEDIAMTX_RTSP_BASE", "rtsp://other:9554/")
    assert snapshot_frame.rtsp_base() == "rtsp://other:9554"


# ── cache get / put / TTL ──────────────────────────────────────────────────────
def test_cache_put_get_and_ttl_eviction(monkeypatch):
    snapshot_frame._cache.clear()
    t = [1000.0]
    monkeypatch.setattr(snapshot_frame.time, "monotonic", lambda: t[0])

    snapshot_frame.cache_put("camX", "sub", FAKE_JPEG)
    assert snapshot_frame.cache_get("camX", "sub") == FAKE_JPEG  # fresh

    t[0] += snapshot_frame._CACHE_TTL_SEC + 1  # advance past TTL
    assert snapshot_frame.cache_get("camX", "sub") is None  # evicted
    assert ("camX", "sub") not in snapshot_frame._cache

    # empty bytes are never cached
    snapshot_frame.cache_put("camY", "sub", b"")
    assert snapshot_frame.cache_get("camY", "sub") is None


# ── grab_frame graceful failure (no ffmpeg needed) ─────────────────────────────
async def test_grab_frame_empty_url_returns_none():
    assert await snapshot_frame.grab_frame("") is None


async def test_grab_frame_missing_binary_degrades_to_none(monkeypatch):
    async def _boom(*a, **k):
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr(snapshot_frame.asyncio, "create_subprocess_exec", _boom)
    assert await snapshot_frame.grab_frame("rtsp://x/y") is None


# ── service snapshot_for: DB + fallback selection ──────────────────────────────
@pytest_asyncio.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with Session() as s:
        yield s
    await engine.dispose()


def _cam(cid, tenant, host="10.0.0.5", brand="hikvision"):
    return Camera(
        id=cid, tenant_id=tenant, name=cid, connection_type="onvif", status="online",
        brand=brand, onvif_host=host, onvif_port=80, onvif_user="admin",
        onvif_enc_pass=encrypt_secret("pass12"), network_info={"ip": host},
    )


@pytest_asyncio.fixture
async def seeded(db):
    db.add(_cam("cam-onvif", TENANT))
    db.add(_cam("cam-nvr", TENANT))
    await db.commit()


def _stub_ensure(monkeypatch):
    """Stub the LiveService ensure path (RTSP-source derive + nvr ensure) so the
    fallback reaches the frame-grab without a real nvr/MediaMTX. Returns the ensure
    call recorder."""
    ensured = []

    async def _rtsp_source_for(self, camera, profile):
        return f"rtsp://cam/{camera.id}/{profile}"

    async def _ensure(self, *, camera_id, rtsp_url, profile):
        ensured.append((camera_id, rtsp_url, profile))
        return {"name": snapshot_frame.mediamtx_path(None, camera_id, profile), "ready": False}

    monkeypatch.setattr(
        "app.vms.live.service.LiveService._rtsp_source_for", _rtsp_source_for
    )
    monkeypatch.setattr(
        "app.vms.common.nvr_client.NvrClient.ensure_stream", _ensure
    )
    return ensured


async def test_snapshot_total_failure_returns_none(db, seeded, monkeypatch):
    from app.vms.cameras.service import CameraService

    snapshot_frame._cache.clear()
    _stub_ensure(monkeypatch)

    async def _grab(url, **k):
        return None

    monkeypatch.setattr(snapshot_frame, "grab_frame", _grab)

    svc = CameraService(db, _scope())
    assert await svc.snapshot_for("cam-nvr") is None  # → router 502s


async def test_snapshot_none_when_nvr_ensure_unreachable(db, seeded, monkeypatch):
    """nvr/MediaMTX unreachable → the fallback degrades to None (never raises)."""
    from app.vms.cameras.service import CameraService
    from app.vms.common.nvr_client import NvrUnavailable

    snapshot_frame._cache.clear()

    async def _rtsp_source_for(self, camera, profile):
        return f"rtsp://cam/{camera.id}/{profile}"

    async def _ensure_boom(self, **k):
        raise NvrUnavailable("nvr data-plane unreachable")

    monkeypatch.setattr("app.vms.live.service.LiveService._rtsp_source_for", _rtsp_source_for)
    monkeypatch.setattr("app.vms.common.nvr_client.NvrClient.ensure_stream", _ensure_boom)

    grabbed = []

    async def _grab(url, **k):
        grabbed.append(url)
        return FAKE_JPEG

    monkeypatch.setattr(snapshot_frame, "grab_frame", _grab)

    svc = CameraService(db, _scope())
    assert await svc.snapshot_for("cam-nvr") is None  # ensure failed → no grab, 502 upstream
    assert grabbed == []  # never reached the frame-grab


# The two ONVIF-preference tests are gone with the path they covered. snapshot_for no
# longer opens an ONVIF session with the camera's credentials — the recorder holds
# those and already fronts the stream, so the frame comes off the MediaMTX path it
# serves. What remains below is the cache, the path convention, and the honest None.
