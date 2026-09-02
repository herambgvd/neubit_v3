"""P4-B clip-export tests — job lifecycle + concat-plan + a real ffmpeg concat.

Two layers, no network:
  * ExportService (in-memory SQLite) — queue a job (covered-recordings check → queued),
    the no-recordings 404, empty-window 404, tenant isolation, status/download resolve.
  * ExportWorker — the full concat: synthetic fmp4 segments are generated with the REAL
    ffmpeg (skipped if ffmpeg is absent), the worker claims + concats them into a
    playable mp4 (ftyp/moov present), flips the job to ``done`` (+ file_size); a
    missing-segment window flips it to ``failed`` (no crash).

The concat-plan math (segment ordering + head-offset + duration) is unit-tested pure.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import NotFoundError

from app.db import Base
from app.vms.export.service import (
    ExportNotFound,
    ExportService,
    build_concat_plan,
)
from app.vms.models import Camera, ExportJob, Recording

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()

_HAS_FFMPEG = shutil.which("ffmpeg") is not None


class _Actor:
    user_id = uuid.uuid4()


def _dt(h, m=0, s=0):
    return datetime(2026, 7, 9, h, m, s, tzinfo=timezone.utc)


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
async def camera(db):
    cam = Camera(id=str(uuid.uuid4()), tenant_id=TENANT, name="Cam A", connection_type="rtsp")
    db.add(cam)
    await db.commit()
    return cam


async def _add_recording(db, camera_id, start, end, *, path=None, tenant=TENANT):
    rec = Recording(
        tenant_id=tenant,
        camera_id=camera_id,
        profile="main",
        path=path or f"/recordings/{camera_id}/{start.isoformat()}.mp4",
        start_time=start,
        end_time=end,
        duration=((end - start).total_seconds() if end else None),
        trigger_type="continuous",
    )
    db.add(rec)
    await db.commit()
    return rec


def _scope(tenant=TENANT):
    return Scope(tenant_id=tenant, is_superadmin=False)


# ── concat-plan (pure) ────────────────────────────────────────────────────────────
def test_build_concat_plan_orders_and_offsets():
    class _R:
        def __init__(self, start, path):
            self.start_time = start
            self.path = path

    recs = [
        _R(_dt(10, 5), "/rec/b.mp4"),
        _R(_dt(10, 0), "/rec/a.mp4"),
    ]
    # Window from 10:02 → 10:08: first segment starts 10:00, so head_offset = 120s.
    plan = build_concat_plan(recs, _dt(10, 2), _dt(10, 8))
    assert plan.segment_paths == ["/rec/a.mp4", "/rec/b.mp4"]  # sorted by start
    assert plan.head_offset_sec == 120.0
    assert plan.duration_sec == 360.0
    assert plan.local_only is True


def test_build_concat_plan_flags_s3_segments():
    class _R:
        def __init__(self, start, path):
            self.start_time = start
            self.path = path

    recs = [_R(_dt(10, 0), "s3://bucket/cam/seg.mp4")]
    plan = build_concat_plan(recs, _dt(10, 0), _dt(10, 1))
    assert plan.local_only is False


# ── service: queue + guards ───────────────────────────────────────────────────────
async def test_create_queues_job_when_covered(db, camera):
    await _add_recording(db, camera.id, _dt(10, 0), _dt(10, 1))
    svc = ExportService(db, _scope())
    job = await svc.create(camera.id, _dt(9, 0), _dt(11, 0), "mp4", actor=_Actor())
    assert job.status == "queued"
    assert job.tenant_id == TENANT
    assert job.camera_id == camera.id
    assert job.format == "mp4"


async def test_create_no_recordings_is_404(db, camera):
    svc = ExportService(db, _scope())
    with pytest.raises(ExportNotFound):
        await svc.create(camera.id, _dt(9, 0), _dt(11, 0), "mp4", actor=_Actor())


async def test_create_empty_window_is_404(db, camera):
    await _add_recording(db, camera.id, _dt(10, 0), _dt(10, 1))
    svc = ExportService(db, _scope())
    with pytest.raises(ExportNotFound):
        await svc.create(camera.id, _dt(10, 0), _dt(10, 0), "mp4", actor=_Actor())


async def test_create_tenant_isolation(db, camera):
    await _add_recording(db, camera.id, _dt(10, 0), _dt(10, 1))
    svc = ExportService(db, _scope(OTHER_TENANT))
    with pytest.raises(NotFoundError):
        await svc.create(camera.id, _dt(9, 0), _dt(11, 0), "mp4", actor=_Actor())


async def test_download_not_ready_is_404(db, camera):
    await _add_recording(db, camera.id, _dt(10, 0), _dt(10, 1))
    svc = ExportService(db, _scope())
    job = await svc.create(camera.id, _dt(9, 0), _dt(11, 0), "mp4", actor=_Actor())
    with pytest.raises(ExportNotFound):
        await svc.resolve_download(job.id)  # still queued


async def test_get_job_tenant_isolation(db, camera):
    await _add_recording(db, camera.id, _dt(10, 0), _dt(10, 1))
    job = await ExportService(db, _scope()).create(
        camera.id, _dt(9, 0), _dt(11, 0), "mp4", actor=_Actor()
    )
    with pytest.raises(NotFoundError):
        await ExportService(db, _scope(OTHER_TENANT)).get(job.id)


# ── worker: real ffmpeg concat ────────────────────────────────────────────────────
def _make_segment(path: str, seconds: int) -> None:
    """Generate a tiny H.264 fmp4 segment with ffmpeg (a colour testsrc)."""
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc=size=160x120:rate=15:duration={seconds}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "15",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof",
            path,
        ],
        check=True,
        capture_output=True,
    )


@pytest.mark.skipif(not _HAS_FFMPEG, reason="ffmpeg not installed")
async def test_worker_produces_playable_mp4(db, camera, tmp_path, monkeypatch):
    from app.vms.export import worker as worker_mod

    # Downloads area → a temp dir (avoid /recordings).
    monkeypatch.setenv("VE_DOWNLOADS_DIR", str(tmp_path / "downloads"))

    # Two contiguous 2s segments on disk; a job covering both.
    seg1 = str(tmp_path / "seg1.mp4")
    seg2 = str(tmp_path / "seg2.mp4")
    _make_segment(seg1, 2)
    _make_segment(seg2, 2)
    await _add_recording(db, camera.id, _dt(10, 0, 0), _dt(10, 0, 2), path=seg1)
    await _add_recording(db, camera.id, _dt(10, 0, 2), _dt(10, 0, 4), path=seg2)

    job = await ExportService(db, _scope()).create(
        camera.id, _dt(10, 0, 0), _dt(10, 0, 4), "mp4", actor=_Actor()
    )

    # A sessionmaker bound to the SAME engine (the worker opens its own sessions).
    engine = db.bind
    sm = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    w = worker_mod.ExportWorker(sm)
    ran = await w.run_cycle()
    assert ran == 1

    # Reload the job → done with a real file.
    await db.commit()
    done = await db.get(ExportJob, job.id)
    await db.refresh(done)
    assert done.status == "done", done.error
    assert done.file_path and os.path.exists(done.file_path)
    assert done.file_size and done.file_size > 0

    # The output is a valid MP4 (ftyp + moov boxes present).
    with open(done.file_path, "rb") as fh:
        head = fh.read(4096)
    assert b"ftyp" in head
    assert b"moov" in open(done.file_path, "rb").read()


@pytest.mark.skipif(not _HAS_FFMPEG, reason="ffmpeg not installed")
async def test_worker_fails_gracefully_on_missing_segments(db, camera, tmp_path, monkeypatch):
    from app.vms.export import worker as worker_mod

    monkeypatch.setenv("VE_DOWNLOADS_DIR", str(tmp_path / "downloads"))
    # A recording row whose file does NOT exist on disk.
    await _add_recording(
        db, camera.id, _dt(10, 0), _dt(10, 1), path=str(tmp_path / "gone.mp4")
    )
    job = await ExportService(db, _scope()).create(
        camera.id, _dt(10, 0), _dt(10, 1), "mp4", actor=_Actor()
    )

    engine = db.bind
    sm = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    ran = await worker_mod.ExportWorker(sm).run_cycle()
    assert ran == 1

    await db.commit()
    failed = await db.get(ExportJob, job.id)
    await db.refresh(failed)
    assert failed.status == "failed"
    assert failed.error and "missing" in failed.error.lower()


async def test_worker_fails_on_s3_tiered_window(db, camera, tmp_path, monkeypatch):
    from app.vms.export import worker as worker_mod

    monkeypatch.setenv("VE_DOWNLOADS_DIR", str(tmp_path / "downloads"))
    await _add_recording(
        db, camera.id, _dt(10, 0), _dt(10, 1), path="s3://bucket/cam/seg.mp4"
    )
    job = await ExportService(db, _scope()).create(
        camera.id, _dt(10, 0), _dt(10, 1), "mp4", actor=_Actor()
    )
    engine = db.bind
    sm = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    await worker_mod.ExportWorker(sm).run_cycle()

    await db.commit()
    failed = await db.get(ExportJob, job.id)
    await db.refresh(failed)
    assert failed.status == "failed"
    assert "s3" in (failed.error or "").lower()
