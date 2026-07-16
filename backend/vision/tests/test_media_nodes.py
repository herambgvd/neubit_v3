"""Media-node registry tests (MN-1a) — CRUD + tenant isolation + reachability + delete-block.

Exercises ``MediaNodeService`` + ``NodeHeartbeatMonitor`` against an in-memory SQLite DB
with the reachability probe (``probe_node``) monkeypatched — NO network is touched:
  * CRUD happy-path (register online, list, get, patch, delete).
  * tenant isolation (tenant B cannot see / fetch tenant A's node).
  * reachability marks OFFLINE when the recorder is unreachable at register time (with a
    warning), and stores the row anyway (create does not hard-fail).
  * delete is BLOCKED (ConflictError) while a camera still references the node.
  * the heartbeat monitor flips offline→online (and back), and leaves ``draining`` alone.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import ConflictError, NotFoundError, ValidationError

from app.db import Base
from app.vms.media_nodes import service as node_service
from app.vms.media_nodes.schemas import MediaNodeCreate, MediaNodeUpdate
from app.vms.media_nodes.service import MediaNodeService, NodeHeartbeatMonitor
from app.vms.models import Camera, MediaNode

TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()


def _scope(tenant) -> Scope:
    return Scope(tenant_id=tenant, is_superadmin=False)


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


@pytest.fixture
def sessionmaker(engine):
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


@pytest.fixture
def reachable(monkeypatch):
    """Patch the reachability probe → the recorder is UP (with a channel count)."""
    async def _probe(api_url, *, timeout=None):
        return True, {"service": "nvr", "streaming": True, "active_streams": 3}

    monkeypatch.setattr(node_service, "probe_node", _probe)


@pytest.fixture
def unreachable(monkeypatch):
    """Patch the reachability probe → the recorder is DOWN."""
    async def _probe(api_url, *, timeout=None):
        return False, {}

    monkeypatch.setattr(node_service, "probe_node", _probe)


# ── CRUD happy-path ──────────────────────────────────────────────────────────────
async def test_register_online_then_crud(db, reachable):
    svc = MediaNodeService(db, _scope(TENANT_A))
    created = await svc.create(
        MediaNodeCreate(
            name="recorder-2",
            api_url="http://recorder-2:8000",
            hls_base="http://recorder-2:8888",
            webrtc_base="http://recorder-2:8889",
            rtsp_base="rtsp://recorder-2:8554",
            label="Tower-B basement",
            capacity_channels=64,
        )
    )
    assert created.status == "online"
    assert created.warning is None
    assert created.api_url == "http://recorder-2:8000"
    assert created.host == "recorder-2"  # derived from api_url
    assert created.used_channels == 3  # from the status payload
    assert created.last_heartbeat is not None

    # list
    listed = await svc.list_()
    assert listed.total == 1
    assert listed.items[0].id == created.id

    # get
    got = await svc.get(created.id)
    assert got.name == "recorder-2"

    # patch — rename + set draining + change label
    updated = await svc.update(
        created.id,
        MediaNodeUpdate(name="recorder-2b", label="Tower-B B1", status="draining"),
    )
    assert updated.name == "recorder-2b"
    assert updated.label == "Tower-B B1"
    assert updated.status == "draining"

    # delete (no cameras assigned)
    await svc.delete(created.id)
    with pytest.raises(NotFoundError):
        await svc.get(created.id)


async def test_duplicate_name_conflicts(db, reachable):
    svc = MediaNodeService(db, _scope(TENANT_A))
    await svc.create(MediaNodeCreate(name="dup", api_url="http://a:8000"))
    with pytest.raises(ConflictError):
        await svc.create(MediaNodeCreate(name="dup", api_url="http://b:8000"))


async def test_invalid_status_rejected(db, reachable):
    svc = MediaNodeService(db, _scope(TENANT_A))
    node = await svc.create(MediaNodeCreate(name="n", api_url="http://a:8000"))
    with pytest.raises(ValidationError):
        await svc.update(node.id, MediaNodeUpdate(status="bogus"))


# ── tenant isolation ─────────────────────────────────────────────────────────────
async def test_tenant_isolation(db, reachable):
    a = MediaNodeService(db, _scope(TENANT_A))
    b = MediaNodeService(db, _scope(TENANT_B))
    node = await a.create(MediaNodeCreate(name="a-node", api_url="http://a:8000"))

    # B cannot list A's node
    assert (await b.list_()).total == 0
    # B cannot fetch A's node by id (NotFound, not Forbidden — id-existence hidden)
    with pytest.raises(NotFoundError):
        await b.get(node.id)
    # B cannot delete A's node
    with pytest.raises(NotFoundError):
        await b.delete(node.id)
    # A still sees it
    assert (await a.list_()).total == 1


# ── reachability marks offline on unreachable (no hard-fail) ─────────────────────
async def test_register_unreachable_marks_offline_with_warning(db, unreachable):
    svc = MediaNodeService(db, _scope(TENANT_A))
    created = await svc.create(
        MediaNodeCreate(name="down-node", api_url="http://down:8000")
    )
    assert created.status == "offline"
    assert created.warning is not None
    assert "unreachable" in created.warning
    # ...but the row WAS stored.
    assert (await svc.list_()).total == 1


# ── delete blocked while cameras assigned ────────────────────────────────────────
async def test_delete_blocked_when_cameras_assigned(db, reachable):
    svc = MediaNodeService(db, _scope(TENANT_A))
    node = await svc.create(MediaNodeCreate(name="busy", api_url="http://busy:8000"))

    cam = Camera(
        id=str(uuid.uuid4()),
        tenant_id=TENANT_A,
        name="cam-on-node",
        media_node_id=node.id,
    )
    db.add(cam)
    await db.commit()

    with pytest.raises(ConflictError):
        await svc.delete(node.id)

    # unassign the camera → delete now succeeds
    cam.media_node_id = None
    await db.commit()
    await svc.delete(node.id)
    with pytest.raises(NotFoundError):
        await svc.get(node.id)


# ── heartbeat monitor ────────────────────────────────────────────────────────────
async def test_heartbeat_flips_status_and_respects_draining(db, sessionmaker, monkeypatch):
    # Seed three nodes directly (offline start): up, down, draining.
    up = MediaNode(id=str(uuid.uuid4()), tenant_id=TENANT_A, name="up",
                   host="up", api_url="http://up:8000", status="offline")
    down = MediaNode(id=str(uuid.uuid4()), tenant_id=TENANT_A, name="down",
                     host="down", api_url="http://down:8000", status="online")
    drain = MediaNode(id=str(uuid.uuid4()), tenant_id=TENANT_B, name="drain",
                      host="drain", api_url="http://drain:8000", status="draining")
    db.add_all([up, down, drain])
    await db.commit()

    async def _probe(api_url, *, timeout=None):
        if "up" in api_url:
            return True, {"active_streams": 5}
        return False, {}

    monkeypatch.setattr(node_service, "probe_node", _probe)

    monitor = NodeHeartbeatMonitor(sessionmaker)
    pinged = await monitor.run_cycle()
    assert pinged == 3

    await db.refresh(up)
    await db.refresh(down)
    await db.refresh(drain)
    assert up.status == "online"
    assert up.used_channels == 5
    assert up.last_heartbeat is not None
    assert down.status == "offline"  # was online, now unreachable
    assert drain.status == "draining"  # left untouched


async def test_heartbeat_skips_nodes_without_api_url(db, sessionmaker, monkeypatch):
    # A legacy node with no api_url must be skipped (not crash the cycle).
    legacy = MediaNode(id=str(uuid.uuid4()), tenant_id=TENANT_A, name="legacy",
                       host="legacy", api_url=None, status="unknown")
    db.add(legacy)
    await db.commit()

    async def _probe(api_url, *, timeout=None):
        raise AssertionError("should not probe a node without api_url")

    monkeypatch.setattr(node_service, "probe_node", _probe)
    monitor = NodeHeartbeatMonitor(sessionmaker)
    assert await monitor.run_cycle() == 0
    await db.refresh(legacy)
    assert legacy.status == "unknown"
