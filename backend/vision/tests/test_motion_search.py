"""Forensic Motion Search (G4) tests — no network, in-memory SQLite + parser fixtures.

Two layers:
  * PARSER/THRESHOLD (pure, no ffmpeg): feed a sample ``metadata=print`` output string →
    assert the (t, score) series is parsed; feed a synthetic score series → assert the
    hit intervals (threshold, min-duration de-noise, gap-merge). The sensitivity→threshold
    map + region→crop filter are asserted too. This is the load-bearing logic and needs
    NO real video.
  * SERVICE (in-memory SQLite): job create (queued), tenant isolation, window-cap
    truncation (+ note), empty-window + no-recordings 404, status read.
  * WORKER (monkeypatched ffmpeg): a fixture ``analyze_segment`` returns canned scores →
    the worker offsets to absolute time, thresholds, unions regions, writes ``done`` +
    hits; a MISSING segment file → graceful (job fails cleanly when nothing analyzable).

pytest-asyncio auto mode runs the ``async def test_*`` coroutines.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import NotFoundError

from app.db import Base
from app.vms.models import Camera, MotionSearchJob, Recording
from app.vms.motion_search.schemas import MotionSearchStartBody, Region
from app.vms.motion_search.service import MotionSearchService
from app.vms.motion_search import ffmpeg as mff
from app.vms.motion_search import worker as mworker

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()


class _Actor:
    user_id = uuid.uuid4()


def _scope(tenant=TENANT):
    return Scope(tenant_id=tenant, is_superadmin=False)


def _now():
    return datetime.now(timezone.utc)


# ── PARSER: ffmpeg metadata=print output → (t, score) series ─────────────────

_SAMPLE_METADATA_OUTPUT = """\
frame:0    pts:0       pts_time:0
lavfi.scene_score=0.001000
frame:1    pts:512     pts_time:0.250000
lavfi.scene_score=0.002000
frame:2    pts:1024    pts_time:0.500000
lavfi.scene_score=0.080000
frame:3    pts:1536    pts_time:0.750000
lavfi.scene_score=0.090000
frame:4    pts:2048    pts_time:1.000000
lavfi.scene_score=0.075000
frame:5    pts:2560    pts_time:1.250000
lavfi.scene_score=0.001500
"""


def test_parse_scene_scores_pairs_pts_and_score():
    series = mff.parse_scene_scores(_SAMPLE_METADATA_OUTPUT)
    assert len(series) == 6
    assert series[0] == (0.0, 0.001)
    assert series[2] == (0.5, 0.08)
    # times monotonically increasing
    assert [t for t, _ in series] == sorted(t for t, _ in series)


def test_parse_scene_scores_tolerates_noise_lines():
    noisy = "Input #0, mov...\n" + _SAMPLE_METADATA_OUTPUT + "\n[out#0] muxing overhead\n"
    series = mff.parse_scene_scores(noisy)
    assert len(series) == 6


# ── THRESHOLD: (t, score) series → hit intervals ─────────────────────────────

def test_scores_to_intervals_basic_run():
    # scores 0.5..1.0s are hot (>=0.02); 0/0.25/1.25 are cold → one interval ~[0.5, 1.25]
    series = mff.parse_scene_scores(_SAMPLE_METADATA_OUTPUT)
    ivs = mff.scores_to_intervals(series, threshold=0.02, sample_fps=4.0, min_duration_sec=0.4)
    assert len(ivs) == 1
    iv = ivs[0]
    assert iv["start"] == pytest.approx(0.5)
    # end extends one sample-period (0.25s) past the last hot sample (1.0) → 1.25
    assert iv["end"] == pytest.approx(1.25)
    # peak score within the run
    assert iv["score"] == pytest.approx(0.09)


def test_scores_to_intervals_min_duration_denoise():
    # a single hot sample (width = one period 0.25s) is dropped when min_duration is larger
    series = [(0.0, 0.001), (1.0, 0.5), (2.0, 0.001)]
    ivs = mff.scores_to_intervals(series, threshold=0.02, sample_fps=4.0, min_duration_sec=0.5)
    assert ivs == []
    # but kept with a small min-duration
    ivs2 = mff.scores_to_intervals(series, threshold=0.02, sample_fps=4.0, min_duration_sec=0.1)
    assert len(ivs2) == 1


def test_scores_to_intervals_gap_merge():
    # two hot clusters 3s apart do NOT merge (merge_gap 1.5); 0.5s apart DO merge
    far = [(0.0, 0.5), (0.25, 0.5), (3.0, 0.5), (3.25, 0.5)]
    ivs = mff.scores_to_intervals(far, threshold=0.02, sample_fps=4.0, merge_gap_sec=1.5, min_duration_sec=0.1)
    assert len(ivs) == 2
    near = [(0.0, 0.5), (0.25, 0.5), (0.75, 0.5)]
    ivs2 = mff.scores_to_intervals(near, threshold=0.02, sample_fps=4.0, merge_gap_sec=1.5, min_duration_sec=0.1)
    assert len(ivs2) == 1


def test_scores_to_intervals_empty_when_all_cold():
    series = [(0.0, 0.001), (0.25, 0.002)]
    assert mff.scores_to_intervals(series, threshold=0.02, sample_fps=4.0) == []


def test_sensitivity_to_threshold_monotonic():
    # higher sensitivity → lower threshold (more sensitive), bounded band
    assert mff.sensitivity_to_threshold(1.0) < mff.sensitivity_to_threshold(0.5) < mff.sensitivity_to_threshold(0.0)
    assert mff.sensitivity_to_threshold(1.0) == pytest.approx(0.002)
    assert mff.sensitivity_to_threshold(0.0) == pytest.approx(0.04)


def test_build_motion_filter_crop_and_chain():
    vf = mff.build_motion_filter({"x": 0.25, "y": 0.5, "w": 0.5, "h": 0.25}, 4.0)
    assert "crop=iw*0.5000:ih*0.2500:iw*0.2500:ih*0.5000" in vf
    assert "fps=4" in vf
    assert "select='gte(scene\\,0)'" in vf
    assert "metadata=print:file=-" in vf


def test_build_motion_filter_degenerate_region_falls_back_whole_frame():
    vf = mff.build_motion_filter({"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0}, 4.0)
    assert "crop=iw*1.0000:ih*1.0000:iw*0.0000:ih*0.0000" in vf


# ── SCHEMA: region validation + whole-frame default ──────────────────────────

def test_region_out_of_frame_rejected():
    with pytest.raises(ValueError):
        Region(x=0.8, y=0.0, w=0.5, h=0.2)  # 0.8+0.5 > 1


def test_body_defaults_whole_frame_when_no_regions():
    body = MotionSearchStartBody(**{"from": _now(), "to": _now() + timedelta(minutes=1)})
    assert len(body.regions) == 1
    r = body.regions[0]
    assert (r.x, r.y, r.w, r.h) == (0.0, 0.0, 1.0, 1.0)


# ── SERVICE: create / isolation / window-cap ─────────────────────────────────

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
    cam = Camera(
        id=str(uuid.uuid4()), tenant_id=TENANT, name="Cam A",
        connection_type="rtsp", retention_days=7,
    )
    db.add(cam)
    await db.commit()
    return cam


async def _make_recording(db, camera, *, path, start, end=None):
    rec = Recording(
        id=str(uuid.uuid4()), tenant_id=camera.tenant_id, camera_id=camera.id,
        profile="main", path=path, start_time=start, end_time=end, file_size=1024,
    )
    db.add(rec)
    await db.commit()
    return rec


async def test_service_create_queues_job(db, camera):
    svc = MotionSearchService(db, _scope())
    t = _now()
    await _make_recording(db, camera, path="/rec/a.mp4", start=t - timedelta(minutes=10), end=t)
    row = await svc.create(
        camera.id, t - timedelta(minutes=5), t,
        [{"x": 0.1, "y": 0.1, "w": 0.3, "h": 0.3}],
        sensitivity=0.5, sample_fps=4.0, actor=_Actor(),
    )
    assert row.status == "queued"
    assert row.regions == [{"x": 0.1, "y": 0.1, "w": 0.3, "h": 0.3}]
    assert row.requested_by == str(_Actor.user_id)
    # read back through get
    got = await svc.get(row.id)
    assert got.id == row.id


async def test_service_no_recordings_404(db, camera):
    svc = MotionSearchService(db, _scope())
    t = _now()
    with pytest.raises(NotFoundError):
        await svc.create(camera.id, t - timedelta(minutes=5), t, [], sensitivity=0.5, sample_fps=4.0, actor=_Actor())


async def test_service_empty_window_404(db, camera):
    svc = MotionSearchService(db, _scope())
    t = _now()
    await _make_recording(db, camera, path="/rec/a.mp4", start=t - timedelta(minutes=10), end=t)
    with pytest.raises(NotFoundError):
        await svc.create(camera.id, t, t, [], sensitivity=0.5, sample_fps=4.0, actor=_Actor())


async def test_service_window_cap_truncates_with_note(db, camera, monkeypatch):
    monkeypatch.setenv("VE_MOTION_SEARCH_MAX_WINDOW_SEC", "3600")  # 1h cap
    svc = MotionSearchService(db, _scope())
    t = _now()
    frm = t - timedelta(hours=10)
    await _make_recording(db, camera, path="/rec/a.mp4", start=frm, end=t)
    row = await svc.create(camera.id, frm, t, [], sensitivity=0.5, sample_fps=4.0, actor=_Actor())
    assert (row.to_time - row.from_time).total_seconds() == pytest.approx(3600, abs=1)
    assert row.note and "truncated" in row.note


async def test_service_tenant_isolation(db, camera):
    svc = MotionSearchService(db, _scope())
    t = _now()
    await _make_recording(db, camera, path="/rec/a.mp4", start=t - timedelta(minutes=10), end=t)
    row = await svc.create(camera.id, t - timedelta(minutes=5), t, [], sensitivity=0.5, sample_fps=4.0, actor=_Actor())
    other = MotionSearchService(db, _scope(OTHER_TENANT))
    with pytest.raises(NotFoundError):
        await other.get(row.id)
    # foreign tenant can't even queue against this camera
    with pytest.raises(NotFoundError):
        await other.create(camera.id, t - timedelta(minutes=5), t, [], sensitivity=0.5, sample_fps=4.0, actor=_Actor())


# ── WORKER: monkeypatched ffmpeg → hits; missing segment → graceful ──────────

@pytest_asyncio.fixture
async def sessionmaker_fx():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    yield Session
    await engine.dispose()


async def _seed_job(Session, *, path, seg_start, from_, to, regions):
    async with Session() as s:
        cam = Camera(id=str(uuid.uuid4()), tenant_id=TENANT, name="C", connection_type="rtsp", retention_days=7)
        s.add(cam)
        await s.flush()
        rec = Recording(
            id=str(uuid.uuid4()), tenant_id=TENANT, camera_id=cam.id, profile="main",
            path=path, start_time=seg_start, end_time=seg_start + timedelta(minutes=5), file_size=1024,
        )
        s.add(rec)
        job = MotionSearchJob(
            id=str(uuid.uuid4()), tenant_id=TENANT, camera_id=cam.id,
            from_time=from_, to_time=to, regions=regions, sensitivity=0.5, sample_fps=4.0,
            status="running", progress=0, hits=[],
        )
        s.add(job)
        await s.commit()
        return job.id


async def test_worker_produces_hits_from_fixture_scores(sessionmaker_fx, monkeypatch, tmp_path):
    Session = sessionmaker_fx
    seg = tmp_path / "seg.mp4"
    seg.write_bytes(b"fake-mp4")
    seg_start = datetime(2026, 7, 10, 12, 0, 0, tzinfo=timezone.utc)
    job_id = await _seed_job(
        Session, path=str(seg), seg_start=seg_start,
        from_=seg_start, to=seg_start + timedelta(minutes=1),
        regions=[{"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}],
    )

    # Fixture ffmpeg: hot 0.5s..1.0s into the segment.
    async def fake_analyze(path, region, *, sample_fps):
        return mff.parse_scene_scores(_SAMPLE_METADATA_OUTPUT)

    monkeypatch.setattr(mworker, "analyze_segment", fake_analyze)

    w = mworker.MotionSearchWorker(Session)
    await w._run_job(job_id)

    async with Session() as s:
        job = await s.get(MotionSearchJob, job_id)
        assert job.status == "done"
        assert job.progress == 100
        assert len(job.hits) == 1
        hit = job.hits[0]
        # absolute start = seg_start + 0.5s
        assert hit["start"].startswith("2026-07-10T12:00:00.5")
        assert hit["score"] == pytest.approx(0.09)


async def test_worker_missing_segment_fails_cleanly(sessionmaker_fx, monkeypatch):
    Session = sessionmaker_fx
    seg_start = datetime(2026, 7, 10, 12, 0, 0, tzinfo=timezone.utc)
    job_id = await _seed_job(
        Session, path="/does/not/exist.mp4", seg_start=seg_start,
        from_=seg_start, to=seg_start + timedelta(minutes=1),
        regions=[{"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}],
    )
    w = mworker.MotionSearchWorker(Session)
    await w._run_job(job_id)
    async with Session() as s:
        job = await s.get(MotionSearchJob, job_id)
        assert job.status == "failed"
        assert "analyzable" in (job.error or "")


async def test_worker_ffmpeg_unavailable_fails(sessionmaker_fx, monkeypatch, tmp_path):
    Session = sessionmaker_fx
    seg = tmp_path / "seg.mp4"
    seg.write_bytes(b"fake")
    seg_start = datetime(2026, 7, 10, 12, 0, 0, tzinfo=timezone.utc)
    job_id = await _seed_job(
        Session, path=str(seg), seg_start=seg_start,
        from_=seg_start, to=seg_start + timedelta(minutes=1),
        regions=[{"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}],
    )

    async def boom(path, region, *, sample_fps):
        raise mff.MotionFfmpegError("ffmpeg not available: [Errno 2]")

    monkeypatch.setattr(mworker, "analyze_segment", boom)
    w = mworker.MotionSearchWorker(Session)
    await w._run_job(job_id)
    async with Session() as s:
        job = await s.get(MotionSearchJob, job_id)
        assert job.status == "failed"
        assert "unavailable" in (job.error or "")
