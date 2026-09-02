"""G8 report tests — operator-activity + alarm-response rollups.

No network. In-memory SQLite seeded with vision's actor-stamped rows (exports, motion
searches, bookmarks, evidence locks/releases) + VmsEvent rows (some acked) across two
tenants. Asserts:
  * operator-activity: per-operator action counts + by_action totals from vision's own
    tables; tenant isolation; the source_note honesty flag.
  * alarm-response: ack-rate + time-to-ack over alarm/critical VmsEvents; per-camera +
    by-severity + estate totals; only alarm-tier events counted; tenant isolation.
  * both new kinds are in REPORT_KINDS + dispatch through compute_report + render to CSV.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

from kernel.auth import Scope

import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import Base
from app.vms.models import (
    Bookmark,
    Camera,
    EvidenceLock,
    ExportJob,
    MotionSearchJob,
    VmsEvent,
)
from app.vms.reports import computations, render

TENANT = uuid.uuid4()
OTHER = uuid.uuid4()


def _dt(h, m=0):
    return datetime(2026, 7, 9, h, m, tzinfo=timezone.utc)


def _scope(t=TENANT):
    return Scope(tenant_id=t, is_superadmin=False)


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
    db.add(Camera(id="cam-a", tenant_id=TENANT, name="Cam A", connection_type="rtsp", status="online"))
    db.add(Camera(id="cam-b", tenant_id=TENANT, name="Cam B", connection_type="rtsp", status="online"))

    # ── operator-activity sources (all inside [09:00, 12:00)) ──
    # alice: 2 exports + 1 bookmark; bob: 1 motion search + 1 evidence lock.
    db.add(ExportJob(tenant_id=TENANT, camera_id="cam-a", from_time=_dt(8), to_time=_dt(9),
                     requested_by="alice", created_at=_dt(9, 10)))
    db.add(ExportJob(tenant_id=TENANT, camera_id="cam-a", from_time=_dt(8), to_time=_dt(9),
                     requested_by="alice", created_at=_dt(9, 20)))
    db.add(Bookmark(tenant_id=TENANT, camera_id="cam-a", title="Interesting", start_ts=_dt(9, 30),
                    created_by="alice", created_at=_dt(9, 30)))
    db.add(MotionSearchJob(tenant_id=TENANT, camera_id="cam-b", from_time=_dt(8), to_time=_dt(9),
                           requested_by="bob", created_at=_dt(10, 0)))
    db.add(EvidenceLock(tenant_id=TENANT, camera_id="cam-b", start_ts=_dt(8), end_ts=_dt(9),
                        created_by="bob", created_at=_dt(10, 5)))
    # An export OUTSIDE the window (should be excluded).
    db.add(ExportJob(tenant_id=TENANT, camera_id="cam-a", from_time=_dt(1), to_time=_dt(2),
                     requested_by="alice", created_at=_dt(2, 0)))
    # A foreign-tenant export (isolation).
    db.add(ExportJob(tenant_id=OTHER, camera_id="cam-x", from_time=_dt(8), to_time=_dt(9),
                     requested_by="mallory", created_at=_dt(9, 15)))

    # ── alarm-response sources ──
    # cam-a: 2 alarm events, 1 acked (occurred 09:00 → acked 09:05 = 300s).
    db.add(VmsEvent(tenant_id=TENANT, camera_id="cam-a", event_type="motion", severity="alarm",
                    source="onvif", title="motion", raw={}, dedup_key="a1", occurred_at=_dt(9, 0),
                    acknowledged=True, acknowledged_by="alice", acknowledged_at=_dt(9, 5)))
    db.add(VmsEvent(tenant_id=TENANT, camera_id="cam-a", event_type="motion", severity="alarm",
                    source="onvif", title="motion", raw={}, dedup_key="a2", occurred_at=_dt(9, 30),
                    acknowledged=False))
    # cam-b: 1 critical event, acked (occurred 10:00 → acked 10:10 = 600s).
    db.add(VmsEvent(tenant_id=TENANT, camera_id="cam-b", event_type="tamper", severity="critical",
                    source="onvif", title="tamper", raw={}, dedup_key="b1", occurred_at=_dt(10, 0),
                    acknowledged=True, acknowledged_by="bob", acknowledged_at=_dt(10, 10)))
    # An INFO event (must be excluded from alarm-response).
    db.add(VmsEvent(tenant_id=TENANT, camera_id="cam-a", event_type="heartbeat", severity="info",
                    source="onvif", title="hb", raw={}, dedup_key="i1", occurred_at=_dt(9, 45)))
    # A foreign-tenant alarm (isolation).
    db.add(VmsEvent(tenant_id=OTHER, camera_id="cam-x", event_type="motion", severity="alarm",
                    source="onvif", title="motion", raw={}, dedup_key="o1", occurred_at=_dt(9, 0)))
    await db.commit()


# ── operator-activity ─────────────────────────────────────────────────────────────
async def test_operator_activity_rollup(db, seeded):
    r = await computations.compute_operator_activity(db, _scope(), _dt(9, 0), _dt(12, 0), None)
    by_op = {row["operator"]: row for row in r["rows"]}
    assert set(by_op) == {"alice", "bob"}
    # alice: 2 exports + 1 bookmark + 1 event-ack (she acked the cam-a alarm) = 4.
    assert by_op["alice"]["exports"] == 2
    assert by_op["alice"]["bookmarks"] == 1
    assert by_op["alice"]["event_acks"] == 1
    assert by_op["alice"]["total_actions"] == 4
    # bob: 1 motion search + 1 evidence lock + 1 event-ack (cam-b critical) = 3.
    assert by_op["bob"]["motion_searches"] == 1
    assert by_op["bob"]["evidence_locks"] == 1
    assert by_op["bob"]["event_acks"] == 1
    assert by_op["bob"]["total_actions"] == 3
    # by_action totals + grand total.
    assert r["by_action"]["export"] == 2
    assert r["by_action"]["event_ack"] == 2
    assert r["totals"]["operators"] == 2
    assert r["totals"]["total_actions"] == 7
    # honesty note present.
    assert "core's Activity log" in r["source_note"]


async def test_operator_activity_camera_filter(db, seeded):
    # cam-b sources: bob's motion search + evidence lock (alice's are on cam-a).
    r = await computations.compute_operator_activity(db, _scope(), _dt(9, 0), _dt(12, 0), "cam-b")
    ops = {row["operator"] for row in r["rows"]}
    assert ops == {"bob"}


async def test_operator_activity_tenant_isolation(db, seeded):
    r = await computations.compute_operator_activity(db, _scope(OTHER), _dt(9, 0), _dt(12, 0), None)
    ops = {row["operator"] for row in r["rows"]}
    assert "mallory" in ops  # OTHER sees only its own
    assert "alice" not in ops and "bob" not in ops


# ── alarm-response ────────────────────────────────────────────────────────────────
async def test_alarm_response_rollup(db, seeded):
    r = await computations.compute_alarm_response(db, _scope(), _dt(9, 0), _dt(12, 0), None)
    # 3 alarm-tier events (2 alarm on cam-a, 1 critical on cam-b); info excluded.
    assert r["totals"]["alarms"] == 3
    assert r["totals"]["acknowledged"] == 2
    assert r["totals"]["unacknowledged"] == 1
    assert r["totals"]["ack_rate_pct"] == round(100.0 * 2 / 3, 2)
    # TTA samples: 300s (cam-a) + 600s (cam-b) → avg 450, max 600.
    assert r["totals"]["avg_time_to_ack_s"] == 450.0
    assert r["totals"]["max_time_to_ack_s"] == 600.0

    by_cam = {row["camera_id"]: row for row in r["rows"]}
    assert by_cam["cam-a"]["alarms"] == 2 and by_cam["cam-a"]["acknowledged"] == 1
    assert by_cam["cam-a"]["ack_rate_pct"] == 50.0
    assert by_cam["cam-a"]["avg_time_to_ack_s"] == 300.0
    assert by_cam["cam-b"]["ack_rate_pct"] == 100.0
    assert by_cam["cam-a"]["camera_name"] == "Cam A"

    # by-severity split.
    assert r["by_severity"]["alarm"]["alarms"] == 2
    assert r["by_severity"]["critical"]["alarms"] == 1
    assert "workflow service" in r["source_note"]


async def test_alarm_response_camera_filter(db, seeded):
    r = await computations.compute_alarm_response(db, _scope(), _dt(9, 0), _dt(12, 0), "cam-b")
    assert r["totals"]["alarms"] == 1
    assert {row["camera_id"] for row in r["rows"]} == {"cam-b"}


async def test_alarm_response_tenant_isolation(db, seeded):
    # OTHER has 1 unacked alarm.
    r = await computations.compute_alarm_response(db, _scope(OTHER), _dt(9, 0), _dt(12, 0), None)
    assert r["totals"]["alarms"] == 1
    assert r["totals"]["acknowledged"] == 0
    assert r["totals"]["avg_time_to_ack_s"] is None


# ── dispatch + render integration ────────────────────────────────────────────────
def test_new_kinds_registered():
    assert "operator-activity" in computations.REPORT_KINDS
    assert "alarm-response" in computations.REPORT_KINDS


async def test_compute_report_dispatches_new_kinds(db, seeded):
    r1 = await computations.compute_report("operator-activity", db, _scope(), _dt(9), _dt(12), None)
    assert r1["kind"] == "operator-activity"
    r2 = await computations.compute_report("alarm-response", db, _scope(), _dt(9), _dt(12), None)
    assert r2["kind"] == "alarm-response"


async def test_new_kinds_render_csv(db, seeded):
    r = await computations.compute_operator_activity(db, _scope(), _dt(9, 0), _dt(12, 0), None)
    csv_bytes = render.to_csv(r)
    text = csv_bytes.decode("utf-8")
    assert "# report: operator-activity" in text
    assert "operator" in text and "alice" in text

    r2 = await computations.compute_alarm_response(db, _scope(), _dt(9, 0), _dt(12, 0), None)
    csv2 = render.to_csv(r2).decode("utf-8")
    assert "ack_rate_pct" in csv2
