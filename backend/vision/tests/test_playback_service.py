"""P4-A recorded-playback control-plane tests (no network).

Exercises the vision side of recorded playback against an in-memory SQLite DB with
the Go ``nvr`` playback call stubbed: recorded-session issue (token mint w/
``mode:playback`` + persist + ``?token=`` URL + ranges), the no-recordings 404, the
nvr-down 502, tenant scoping, and the timeline coverage/gap computation from
Recording rows.

Mirrors ``test_live_service`` discipline: every network boundary is a stub;
``pytest-asyncio`` auto mode runs the ``async def test_*`` coroutines.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import NotFoundError

from app.db import Base
from app.vms.common import media_token
from app.vms.common.nvr_client import NvrUnavailable
from app.vms.models import Camera, Recording, VmsEvent
from app.vms.playback.service import (
    PlaybackNotFound,
    PlaybackService,
    PlaybackUpstreamError,
    day_window,
)

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()


class _Actor:
    user_id = uuid.uuid4()


def _dt(h, m=0, s=0):
    return datetime(2026, 7, 9, h, m, s, tzinfo=timezone.utc)


class _StubNvr:
    """Stub Go-nvr client: records the playback_list call, returns canned ranges/URL."""

    def __init__(self, *, fail=False, empty=False):
        self.fail = fail
        self.empty = empty
        self.calls: list[dict] = []

    async def playback_list(self, *, camera_id, profile, from_=None, to=None):
        self.calls.append(
            {"camera_id": camera_id, "profile": profile, "from": from_, "to": to}
        )
        if self.fail:
            raise NvrUnavailable("nvr data-plane unreachable: boom")
        name = f"cameras/{TENANT}/{camera_id}/{profile}"
        if self.empty:
            return {"ranges": [], "playback_url": "", "node": "mediamtx-0", "name": name}
        return {
            "ranges": [
                {"start": "2026-07-09T10:00:00Z", "duration": 60.0},
                {"start": "2026-07-09T10:05:00Z", "duration": 30.0},
            ],
            "playback_url": (
                f"http://localhost/media/playback/get?path={name}"
                "&start=2026-07-09T10:00:00Z&duration=600&format=fmp4"
            ),
            "node": "mediamtx-0",
            "name": name,
        }


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
        id=str(uuid.uuid4()),
        tenant_id=TENANT,
        name="Cam A",
        connection_type="rtsp",
    )
    db.add(cam)
    await db.commit()
    return cam


async def _add_recording(db, camera_id, start, end, *, profile="main", tenant=TENANT):
    rec = Recording(
        tenant_id=tenant,
        camera_id=camera_id,
        profile=profile,
        path=f"/recordings/cameras/{tenant}/{camera_id}/{profile}/{start.isoformat()}.mp4",
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


def _svc(db, stub, tenant=TENANT):
    svc = PlaybackService(db, _scope(tenant), bearer="fake.jwt")
    svc.nvr = stub
    return svc


# ── issue recorded playback ────────────────────────────────────────────────


async def test_start_playback_issues_recorded_session(db, camera):
    await _add_recording(db, camera.id, _dt(10, 0), _dt(10, 1))
    stub = _StubNvr()
    out = await _svc(db, stub).start_playback(
        camera.id, _dt(9, 0), _dt(11, 0), "main", actor=_Actor()
    )

    # nvr was asked for the playback URL over the window.
    assert stub.calls and stub.calls[0]["profile"] == "main"
    # Recorded session carries the token on the playback URL + the ranges.
    assert out.kind == "recorded"
    # The /get URL already carries ?path=…, so the token is appended as &token=.
    assert "token=" in out.hls_url and "/media/playback/get" in out.hls_url
    assert out.token and len(out.ranges) == 2
    assert out.from_ == _dt(9, 0) and out.to == _dt(11, 0)

    # The token is a media token in playback MODE, bound to this session + camera.
    claims = media_token.verify_media_token(out.token)
    assert claims["sub_type"] == "media"
    assert claims["mode"] == "playback"
    assert claims["camera_id"] == camera.id
    assert claims["session_id"] == out.session_id


async def test_start_playback_persists_recorded_row_with_window(db, camera):
    await _add_recording(db, camera.id, _dt(10, 0), _dt(10, 1))
    out = await _svc(db, _StubNvr()).start_playback(
        camera.id, _dt(9, 0), _dt(11, 0), "main", actor=_Actor()
    )
    from app.vms.models import PlaybackSession

    row = await db.get(PlaybackSession, out.session_id)
    assert row is not None
    assert row.kind == "recorded"
    assert row.window_from is not None and row.window_to is not None
    # Only the token HASH is at rest, never the raw token.
    assert row.token_hash == media_token.token_hash(out.token)
    assert out.token not in (row.token_hash or "")


async def test_start_playback_no_recordings_is_404(db, camera):
    # No Recording rows in the window → clean 404, never 500 (and nvr NOT called).
    stub = _StubNvr()
    with pytest.raises(PlaybackNotFound):
        await _svc(db, stub).start_playback(
            camera.id, _dt(9, 0), _dt(11, 0), "main", actor=_Actor()
        )
    assert stub.calls == []


async def test_start_playback_nvr_reports_no_segments_is_404(db, camera):
    # Recording rows exist but MediaMTX playback has no segments (empty URL) → 404.
    await _add_recording(db, camera.id, _dt(10, 0), _dt(10, 1))
    with pytest.raises(PlaybackNotFound):
        await _svc(db, _StubNvr(empty=True)).start_playback(
            camera.id, _dt(9, 0), _dt(11, 0), "main", actor=_Actor()
        )


async def test_start_playback_nvr_down_is_502(db, camera):
    await _add_recording(db, camera.id, _dt(10, 0), _dt(10, 1))
    with pytest.raises(PlaybackUpstreamError) as ei:
        await _svc(db, _StubNvr(fail=True)).start_playback(
            camera.id, _dt(9, 0), _dt(11, 0), "main", actor=_Actor()
        )
    assert ei.value.status_code == 502


async def test_start_playback_empty_window_is_404(db, camera):
    with pytest.raises(PlaybackNotFound):
        await _svc(db, _StubNvr()).start_playback(
            camera.id, _dt(10, 0), _dt(10, 0), "main", actor=_Actor()
        )


async def test_start_playback_tenant_isolation(db, camera):
    await _add_recording(db, camera.id, _dt(10, 0), _dt(10, 1))
    with pytest.raises(NotFoundError):
        await _svc(db, _StubNvr(), tenant=OTHER_TENANT).start_playback(
            camera.id, _dt(9, 0), _dt(11, 0), "main", actor=_Actor()
        )


# ── timeline coverage + gaps ────────────────────────────────────────────────


async def test_timeline_merges_contiguous_coverage(db, camera):
    # Two touching segments (10:00-10:01, 10:01-10:02) merge into one coverage block.
    await _add_recording(db, camera.id, _dt(10, 0), _dt(10, 1))
    await _add_recording(db, camera.id, _dt(10, 1), _dt(10, 2))
    # A separate segment later → a gap between them.
    await _add_recording(db, camera.id, _dt(10, 5), _dt(10, 6))

    tl = await _svc(db, _StubNvr()).timeline(camera.id, _dt(10, 0), _dt(10, 10))

    # Coverage: [10:00-10:02] (merged) + [10:05-10:06].
    assert len(tl.coverage) == 2
    assert tl.coverage[0].start == _dt(10, 0) and tl.coverage[0].end == _dt(10, 2)
    assert tl.coverage[1].start == _dt(10, 5) and tl.coverage[1].end == _dt(10, 6)
    # total = 120s + 60s.
    assert tl.total_seconds == 180.0
    # Gaps: [10:02-10:05] and the tail [10:06-10:10].
    assert len(tl.gaps) == 2
    assert tl.gaps[0].start == _dt(10, 2) and tl.gaps[0].end == _dt(10, 5)
    assert tl.gaps[1].start == _dt(10, 6) and tl.gaps[1].end == _dt(10, 10)


async def test_timeline_clamps_to_window(db, camera):
    # A segment overhanging both ends is clamped to [from, to].
    await _add_recording(db, camera.id, _dt(9, 0), _dt(12, 0))
    tl = await _svc(db, _StubNvr()).timeline(camera.id, _dt(10, 0), _dt(11, 0))
    assert len(tl.coverage) == 1
    assert tl.coverage[0].start == _dt(10, 0) and tl.coverage[0].end == _dt(11, 0)
    assert tl.total_seconds == 3600.0
    assert tl.gaps == []


async def test_timeline_empty_is_all_gap(db, camera):
    tl = await _svc(db, _StubNvr()).timeline(camera.id, _dt(10, 0), _dt(11, 0))
    assert tl.coverage == []
    assert len(tl.gaps) == 1
    assert tl.gaps[0].start == _dt(10, 0) and tl.gaps[0].end == _dt(11, 0)
    assert tl.total_seconds == 0.0


async def test_timeline_open_segment_runs_to_window_end(db, camera):
    # A still-open segment (no end_time) covers to the window end.
    await _add_recording(db, camera.id, _dt(10, 30), None)
    tl = await _svc(db, _StubNvr()).timeline(camera.id, _dt(10, 0), _dt(11, 0))
    assert len(tl.coverage) == 1
    assert tl.coverage[0].start == _dt(10, 30) and tl.coverage[0].end == _dt(11, 0)


def test_day_window():
    start, end = day_window(datetime(2026, 7, 9))
    assert start == _dt(0, 0) and end == datetime(2026, 7, 10, tzinfo=timezone.utc)


# ── timeline event markers (P5-B) ───────────────────────────────────────────


async def _add_event(db, camera_id, occurred, *, event_type="motion", severity="alarm",
                     tenant=TENANT):
    ev = VmsEvent(
        tenant_id=tenant,
        camera_id=camera_id,
        event_type=event_type,
        severity=severity,
        source="onvif",
        title=f"{event_type} event",
        dedup_key=uuid.uuid4().hex,
        occurred_at=occurred,
        published=True,
    )
    db.add(ev)
    await db.commit()
    return ev


async def test_timeline_includes_event_markers_in_window(db, camera):
    # Two in-window events + one outside → only the in-window two are markers.
    await _add_event(db, camera.id, _dt(10, 15), event_type="motion", severity="alarm")
    await _add_event(db, camera.id, _dt(10, 45), event_type="tamper", severity="critical")
    await _add_event(db, camera.id, _dt(12, 0), event_type="motion")  # outside [10,11]

    tl = await _svc(db, _StubNvr()).timeline(camera.id, _dt(10, 0), _dt(11, 0))

    assert len(tl.markers) == 2
    # Ordered by time; carry type/severity/event_id for the scrub bar.
    assert tl.markers[0].t == _dt(10, 15)
    assert tl.markers[0].event_type == "motion" and tl.markers[0].severity == "alarm"
    assert tl.markers[0].event_id
    assert tl.markers[1].event_type == "tamper" and tl.markers[1].severity == "critical"
    # Coverage/gaps are unaffected by markers (kept as-is).
    assert tl.coverage == []


async def test_timeline_markers_tenant_scoped(db, camera):
    # A marker owned by another tenant is not surfaced to this tenant.
    await _add_event(db, camera.id, _dt(10, 15), tenant=OTHER_TENANT)
    tl = await _svc(db, _StubNvr()).timeline(camera.id, _dt(10, 0), _dt(11, 0))
    assert tl.markers == []
