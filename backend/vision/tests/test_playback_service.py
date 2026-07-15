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
from kernel.errors import ValidationError

from app.vms.playback.service import (
    PlaybackNotFound,
    PlaybackService,
    PlaybackUpstreamError,
    day_window,
    parse_month_window,
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


async def _add_recording(
    db, camera_id, start, end, *, profile="main", tenant=TENANT, trigger="continuous"
):
    rec = Recording(
        tenant_id=tenant,
        camera_id=camera_id,
        profile=profile,
        path=(
            f"/recordings/cameras/{tenant}/{camera_id}/{profile}/"
            f"{trigger}-{start.isoformat()}.mp4"
        ),
        start_time=start,
        end_time=end,
        duration=((end - start).total_seconds() if end else None),
        trigger_type=trigger,
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


async def test_timeline_coverage_carries_trigger_type(db, camera):
    # Backward-compat + Task 2: a single continuous block still has start/end AND now
    # a trigger_type tag for the scrub-bar colouring.
    await _add_recording(db, camera.id, _dt(10, 0), _dt(10, 1), trigger="continuous")
    tl = await _svc(db, _StubNvr()).timeline(camera.id, _dt(10, 0), _dt(11, 0))
    assert len(tl.coverage) == 1
    assert tl.coverage[0].start == _dt(10, 0) and tl.coverage[0].end == _dt(10, 1)
    assert tl.coverage[0].trigger_type == "continuous"
    # Gaps carry no trigger (None) — only coverage is typed.
    assert all(g.trigger_type is None for g in tl.gaps)


async def test_timeline_different_triggers_stay_separate_spans(db, camera):
    # Continuous then a motion clip (disjoint in time) → two differently-typed spans,
    # NOT one merged block (the whole point of Task 2).
    await _add_recording(db, camera.id, _dt(10, 0), _dt(10, 1), trigger="continuous")
    await _add_recording(db, camera.id, _dt(10, 2), _dt(10, 3), trigger="motion")

    tl = await _svc(db, _StubNvr()).timeline(camera.id, _dt(10, 0), _dt(10, 10))

    assert len(tl.coverage) == 2
    # Sorted by start: continuous first, motion second.
    assert tl.coverage[0].trigger_type == "continuous"
    assert tl.coverage[0].start == _dt(10, 0) and tl.coverage[0].end == _dt(10, 1)
    assert tl.coverage[1].trigger_type == "motion"
    assert tl.coverage[1].start == _dt(10, 2) and tl.coverage[1].end == _dt(10, 3)


async def test_timeline_adjacent_same_trigger_still_merges(db, camera):
    # Two touching motion segments still coalesce into ONE motion span.
    await _add_recording(db, camera.id, _dt(10, 0), _dt(10, 1), trigger="motion")
    await _add_recording(db, camera.id, _dt(10, 1), _dt(10, 2), trigger="motion")

    tl = await _svc(db, _StubNvr()).timeline(camera.id, _dt(10, 0), _dt(10, 10))

    assert len(tl.coverage) == 1
    assert tl.coverage[0].start == _dt(10, 0) and tl.coverage[0].end == _dt(10, 2)
    assert tl.coverage[0].trigger_type == "motion"


async def test_timeline_adjacent_different_triggers_do_not_merge(db, camera):
    # Touching but different-typed segments (continuous 10:00-10:01, motion 10:01-10:02)
    # must NOT merge — different trigger starts a new span even when touching.
    await _add_recording(db, camera.id, _dt(10, 0), _dt(10, 1), trigger="continuous")
    await _add_recording(db, camera.id, _dt(10, 1), _dt(10, 2), trigger="motion")

    tl = await _svc(db, _StubNvr()).timeline(camera.id, _dt(10, 0), _dt(10, 10))

    assert len(tl.coverage) == 2
    assert tl.coverage[0].trigger_type == "continuous"
    assert tl.coverage[1].trigger_type == "motion"
    # No phantom gap between them (they touch); only the tail gap remains.
    assert len(tl.gaps) == 1
    assert tl.gaps[0].start == _dt(10, 2) and tl.gaps[0].end == _dt(10, 10)


async def test_timeline_overlapping_different_triggers_kept_separate(db, camera):
    # Overlap rule: a motion clip (10:20-10:40) inside a continuous block (10:00-11:00)
    # is kept as a SEPARATE typed span (lossless) — NOT clipped/merged. Union of spans
    # covers [10:00-11:00] so there is NO phantom gap despite the overlap.
    await _add_recording(db, camera.id, _dt(10, 0), _dt(11, 0), trigger="continuous")
    await _add_recording(db, camera.id, _dt(10, 20), _dt(10, 40), trigger="motion")

    tl = await _svc(db, _StubNvr()).timeline(camera.id, _dt(10, 0), _dt(11, 0))

    assert len(tl.coverage) == 2
    # Sorted by start: the continuous span (10:00) precedes the motion span (10:20).
    assert tl.coverage[0].trigger_type == "continuous"
    assert tl.coverage[0].start == _dt(10, 0) and tl.coverage[0].end == _dt(11, 0)
    assert tl.coverage[1].trigger_type == "motion"
    assert tl.coverage[1].start == _dt(10, 20) and tl.coverage[1].end == _dt(10, 40)
    # No phantom gap from the overlap — the union fully covers the window.
    assert tl.gaps == []
    # total counts BOTH spans (continuous 3600s + motion 1200s) — the separate-spans model.
    assert tl.total_seconds == 3600.0 + 1200.0


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


# ── recording-days calendar (Task 1) ────────────────────────────────────────


def _dtd(day, h=0, m=0):
    """A UTC datetime on a given day-of-July-2026 (recording-days tests span days)."""
    return datetime(2026, 7, day, h, m, tzinfo=timezone.utc)


async def test_recording_days_buckets_distinct_local_days(db, camera):
    # Footage on the 14th and 16th (UTC), 15th empty → days {14, 16} in UTC (tz=0).
    await _add_recording(db, camera.id, _dtd(14, 8), _dtd(14, 9))
    await _add_recording(db, camera.id, _dtd(14, 20), _dtd(14, 21))  # same day, deduped
    await _add_recording(db, camera.id, _dtd(16, 1), _dtd(16, 2))
    out = await _svc(db, _StubNvr()).recording_days_camera(camera.id, "2026-07", 0)
    assert out.year == 2026 and out.month == 7
    assert out.days == [14, 16]


async def test_recording_days_segment_spanning_midnight_marks_both(db, camera):
    # A segment 23:30 on the 14th → 00:30 on the 15th (UTC) marks BOTH days.
    await _add_recording(db, camera.id, _dtd(14, 23, 30), _dtd(15, 0, 30))
    out = await _svc(db, _StubNvr()).recording_days_camera(camera.id, "2026-07", 0)
    assert out.days == [14, 15]


async def test_recording_days_tz_shift_moves_day(db, camera):
    # 23:00Z on the 14th is 04:30 on the 15th in IST (+330) → day 15, not 14.
    await _add_recording(db, camera.id, _dtd(14, 23, 0), _dtd(14, 23, 30))
    out = await _svc(db, _StubNvr()).recording_days_camera(camera.id, "2026-07", 330)
    assert out.days == [15]


async def test_recording_days_prev_month_utc_counts_as_day1_local(db, camera):
    # 20:00Z on Jun-30 is 01:30 on Jul-1 in IST → shows as day 1 of July.
    await _add_recording(
        db,
        camera.id,
        datetime(2026, 6, 30, 20, 0, tzinfo=timezone.utc),
        datetime(2026, 6, 30, 20, 30, tzinfo=timezone.utc),
    )
    out = await _svc(db, _StubNvr()).recording_days_camera(camera.id, "2026-07", 330)
    assert out.days == [1]


async def test_recording_days_open_segment_runs_to_now_window(db, camera):
    # An open segment (no end) still marks its start day (clamped to the window).
    await _add_recording(db, camera.id, _dtd(20, 10), None)
    out = await _svc(db, _StubNvr()).recording_days_camera(camera.id, "2026-07", 0)
    assert 20 in out.days


async def test_recording_days_empty_month_is_empty_list(db, camera):
    out = await _svc(db, _StubNvr()).recording_days_camera(camera.id, "2026-07", 0)
    assert out.days == []


async def test_recording_days_tenant_isolation(db, camera):
    await _add_recording(db, camera.id, _dtd(14, 8), _dtd(14, 9))
    with pytest.raises(NotFoundError):
        await _svc(db, _StubNvr(), tenant=OTHER_TENANT).recording_days_camera(
            camera.id, "2026-07", 0
        )


@pytest.mark.parametrize("bad", ["2026", "2026-13", "2026-00", "07-2026", "not-a-month", ""])
async def test_recording_days_bad_month_raises(db, camera, bad):
    with pytest.raises(ValidationError):
        await _svc(db, _StubNvr()).recording_days_camera(camera.id, bad, 0)


def test_parse_month_window_december_wraps_year():
    year, mon, win_from, win_to = parse_month_window("2026-12", 0)
    assert (year, mon) == (2026, 12)
    assert win_from == datetime(2026, 12, 1, tzinfo=timezone.utc)
    assert win_to == datetime(2027, 1, 1, tzinfo=timezone.utc)


def test_parse_month_window_tz_shifts_utc_window():
    # IST month window starts 5:30 BEFORE UTC midnight of the 1st.
    _, _, win_from, win_to = parse_month_window("2026-07", 330)
    assert win_from == datetime(2026, 6, 30, 18, 30, tzinfo=timezone.utc)
    assert win_to == datetime(2026, 7, 31, 18, 30, tzinfo=timezone.utc)
