"""G2 operations-dashboard aggregation tests — summary shape, rollup math, isolation.

No live devices / network. In-memory SQLite seeded with cameras (various statuses),
health, recordings, storage pools, media nodes, events, and NVRs. The nvr ``/status``
call is monkeypatched (or left to fail) so node-degradation is exercised deterministically.

Asserts:
  * summary shape — every top-level section present + ``generated_at``.
  * camera rollup — online/offline/degraded/other counts + total.
  * recording rollup — recording (recent segment) / idle / failed + segments + 24h bytes.
  * storage rollup — per-pool used_bytes / used_pct + days_to_full forecast + estate total.
  * alarms — 24h total / by_severity / by_type / recent list.
  * nvrs — healthy vs unhealthy rollup.
  * nodes — media-node list + healthy count; data_plane "ok" when nvr answers,
    "unknown" (no crash) when the nvr is unreachable.
  * tenant isolation — another tenant's data is excluded.
  * empty tenant — all zeros, no error.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope

from app.db import Base
from app.vms.common.nvr_client import NvrClient, NvrUnavailable
from app.vms.dashboard.service import DashboardService, _days_to_full
from app.vms.models import (
    NVR,
    Camera,
    MediaNode,
    Recording,
    StoragePool,
    VmsEvent,
)

TENANT = uuid.uuid4()
OTHER = uuid.uuid4()


def _scope(t=TENANT):
    return Scope(tenant_id=t, is_superadmin=False)


def _now() -> datetime:
    return datetime.now(timezone.utc)


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
async def seeded(db):
    now = _now()
    # --- cameras: 2 online, 1 offline, 1 degraded, 1 error(other) — all enabled. ---
    statuses = [("online", "cam-1"), ("online", "cam-2"), ("offline", "cam-3"),
                ("degraded", "cam-4"), ("error", "cam-5")]
    for st, cid in statuses:
        db.add(Camera(id=cid, tenant_id=TENANT, name=cid.upper(),
                      connection_type="rtsp", status=st, is_enabled=True))
    # A camera in ANOTHER tenant (must be excluded from every rollup).
    db.add(Camera(id="other-cam", tenant_id=OTHER, name="OTHER",
                  connection_type="rtsp", status="online", is_enabled=True))

    # --- storage pools: one with capacity (forecastable), one unlimited. ---
    db.add(StoragePool(id="pool-cap", tenant_id=TENANT, name="cap", pool_type="local",
                       max_size_bytes=10_000))
    db.add(StoragePool(id="pool-inf", tenant_id=TENANT, name="inf", pool_type="s3",
                       max_size_bytes=None))

    # --- recordings: cam-1 recorded 5 min ago (→ "recording"); older + 24h bytes. ---
    db.add(Recording(tenant_id=TENANT, camera_id="cam-1", profile="main", path="/r/1.mp4",
                     start_time=now - timedelta(minutes=5), end_time=now,
                     duration=300, file_size=2_000, trigger_type="continuous",
                     storage_pool_id="pool-cap", created_at=now - timedelta(minutes=5)))
    # cam-2 last recorded 2h ago (NOT recent → not "recording").
    db.add(Recording(tenant_id=TENANT, camera_id="cam-2", profile="main", path="/r/2.mp4",
                     start_time=now - timedelta(hours=2), end_time=now - timedelta(hours=2),
                     duration=300, file_size=1_000, trigger_type="continuous",
                     storage_pool_id="pool-cap", created_at=now - timedelta(hours=2)))
    # An older recording OUTSIDE the 24h window (counts in total_segments, NOT 24h bytes).
    db.add(Recording(tenant_id=TENANT, camera_id="cam-2", profile="main", path="/r/old.mp4",
                     start_time=now - timedelta(days=3), end_time=now - timedelta(days=3),
                     duration=300, file_size=5_000, trigger_type="continuous",
                     storage_pool_id="pool-cap", created_at=now - timedelta(days=3)))
    # Another tenant's recording (excluded).
    db.add(Recording(tenant_id=OTHER, camera_id="other-cam", profile="main", path="/r/x.mp4",
                     start_time=now - timedelta(minutes=1), end_time=now,
                     duration=60, file_size=9_999, trigger_type="continuous",
                     storage_pool_id=None, created_at=now - timedelta(minutes=1)))

    # --- events (24h): 2 motion(info), 1 tamper(critical), 1 recording_error on cam-3. ---
    evs = [("motion", "info", "cam-1"), ("motion", "info", "cam-2"),
           ("tamper", "critical", "cam-4"), ("recording_error", "critical", "cam-3")]
    for i, (et, sev, cid) in enumerate(evs):
        db.add(VmsEvent(tenant_id=TENANT, camera_id=cid, event_type=et, severity=sev,
                        source="system", title=f"{et} on {cid}",
                        dedup_key=f"dk-{i}", occurred_at=now - timedelta(minutes=i + 1)))
    # An OLD event (>24h) — must be excluded from the 24h rollup.
    db.add(VmsEvent(tenant_id=TENANT, camera_id="cam-1", event_type="motion", severity="info",
                    source="system", title="old", dedup_key="dk-old",
                    occurred_at=now - timedelta(days=2)))

    # --- media nodes: 1 online, 1 offline. ---
    db.add(MediaNode(id="node-1", tenant_id=TENANT, name="node-1", host="h1",
                     status="online", used_channels=3, capacity_channels=10))
    db.add(MediaNode(id="node-2", tenant_id=TENANT, name="node-2", host="h2",
                     status="offline", used_channels=0, capacity_channels=10))

    # --- NVRs: 2 online (healthy), 1 offline (unhealthy). ---
    db.add(NVR(id="nvr-1", tenant_id=TENANT, name="nvr-1", host="n1", status="online"))
    db.add(NVR(id="nvr-2", tenant_id=TENANT, name="nvr-2", host="n2", status="online"))
    db.add(NVR(id="nvr-3", tenant_id=TENANT, name="nvr-3", host="n3", status="offline"))

    await db.commit()
    return db


def _patch_nvr_ok(monkeypatch):
    async def fake_status(self, *, timeout=None):
        return {"resilience": True, "streaming": True, "recording": True,
                "nats": True, "node": "local-node"}
    monkeypatch.setattr(NvrClient, "status", fake_status)


def _patch_nvr_down(monkeypatch):
    async def fake_status(self, *, timeout=None):
        raise NvrUnavailable("nvr data-plane unreachable: connection refused")
    monkeypatch.setattr(NvrClient, "status", fake_status)


async def test_summary_shape_and_cameras(seeded, monkeypatch):
    _patch_nvr_ok(monkeypatch)
    svc = DashboardService(seeded, _scope(), bearer="tok")
    out = await svc.summary()

    # every top-level section present.
    assert out.generated_at is not None
    for attr in ("cameras", "recording", "storage", "nodes", "alarms", "nvrs"):
        assert getattr(out, attr) is not None

    c = out.cameras
    assert c.total == 5  # OTHER-tenant camera excluded
    assert c.online == 2
    assert c.offline == 1
    assert c.degraded == 1
    assert c.other == 1  # "error"


async def test_recording_rollup(seeded, monkeypatch):
    _patch_nvr_ok(monkeypatch)
    out = await DashboardService(seeded, _scope(), bearer="tok").summary()
    r = out.recording
    assert r.recording == 1  # cam-1 has a segment 5 min ago
    assert r.failed == 1  # cam-3 has a recording_error event
    # idle = enabled(5) - recording(1) - failed(1) = 3
    assert r.idle == 3
    assert r.total_segments == 3  # 3 tenant recordings (OTHER excluded)
    assert r.bytes_last_24h == 3_000  # 2000 + 1000 (the 3-day-old 5000 excluded)


async def test_storage_rollup_and_forecast(seeded, monkeypatch):
    _patch_nvr_ok(monkeypatch)
    out = await DashboardService(seeded, _scope(), bearer="tok").summary()
    s = out.storage
    pools = {p.id: p for p in s.pools}
    assert set(pools) == {"pool-cap", "pool-inf"}
    cap = pools["pool-cap"]
    # used = 2000 + 1000 + 5000 = 8000 on pool-cap.
    assert cap.used_bytes == 8_000
    assert cap.capacity_bytes == 10_000
    assert cap.used_pct == 80.0
    assert cap.days_to_full is not None and cap.days_to_full > 0
    inf = pools["pool-inf"]
    assert inf.capacity_bytes is None
    assert inf.used_pct is None
    assert inf.days_to_full is None  # unlimited → no forecast
    # estate total: only pool-cap has capacity.
    assert s.total_used_bytes == 8_000
    assert s.total_capacity_bytes == 10_000
    assert s.used_pct == 80.0


async def test_alarms_rollup(seeded, monkeypatch):
    _patch_nvr_ok(monkeypatch)
    out = await DashboardService(seeded, _scope(), bearer="tok").summary()
    a = out.alarms
    assert a.total == 4  # old (>24h) event excluded
    sev = {b.key: b.count for b in a.by_severity}
    assert sev == {"info": 2, "critical": 2}
    typ = {b.key: b.count for b in a.by_type}
    assert typ["motion"] == 2 and typ["tamper"] == 1 and typ["recording_error"] == 1
    assert len(a.recent) == 4
    # recent newest-first.
    assert a.recent[0].occurred_at >= a.recent[-1].occurred_at


async def test_nvr_rollup(seeded, monkeypatch):
    _patch_nvr_ok(monkeypatch)
    out = await DashboardService(seeded, _scope(), bearer="tok").summary()
    assert out.nvrs.total == 3
    assert out.nvrs.healthy == 2
    assert out.nvrs.unhealthy == 1


async def test_nodes_ok(seeded, monkeypatch):
    _patch_nvr_ok(monkeypatch)
    out = await DashboardService(seeded, _scope(), bearer="tok").summary()
    n = out.nodes
    assert n.total == 2
    assert n.healthy == 1
    assert n.unhealthy == 1
    assert n.data_plane == "ok"
    assert n.resilience is True
    assert n.nvr_node == "local-node"


async def test_nodes_degrade_when_nvr_unreachable(seeded, monkeypatch):
    _patch_nvr_down(monkeypatch)
    out = await DashboardService(seeded, _scope(), bearer="tok").summary()
    n = out.nodes
    # node LIST still comes from the local registry (renders even when nvr is down).
    assert n.total == 2
    assert n.healthy == 1
    # resilience flags unknown; no crash.
    assert n.data_plane == "unknown"
    assert n.resilience is None
    assert n.streaming is None


async def test_tenant_isolation(seeded, monkeypatch):
    _patch_nvr_ok(monkeypatch)
    # OTHER tenant has one camera + one recording, no pools/nodes/events/nvrs.
    out = await DashboardService(seeded, _scope(OTHER), bearer="tok").summary()
    assert out.cameras.total == 1
    assert out.cameras.online == 1
    assert out.recording.total_segments == 1
    assert out.storage.pools == []
    assert out.nodes.total == 0
    assert out.alarms.total == 0
    assert out.nvrs.total == 0


async def test_empty_tenant_returns_zeros(db, monkeypatch):
    _patch_nvr_down(monkeypatch)  # no nvr either
    empty = uuid.uuid4()
    out = await DashboardService(db, _scope(empty), bearer=None).summary()
    assert out.cameras.total == 0
    assert out.recording.recording == 0 and out.recording.idle == 0
    assert out.storage.pools == []
    assert out.storage.total_used_bytes == 0
    assert out.alarms.total == 0
    assert out.nvrs.total == 0
    assert out.nodes.total == 0
    assert out.nodes.data_plane == "unknown"


def test_days_to_full_edges():
    # unlimited pool → None
    assert _days_to_full(None, 100, 50, 7) is None
    # no growth → None
    assert _days_to_full(10_000, 5_000, 0, 7) is None
    # already full → 0.0
    assert _days_to_full(10_000, 10_000, 700, 7) == 0.0
    # normal: remaining 5000, growth 700/7 = 100/day → 50 days
    assert _days_to_full(10_000, 5_000, 700, 7) == 50.0
