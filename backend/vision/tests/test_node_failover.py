"""Cross-machine recorder failover tests (DEF-A).

When a whole recorder machine (a ``MediaNode``) dies, the heartbeat monitor reassigns ITS
cameras to a healthy recorder and resumes recording there so recording doesn't stop. This
is distinct from the Go-side P6-A intra-nvr rebalance — it's cross-INDEPENDENT-nvr, driven
by vision's ``NodeHeartbeatMonitor._failover_cycle``.

Exercised against an in-memory SQLite DB with the recording resume + the failover event
emit monkeypatched — NO network is touched:

  * a dead node (offline + stale ``last_heartbeat``) with N cameras → cameras reassigned to
    the healthy least-loaded, tenant-usable node; recording resume attempted for immediate
    modes.
  * idempotency: a second failover pass is a no-op (cameras already moved off the dead node).
  * no healthy target → cameras stay put + a ``stranded`` alert event is emitted.
  * a ``draining`` node is NOT failed over; a recent-heartbeat offline blip is NOT failed
    over.
  * tenant isolation: a camera is never moved to another tenant's private node.
  * best-effort: a raised resume does NOT stop the loop / does NOT prevent the reassignment
    persisting.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import Base
from app.vms.media_nodes import service as node_service
from app.vms.media_nodes.service import NodeHeartbeatMonitor, failover_dead_sec
from app.vms.models import Camera, MediaNode

TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


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


@pytest.fixture(autouse=True)
def stub_side_effects(monkeypatch):
    """By default, silence the recording resume + capture failover events (no Go-nvr, no
    NATS in unit tests). Returns the captured-events list so tests can assert on it."""
    resumed: list[str] = []
    events: list[tuple] = []

    async def _resume(self, db, cam):
        resumed.append(cam.id)

    async def _emit(tenant_id, event, payload, **kwargs):
        events.append((tenant_id, event, payload))
        return "subj"

    monkeypatch.setattr(NodeHeartbeatMonitor, "_resume_recording", _resume)
    # Patch the emit AT the service module (where _failover_node imports it into scope).
    monkeypatch.setattr(node_service, "emit_node_failover", _emit)
    return resumed, events


async def _mk_node(
    db, *, tenant, name, status="online", api_url=None, last_heartbeat=None, used=0
) -> MediaNode:
    node = MediaNode(
        id=str(uuid.uuid4()), tenant_id=tenant, name=name, host=name,
        api_url=api_url if api_url is not None else f"http://{name}:8000",
        status=status, used_channels=used, last_heartbeat=last_heartbeat,
    )
    db.add(node)
    await db.commit()
    await db.refresh(node)
    return node


async def _mk_camera(db, *, tenant, name, node_id, mode="continuous", enabled=True) -> Camera:
    cam = Camera(
        id=str(uuid.uuid4()), tenant_id=tenant, name=name,
        media_node_id=node_id, recording_mode=mode, is_enabled=enabled,
    )
    db.add(cam)
    await db.commit()
    await db.refresh(cam)
    return cam


def _stale() -> datetime:
    return _utcnow() - timedelta(seconds=failover_dead_sec() + 30)


# ── dead node → cameras reassigned + resume attempted ──────────────────────────
async def test_dead_node_reassigns_cameras_to_healthy(db, stub_side_effects):
    resumed, events = stub_side_effects
    dead = await _mk_node(db, tenant=TENANT_A, name="dead", status="offline",
                          last_heartbeat=_stale())
    healthy = await _mk_node(db, tenant=TENANT_A, name="healthy", status="online", used=0)
    c1 = await _mk_camera(db, tenant=TENANT_A, name="c1", node_id=dead.id)
    c2 = await _mk_camera(db, tenant=TENANT_A, name="c2", node_id=dead.id)

    monitor = NodeHeartbeatMonitor.__new__(NodeHeartbeatMonitor)
    moved = await monitor._failover_cycle(db, now=_utcnow())

    assert moved == 2
    await db.refresh(c1)
    await db.refresh(c2)
    assert c1.media_node_id == healthy.id
    assert c2.media_node_id == healthy.id
    # recording resume attempted for both (immediate/continuous mode).
    assert set(resumed) == {c1.id, c2.id}
    # a "reassigned" event per camera.
    reassigned = [e for e in events if e[1] == "reassigned"]
    assert len(reassigned) == 2
    assert all(e[2]["to_node_id"] == healthy.id for e in reassigned)
    assert all(e[2]["from_node_id"] == dead.id for e in reassigned)


async def test_least_loaded_target_chosen(db, stub_side_effects):
    dead = await _mk_node(db, tenant=TENANT_A, name="dead", status="offline",
                          last_heartbeat=_stale())
    busy = await _mk_node(db, tenant=TENANT_A, name="busy", status="online", used=10)
    idle = await _mk_node(db, tenant=TENANT_A, name="idle", status="online", used=1)
    c1 = await _mk_camera(db, tenant=TENANT_A, name="c1", node_id=dead.id)

    monitor = NodeHeartbeatMonitor.__new__(NodeHeartbeatMonitor)
    await monitor._failover_cycle(db, now=_utcnow())
    await db.refresh(c1)
    assert c1.media_node_id == idle.id  # least-loaded wins


# ── idempotency: a second pass is a no-op ──────────────────────────────────────
async def test_failover_idempotent(db, stub_side_effects):
    dead = await _mk_node(db, tenant=TENANT_A, name="dead", status="offline",
                          last_heartbeat=_stale())
    healthy = await _mk_node(db, tenant=TENANT_A, name="healthy", status="online")
    c1 = await _mk_camera(db, tenant=TENANT_A, name="c1", node_id=dead.id)

    monitor = NodeHeartbeatMonitor.__new__(NodeHeartbeatMonitor)
    assert await monitor._failover_cycle(db, now=_utcnow()) == 1
    # second run: camera already off the dead node → nothing to move.
    assert await monitor._failover_cycle(db, now=_utcnow()) == 0
    await db.refresh(c1)
    assert c1.media_node_id == healthy.id


# ── no healthy target → stranded + alert ───────────────────────────────────────
async def test_no_healthy_target_strands_and_alerts(db, stub_side_effects):
    resumed, events = stub_side_effects
    dead = await _mk_node(db, tenant=TENANT_A, name="dead", status="offline",
                          last_heartbeat=_stale())
    # The only other node is also offline → not a valid target.
    await _mk_node(db, tenant=TENANT_A, name="other", status="offline",
                   last_heartbeat=_stale())
    c1 = await _mk_camera(db, tenant=TENANT_A, name="c1", node_id=dead.id)

    monitor = NodeHeartbeatMonitor.__new__(NodeHeartbeatMonitor)
    moved = await monitor._failover_cycle(db, now=_utcnow())
    assert moved == 0
    await db.refresh(c1)
    assert c1.media_node_id == dead.id  # stays put
    stranded = [e for e in events if e[1] == "stranded"]
    assert len(stranded) == 1
    assert stranded[0][0] == TENANT_A
    assert stranded[0][2]["stranded_cameras"] == 1
    assert resumed == []  # never tried to resume a stranded camera


# ── draining is NOT failed over ────────────────────────────────────────────────
async def test_draining_node_not_failed_over(db, stub_side_effects):
    drain = await _mk_node(db, tenant=TENANT_A, name="drain", status="draining",
                           last_heartbeat=_stale())
    await _mk_node(db, tenant=TENANT_A, name="healthy", status="online")
    c1 = await _mk_camera(db, tenant=TENANT_A, name="c1", node_id=drain.id)

    monitor = NodeHeartbeatMonitor.__new__(NodeHeartbeatMonitor)
    assert await monitor._failover_cycle(db, now=_utcnow()) == 0
    await db.refresh(c1)
    assert c1.media_node_id == drain.id  # intentional drain, not a death


# ── recent-heartbeat offline blip is NOT failed over ───────────────────────────
async def test_recent_offline_blip_not_failed_over(db, stub_side_effects):
    # offline but heartbeated 5s ago (< dead threshold) → still within the blip window.
    fresh = _utcnow() - timedelta(seconds=5)
    node = await _mk_node(db, tenant=TENANT_A, name="blip", status="offline",
                          last_heartbeat=fresh)
    await _mk_node(db, tenant=TENANT_A, name="healthy", status="online")
    c1 = await _mk_camera(db, tenant=TENANT_A, name="c1", node_id=node.id)

    monitor = NodeHeartbeatMonitor.__new__(NodeHeartbeatMonitor)
    assert await monitor._failover_cycle(db, now=_utcnow()) == 0
    await db.refresh(c1)
    assert c1.media_node_id == node.id


async def test_null_heartbeat_offline_is_eligible(db, stub_side_effects):
    # offline with NO last_heartbeat → treated as infinitely old → eligible.
    dead = await _mk_node(db, tenant=TENANT_A, name="dead", status="offline",
                          last_heartbeat=None)
    healthy = await _mk_node(db, tenant=TENANT_A, name="healthy", status="online")
    c1 = await _mk_camera(db, tenant=TENANT_A, name="c1", node_id=dead.id)

    monitor = NodeHeartbeatMonitor.__new__(NodeHeartbeatMonitor)
    assert await monitor._failover_cycle(db, now=_utcnow()) == 1
    await db.refresh(c1)
    assert c1.media_node_id == healthy.id


# ── tenant isolation: never move to another tenant's private node ──────────────
async def test_tenant_isolation_never_cross_tenant_target(db, stub_side_effects):
    resumed, events = stub_side_effects
    dead = await _mk_node(db, tenant=TENANT_A, name="dead", status="offline",
                          last_heartbeat=_stale())
    # The only healthy node belongs to tenant B (private) → NOT usable for tenant A's cam.
    await _mk_node(db, tenant=TENANT_B, name="b-node", status="online")
    c1 = await _mk_camera(db, tenant=TENANT_A, name="c1", node_id=dead.id)

    monitor = NodeHeartbeatMonitor.__new__(NodeHeartbeatMonitor)
    assert await monitor._failover_cycle(db, now=_utcnow()) == 0
    await db.refresh(c1)
    assert c1.media_node_id == dead.id  # never moved onto tenant B's node
    assert any(e[1] == "stranded" for e in events)


async def test_shared_null_tenant_node_is_usable_target(db, stub_side_effects):
    dead = await _mk_node(db, tenant=TENANT_A, name="dead", status="offline",
                          last_heartbeat=_stale())
    shared = await _mk_node(db, tenant=None, name="shared", status="online")
    c1 = await _mk_camera(db, tenant=TENANT_A, name="c1", node_id=dead.id)

    monitor = NodeHeartbeatMonitor.__new__(NodeHeartbeatMonitor)
    assert await monitor._failover_cycle(db, now=_utcnow()) == 1
    await db.refresh(c1)
    assert c1.media_node_id == shared.id  # shared/platform node is usable by any tenant


# ── best-effort: a raised resume does not stop the loop / lose the reassignment ─
async def test_resume_failure_does_not_stop_failover(db, monkeypatch):
    dead = await _mk_node(db, tenant=TENANT_A, name="dead", status="offline",
                          last_heartbeat=_stale())
    healthy = await _mk_node(db, tenant=TENANT_A, name="healthy", status="online")
    c1 = await _mk_camera(db, tenant=TENANT_A, name="c1", node_id=dead.id)
    c2 = await _mk_camera(db, tenant=TENANT_A, name="c2", node_id=dead.id)

    # A resume that blows up must NOT stop the loop nor undo the (already-committed)
    # reassignment. Use the REAL _resume_recording but make _drive_start raise.
    async def _emit(*a, **k):
        return "subj"

    monkeypatch.setattr(node_service, "emit_node_failover", _emit)
    from app.vms.recording.service import RecordingService

    async def _boom(self, camera, *, trigger):
        raise RuntimeError("nvr exploded")

    monkeypatch.setattr(RecordingService, "_drive_start", _boom)
    # Silence the core audit network call.
    from app.vms.common import core_audit

    async def _noaudit(**kwargs):
        return None

    monkeypatch.setattr(core_audit, "report_video_audit", _noaudit)

    monitor = NodeHeartbeatMonitor.__new__(NodeHeartbeatMonitor)
    moved = await monitor._failover_cycle(db, now=_utcnow())
    assert moved == 2  # both cameras still moved despite the exploding resume
    await db.refresh(c1)
    await db.refresh(c2)
    assert c1.media_node_id == healthy.id
    assert c2.media_node_id == healthy.id


# ── disabled / non-immediate cameras are reassigned but not resumed ────────────
async def test_disabled_camera_reassigned_but_resume_skipped(db, monkeypatch):
    """A disabled (or schedule/motion-mode) camera is still moved off the dead node, but the
    REAL ``_resume_recording`` skips driving the nvr (it only resumes enabled immediate-mode
    cameras). We use the real resume + assert _drive_start was never called."""
    async def _emit(*a, **k):
        return "subj"

    monkeypatch.setattr(node_service, "emit_node_failover", _emit)
    from app.vms.recording.service import RecordingService

    called: list[str] = []

    async def _spy_start(self, camera, *, trigger):
        called.append(camera.id)
        return {}

    monkeypatch.setattr(RecordingService, "_drive_start", _spy_start)

    dead = await _mk_node(db, tenant=TENANT_A, name="dead", status="offline",
                          last_heartbeat=_stale())
    healthy = await _mk_node(db, tenant=TENANT_A, name="healthy", status="online")
    # disabled continuous camera → moved, but the resume is skipped by _resume_recording.
    c1 = await _mk_camera(db, tenant=TENANT_A, name="c1", node_id=dead.id, enabled=False)

    monitor = NodeHeartbeatMonitor.__new__(NodeHeartbeatMonitor)
    assert await monitor._failover_cycle(db, now=_utcnow()) == 1
    await db.refresh(c1)
    assert c1.media_node_id == healthy.id
    assert called == []  # disabled camera → nvr never driven
