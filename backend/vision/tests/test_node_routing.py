"""MN-1b per-camera Go-``nvr`` routing tests (no network).

Covers ``node_base_for_camera`` (the resolver) and the service wiring that turns a
camera's assigned ``MediaNode`` into the ``NvrClient(base_url=...)`` for THAT camera:

  * resolver: assigned → node api_url; unassigned → None; dangling node → None (no
    raise); blank api_url → None; cross-tenant node → None (tenant isolation).
  * live/recording/playback: an assigned camera constructs the NvrClient with the
    node's base_url; an unassigned camera reuses the shared/global client (back-compat).

In-memory SQLite + monkeypatched ``NvrClient`` — mirrors ``test_nvr_footage_service``.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope

from app.db import Base
from app.vms.common.node_routing import node_base_for_camera
from app.vms.models import Camera, MediaNode, MediaProfile

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()

NODE_URL = "http://recorder-2:8000"


class _Actor:
    user_id = uuid.uuid4()


@pytest_asyncio.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with Session() as s:
        yield s
    await engine.dispose()


async def _mk_node(db, *, tenant=TENANT, api_url=NODE_URL, name="node-2"):
    node = MediaNode(
        id=str(uuid.uuid4()),
        tenant_id=tenant,
        name=name,
        host="recorder-2",
        api_url=api_url,
        status="online",
    )
    db.add(node)
    await db.commit()
    return node


async def _mk_camera(db, *, tenant=TENANT, media_node_id=None, name="Cam"):
    cam = Camera(
        id=str(uuid.uuid4()),
        tenant_id=tenant,
        name=name,
        connection_type="rtsp",
        onvif_user="admin",
        media_node_id=media_node_id,
    )
    db.add(cam)
    db.add(MediaProfile(camera_id=cam.id, tenant_id=tenant, name="main", rtsp_path="rtsp://cam/main"))
    db.add(MediaProfile(camera_id=cam.id, tenant_id=tenant, name="sub", rtsp_path="rtsp://cam/sub"))
    await db.commit()
    return cam


# ── resolver ────────────────────────────────────────────────────────────────
async def test_resolver_returns_node_url_for_assigned_camera(db):
    node = await _mk_node(db)
    cam = await _mk_camera(db, media_node_id=node.id)
    # Accepts either a loaded Camera or a bare id.
    assert await node_base_for_camera(db, TENANT, cam) == NODE_URL
    assert await node_base_for_camera(db, TENANT, cam.id) == NODE_URL


async def test_resolver_none_when_unassigned(db):
    cam = await _mk_camera(db, media_node_id=None)
    assert await node_base_for_camera(db, TENANT, cam) is None


async def test_resolver_none_when_node_missing_no_raise(db):
    # media_node_id points at a node that does not exist → fall back, never raise.
    cam = await _mk_camera(db, media_node_id=str(uuid.uuid4()))
    assert await node_base_for_camera(db, TENANT, cam) is None


async def test_resolver_none_when_api_url_blank(db):
    node = await _mk_node(db, api_url="   ")
    cam = await _mk_camera(db, media_node_id=node.id)
    assert await node_base_for_camera(db, TENANT, cam) is None


async def test_resolver_none_when_api_url_null(db):
    node = await _mk_node(db, api_url=None)
    cam = await _mk_camera(db, media_node_id=node.id)
    assert await node_base_for_camera(db, TENANT, cam) is None


async def test_resolver_tenant_isolation(db):
    # Node belongs to OTHER_TENANT; a TENANT caller must NOT route to it.
    node = await _mk_node(db, tenant=OTHER_TENANT, name="other-node")
    cam = await _mk_camera(db, tenant=TENANT, media_node_id=node.id)
    assert await node_base_for_camera(db, TENANT, cam) is None


async def test_resolver_shared_null_tenant_node_is_usable(db):
    # A platform/NULL-tenant node is shared → usable by a tenant caller.
    node = await _mk_node(db, tenant=None, name="shared-node")
    cam = await _mk_camera(db, tenant=TENANT, media_node_id=node.id)
    assert await node_base_for_camera(db, TENANT, cam) == NODE_URL


async def test_resolver_missing_camera_id_is_none(db):
    assert await node_base_for_camera(db, TENANT, str(uuid.uuid4())) is None


# ── service wiring: the NvrClient is built with the node's base_url ───────────
def _scope(tenant=TENANT):
    return Scope(tenant_id=tenant, is_superadmin=False)


class _CapturingNvr:
    """Captures the base_url it was constructed with + answers the media calls."""

    instances: list["_CapturingNvr"] = []

    def __init__(self, *, bearer=None, base_url=None):
        self.bearer = bearer
        self.base_url = base_url
        _CapturingNvr.instances.append(self)

    async def ensure_stream(self, *, camera_id, rtsp_url, profile):
        return {
            "name": f"{camera_id}/{profile}", "node": "n0",
            "hls_url": f"http://{self.base_url}/hls", "webrtc_url": None,
            "rtsp_url": rtsp_url, "ready": True,
        }

    async def start_recording(self, *, camera_id, profile, rtsp_url, trigger="continuous", audio=False, record_dir=None):
        return {"camera_id": camera_id, "profile": profile, "recording": True, "trigger_type": trigger}

    async def stop_recording(self, *, camera_id, profile):
        return True

    async def playback_list(self, *, camera_id, profile, from_, to):
        return {"playback_url": f"http://{self.base_url}/pb", "node": "n0", "name": camera_id, "ranges": []}


@pytest.fixture(autouse=True)
def _reset_instances():
    _CapturingNvr.instances = []
    yield
    _CapturingNvr.instances = []


async def test_live_start_uses_node_base_for_assigned_camera(db, monkeypatch):
    import app.vms.live.service as live_mod

    node = await _mk_node(db)
    cam = await _mk_camera(db, media_node_id=node.id)
    monkeypatch.setattr(live_mod, "NvrClient", _CapturingNvr)

    svc = live_mod.LiveService(db, _scope(), bearer="jwt")
    await svc.start_live(cam.id, "sub", actor=_Actor())

    # A per-camera client was constructed with the node's api_url.
    bases = [i.base_url for i in _CapturingNvr.instances]
    assert NODE_URL in bases


async def test_live_start_unassigned_uses_global_client(db, monkeypatch):
    import app.vms.live.service as live_mod

    cam = await _mk_camera(db, media_node_id=None)
    monkeypatch.setattr(live_mod, "NvrClient", _CapturingNvr)

    svc = live_mod.LiveService(db, _scope(), bearer="jwt")
    await svc.start_live(cam.id, "sub", actor=_Actor())

    # Only the constructor default (base_url=None) client was used — no per-node client.
    assert all(i.base_url is None for i in _CapturingNvr.instances)


async def test_recording_start_uses_node_base_for_assigned_camera(db, monkeypatch):
    import app.vms.recording.service as rec_mod

    node = await _mk_node(db)
    cam = await _mk_camera(db, media_node_id=node.id, name="RecCam")
    monkeypatch.setattr(rec_mod, "NvrClient", _CapturingNvr)

    svc = rec_mod.RecordingService(db, _scope(), bearer="jwt")
    await svc.start(cam.id, actor=_Actor(), trigger="manual")

    assert NODE_URL in [i.base_url for i in _CapturingNvr.instances]


async def test_playback_uses_node_base_for_assigned_camera(db, monkeypatch):
    from datetime import datetime, timezone

    import app.vms.playback.service as pb_mod
    from app.vms.models import Recording

    node = await _mk_node(db)
    cam = await _mk_camera(db, media_node_id=node.id, name="PbCam")
    # A recording in-window so playback proceeds to the nvr call.
    db.add(Recording(
        id=str(uuid.uuid4()), tenant_id=TENANT, camera_id=cam.id, profile="main",
        path="/rec/x.mp4",
        start_time=datetime(2026, 7, 9, 10, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 7, 9, 10, 30, tzinfo=timezone.utc),
    ))
    await db.commit()
    monkeypatch.setattr(pb_mod, "NvrClient", _CapturingNvr)

    svc = pb_mod.PlaybackService(db, _scope(), bearer="jwt")
    await svc.start_playback(
        cam.id,
        datetime(2026, 7, 9, 10, 0, tzinfo=timezone.utc),
        datetime(2026, 7, 9, 10, 30, tzinfo=timezone.utc),
        "main", actor=_Actor(),
    )

    assert NODE_URL in [i.base_url for i in _CapturingNvr.instances]
