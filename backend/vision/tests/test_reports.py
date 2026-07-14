"""P6-B operational-reporting tests — each computation + CSV/PDF render + schedule fire.

No network. In-memory SQLite seeded with a camera + health samples + recordings + events +
a storage pool. Asserts:
  * camera-uptime online % from CameraHealth samples.
  * recording-coverage recorded-seconds vs window.
  * storage-usage bytes per pool + total.
  * event-stats counts by type/severity/camera.
  * health-summary roll-up.
  * to_csv / to_pdf render bytes; CSV has the rows.
  * ReportService CRUD + next_run computation; tenant isolation.
  * ReportScheduler.run_cycle fires a due schedule → emit_notify_request published
    (a fake bus captures ``tenant.<id>.notify.request``).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import NotFoundError, ValidationError

from app.db import Base
from app.vms.models import (
    Camera,
    CameraHealth,
    Recording,
    ReportSchedule,
    StoragePool,
    VmsEvent,
)
from app.vms.reports import computations, render
from app.vms.reports.schemas import ReportScheduleCreate, ReportScheduleUpdate
from app.vms.reports.service import ReportService, cadence_window, compute_next_run

TENANT = uuid.uuid4()
OTHER = uuid.uuid4()


class _Actor:
    user_id = uuid.uuid4()


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
    cam = Camera(id="cam-a", tenant_id=TENANT, name="Cam A", connection_type="rtsp", status="online")
    db.add(cam)
    # Health: 3 online, 1 offline in [09:00, 12:00) → 75% uptime. All 4 samples fall
    # strictly inside the window (09:00, 09:30, 10:00, 11:00) so the count is 4.
    for st, hm in [("online", (9, 0)), ("online", (9, 30)), ("online", (10, 0)), ("offline", (11, 0))]:
        db.add(CameraHealth(tenant_id=TENANT, camera_id="cam-a", status=st, captured_at=_dt(*hm)))
    # A storage pool + 2 recordings (1h each) covering part of the window, 1000 bytes each.
    db.add(StoragePool(id="pool-1", tenant_id=TENANT, name="local-1", pool_type="local"))
    db.add(Recording(
        tenant_id=TENANT, camera_id="cam-a", profile="main", path="/rec/1.mp4",
        start_time=_dt(9, 0), end_time=_dt(10, 0), duration=3600, file_size=1000,
        trigger_type="continuous", storage_pool_id="pool-1", created_at=_dt(9, 0),
    ))
    db.add(Recording(
        tenant_id=TENANT, camera_id="cam-a", profile="main", path="/rec/2.mp4",
        start_time=_dt(10, 0), end_time=_dt(11, 0), duration=3600, file_size=2000,
        trigger_type="continuous", storage_pool_id="pool-1", created_at=_dt(10, 0),
    ))
    # Events: 2 motion (info), 1 tamper (critical).
    for i, (et, sev) in enumerate([("motion", "info"), ("motion", "info"), ("tamper", "critical")]):
        db.add(VmsEvent(
            tenant_id=TENANT, camera_id="cam-a", event_type=et, severity=sev, source="onvif",
            title=et, raw={}, dedup_key=f"d{i}", occurred_at=_dt(9, 30 + i),
        ))
    await db.commit()
    return cam


# ── computations ────────────────────────────────────────────────────────────────
async def test_camera_uptime(db, seeded):
    r = await computations.compute_camera_uptime(db, _scope(), _dt(9, 0), _dt(12, 0), None)
    row = r["rows"][0]
    assert row["samples"] == 4 and row["online_samples"] == 3
    assert row["uptime_pct"] == 75.0
    assert r["totals"]["avg_uptime_pct"] == 75.0


async def test_recording_coverage(db, seeded):
    # Window 09:00→11:00 (7200s); 2 recordings cover the full 7200s.
    r = await computations.compute_recording_coverage(db, _scope(), _dt(9, 0), _dt(11, 0), None)
    row = r["rows"][0]
    assert row["expected_seconds"] == 7200.0
    assert row["recorded_seconds"] == 7200.0
    assert row["coverage_pct"] == 100.0
    assert row["bytes"] == 3000


async def test_recording_coverage_partial(db, seeded):
    # Window 09:00→13:00 (14400s); only 7200s recorded → 50%.
    r = await computations.compute_recording_coverage(db, _scope(), _dt(9, 0), _dt(13, 0), None)
    row = r["rows"][0]
    assert row["coverage_pct"] == 50.0


async def test_storage_usage(db, seeded):
    r = await computations.compute_storage_usage(db, _scope(), _dt(8, 0), _dt(12, 0), None)
    assert r["totals"]["total_bytes"] == 3000
    assert r["rows"][0]["pool_name"] == "local-1"
    assert r["rows"][0]["segments"] == 2


async def test_event_stats(db, seeded):
    r = await computations.compute_event_stats(db, _scope(), _dt(9, 0), _dt(12, 0), None)
    assert r["totals"]["total_events"] == 3
    assert r["by_type"]["motion"] == 2
    assert r["by_type"]["tamper"] == 1
    assert r["by_severity"]["critical"] == 1
    assert r["rows"][0]["camera_name"] == "Cam A"


async def test_health_summary(db, seeded):
    r = await computations.compute_health_summary(db, _scope(), _dt(9, 0), _dt(12, 0), None)
    metrics = {row["metric"]: row["value"] for row in r["rows"]}
    assert metrics["cameras_total"] == 1
    assert metrics["cameras_online"] == 1
    assert metrics["events_total"] == 3
    assert metrics["events_critical"] == 1


async def test_tenant_isolation(db, seeded):
    r = await computations.compute_camera_uptime(db, _scope(OTHER), _dt(9, 0), _dt(12, 0), None)
    assert r["rows"] == []  # other tenant sees nothing


async def test_unknown_kind_raises(db, seeded):
    with pytest.raises(ValueError):
        await computations.compute_report("nope", db, _scope(), _dt(9), _dt(12), None)


# ── render ────────────────────────────────────────────────────────────────────
async def test_csv_render(db, seeded):
    r = await computations.compute_camera_uptime(db, _scope(), _dt(9, 0), _dt(12, 0), None)
    csv_bytes = render.to_csv(r)
    text = csv_bytes.decode("utf-8")
    assert "uptime_pct" in text
    assert "Cam A" in text
    assert "# report: camera-uptime" in text


async def test_pdf_render(db, seeded):
    r = await computations.compute_event_stats(db, _scope(), _dt(9, 0), _dt(12, 0), None)
    pdf = render.to_pdf(r)
    assert pdf[:4] == b"%PDF"  # a real PDF


# ── service CRUD ──────────────────────────────────────────────────────────────
async def test_schedule_crud(db, seeded):
    svc = ReportService(db, _scope())
    body = ReportScheduleCreate(name="Daily uptime", kind="camera-uptime", cadence="daily",
                                export_format="csv", recipients=["ops@x.com"])
    sched = await svc.create_schedule(body, actor=_Actor())
    assert sched.tenant_id == TENANT and sched.next_run_at is not None
    got = await svc.get_schedule(sched.id)
    assert got.name == "Daily uptime"
    upd = await svc.update_schedule(sched.id, ReportScheduleUpdate(enabled=False), actor=_Actor())
    assert upd.enabled is False
    await svc.delete_schedule(sched.id)
    with pytest.raises(NotFoundError):
        await svc.get_schedule(sched.id)


async def test_schedule_bad_kind_422(db):
    svc = ReportService(db, _scope())
    with pytest.raises(ValidationError):
        await svc.create_schedule(
            ReportScheduleCreate(name="x", kind="bogus"), actor=_Actor()
        )


async def test_schedule_tenant_isolation(db, seeded):
    sched = await ReportService(db, _scope()).create_schedule(
        ReportScheduleCreate(name="x", kind="camera-uptime"), actor=_Actor()
    )
    with pytest.raises(NotFoundError):
        await ReportService(db, _scope(OTHER)).get_schedule(sched.id)


def test_compute_next_run_and_window():
    now = _dt(10, 0)
    nr = compute_next_run("daily", 6, now=now)
    assert nr > now
    f, t = cadence_window("weekly", now)
    assert (t - f) == timedelta(days=7)


# ── scheduler fire → notify ─────────────────────────────────────────────────────
class _FakeBus:
    def __init__(self):
        self.published = []

    async def publish(self, subj, payload):
        self.published.append((subj, payload))


async def test_scheduler_fires_and_notifies(db, seeded, monkeypatch):
    from app.vms.reports import scheduler as sched_mod

    # A due schedule (next_run in the past).
    row = ReportSchedule(
        tenant_id=TENANT, name="Daily", kind="event-stats", cadence="daily",
        export_format="csv", recipients=["ops@x.com"], channel="email", enabled=True,
        hour_utc=6, next_run_at=_dt(8, 0),
    )
    db.add(row)
    await db.commit()

    # Capture the notify publish via a fake bus injected into emit_notify_request's module.
    fake = _FakeBus()
    monkeypatch.setattr("app.vms.common.events.bus", fake)

    sm = async_sessionmaker(db.bind, class_=AsyncSession, expire_on_commit=False)
    scheduler = sched_mod.ReportScheduler(sm)
    fired = await scheduler.run_cycle(now=_dt(9, 0))
    assert fired == 1

    # A notify.request was published for this tenant.
    subjects = [s for s, _ in fake.published]
    assert any("notify.request" in s for s in subjects)
    _, payload = next((s, p) for s, p in fake.published if "notify.request" in s)
    assert payload["channel"] == "email"
    assert payload["report_kind"] == "event-stats"
    assert "attachment" in payload and payload["attachment"]["content_b64"]

    # The schedule advanced (run_count + next_run_at moved forward).
    await db.commit()
    updated = await db.get(ReportSchedule, row.id)
    await db.refresh(updated)
    assert updated.run_count == 1
    assert updated.last_run_at is not None
    # SQLite reads timestamps back naive; coerce to aware-UTC for the comparison.
    nr = updated.next_run_at
    if nr.tzinfo is None:
        nr = nr.replace(tzinfo=timezone.utc)
    assert nr > _dt(9, 0)
