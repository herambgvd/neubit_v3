"""Camera snapshot tests — the recorder takes it, the VMS caches it.

No live devices: the recorder's snapshot call is monkeypatched. We assert:

  * ``mediamtx_path`` mirrors the Go ``mediamtx.PathName`` convention (tenant→platform).
  * the cache stores + serves a frame, and evicts once past TTL.
  * ``snapshot_for`` asks the RECORDER that owns the camera, with that recorder's own
    scoped credential, and serves the second ask from cache.
  * a camera with no recorder attempts NOTHING — the case that used to fall back to
    opening a session with the camera's own decrypted password.
  * an unreachable recorder degrades to ``None`` (→ the router 502s) and does not
    cache the failure.
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


async def _mk_node(db, camera_id, *, api_url="http://rec-a:8000", credential="scoped-key"):
    """Register a recorder and put `camera_id` behind it."""
    from app.vms.models import MediaNode

    node = MediaNode(
        id=str(uuid.uuid4()), tenant_id=TENANT, name="recorder-a", host="rec-a",
        api_url=api_url, credential=credential, status="online",
    )
    db.add(node)
    cam = await db.get(Camera, camera_id)
    cam.media_node_id = node.id
    await db.commit()
    return node


async def test_snapshot_is_taken_by_the_owning_recorder(db, seeded, monkeypatch):
    """The VMS asks the recorder; it does not grab the frame itself.

    It used to do that two ways — the camera's own ONVIF GetSnapshotUri, and a frame
    off the MediaMTX path, which still meant deriving the camera's RTSP URL from its
    decrypted password. The recorder holds the credentials and fronts the stream.
    """
    from app.vms.cameras.service import CameraService

    snapshot_frame._cache.clear()
    await _mk_node(db, "cam-nvr")
    asks = []

    async def _snap(api_url, camera_id, *, refresh=False, credential=None):
        asks.append((api_url, camera_id, credential))
        return FAKE_JPEG, "image/jpeg"

    monkeypatch.setattr("app.vms.cameras.service.fed.snapshot_node", _snap)

    svc = CameraService(db, _scope())
    out = await svc.snapshot_for("cam-nvr")
    assert out == FAKE_JPEG
    assert asks == [("http://rec-a:8000", "cam-nvr", "scoped-key")]
    # Cached: the camera grid asks for sixteen of these at once, and each one makes
    # the recorder talk to a device.
    assert snapshot_frame.cache_get("cam-nvr", "sub") == FAKE_JPEG
    await svc.snapshot_for("cam-nvr")
    assert len(asks) == 1


async def test_snapshot_none_when_no_recorder_fronts_the_camera(db, seeded, monkeypatch):
    """No node → None, and NOTHING attempted.

    The absence of a call is the assertion: this is the case that used to fall back to
    opening a session with the camera's own credentials.
    """
    from app.vms.cameras.service import CameraService

    snapshot_frame._cache.clear()
    called = []

    async def _snap(*a, **k):
        called.append(a)
        return FAKE_JPEG, "image/jpeg"

    monkeypatch.setattr("app.vms.cameras.service.fed.snapshot_node", _snap)
    # The frame-grab must not be reached either — it would mean the VMS pulled RTSP.
    async def _grab(url, **k):
        called.append(("grab", url))
        return FAKE_JPEG

    monkeypatch.setattr(snapshot_frame, "grab_frame", _grab)

    svc = CameraService(db, _scope())
    assert await svc.snapshot_for("cam-nvr") is None
    assert called == []


async def test_snapshot_none_when_the_recorder_is_unreachable(db, seeded, monkeypatch):
    """A recorder that is down degrades to None (the router 502s), never raises."""
    from app.vms.cameras.service import CameraService
    from app.vms.federation import client as fed_client

    snapshot_frame._cache.clear()
    await _mk_node(db, "cam-nvr")

    async def _down(*a, **k):
        raise fed_client.NodeUnavailable("connection refused")

    monkeypatch.setattr("app.vms.cameras.service.fed.snapshot_node", _down)

    svc = CameraService(db, _scope())
    assert await svc.snapshot_for("cam-nvr") is None
    # And a failure is NOT cached — the next ask retries rather than serving a hole.
    assert snapshot_frame.cache_get("cam-nvr", "sub") is None


# ── the camera the VMS has no row for ─────────────────────────────────────────
#
# Which, under single ownership, is every camera: the recorders own them. A snapshot
# asked for by camera id alone — an incident card, a thumbnail — used to 404 here for
# exactly the same reason the live session did, and for exactly as long as nobody
# tried it against a real pair.


async def test_a_camera_with_no_row_is_resolved_to_its_recorder(db, monkeypatch):
    from app.vms.cameras.service import CameraService
    from app.vms.models import MediaNode

    snapshot_frame._cache.clear()
    node = MediaNode(
        id=str(uuid.uuid4()), tenant_id=TENANT, name="rec-a", host="rec-a",
        api_url="http://rec-a:8000", credential="scoped-key", status="online",
    )
    db.add(node)
    await db.commit()

    async def _cameras(api_url, credential=None):
        return [{"id": "cam-only-on-the-recorder"}]

    monkeypatch.setattr("app.vms.federation.client.list_estate_cameras", _cameras)

    asks = []

    async def _snap(api_url, camera_id, *, refresh=False, credential=None):
        asks.append((api_url, camera_id, credential))
        return FAKE_JPEG, "image/jpeg"

    monkeypatch.setattr("app.vms.cameras.service.fed.snapshot_node", _snap)

    out = await CameraService(db, _scope()).snapshot_for("cam-only-on-the-recorder")
    assert out == FAKE_JPEG
    assert asks == [("http://rec-a:8000", "cam-only-on-the-recorder", "scoped-key")]
