"""Recorded-playback control-plane service (P4-A) — tenant-scoped.

Issues recorded ``PlaybackSession`` rows (``kind="recorded"``) and computes the
scrub-bar timeline from ``Recording`` rows. The data-plane URL (MediaMTX playback
server ``/get``) is resolved by the Go ``nvr``; vision verifies the camera + that
recordings exist in the window, mints a **media token** (``mode:playback``, reusing
``vms.common.media_token``), and returns the token-carrying playback HLS URL.

Discipline mirrors the live/recording services:
  * every read/by-id goes through ``kernel.auth.assert_owned`` / ``scoped``; new rows
    are stamped with the caller's ``tenant_id``.
  * GRACEFUL: a window with no recordings → ``PlaybackNotFound`` (404); a down nvr /
    MediaMTX playback server → a clean 502 (``PlaybackUpstreamError``), never a 500.

The media token is stateless; the session row stores only its HASH — same as live.
The playback token (``mode:playback``) is a normal media token, so the P2-B
``/media/verify`` ForwardAuth accepts it identically (no verify change needed).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import AppError, NotFoundError, ValidationError

from app.vms.common.media_token import mint_media_token, token_hash
from app.vms.common.node_routing import node_base_for_camera, node_base_for_id
from app.vms.common.nvr_client import NvrClient, NvrUnavailable
from app.vms.live.service import _append_token
from app.vms.models import Camera, PlaybackSession, Recording, VmsEvent

log = logging.getLogger("vision.playback_service")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


def _aware(dt: datetime | None) -> datetime | None:
    """Coerce a possibly-naive datetime to aware-UTC (SQLite read-back is naive)."""
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


class PlaybackUpstreamError(AppError):
    """nvr down / MediaMTX playback server unreachable → a clean 502 (never 500)."""

    code = "MEDIA_UPSTREAM"
    status_code = 502


class PlaybackNotFound(NotFoundError):
    """No recordings in the requested window → 404 (clean empty, not an error state)."""


class PlaybackService:
    """Tenant-scoped recorded-playback issuer + timeline over ``recordings``."""

    def __init__(self, db: AsyncSession, scope: Scope, *, bearer: str | None = None) -> None:
        self.db = db
        self.scope = scope
        self.bearer = bearer
        self.nvr = NvrClient(bearer=bearer)

    async def _nvr_for(self, camera_or_id) -> NvrClient:
        """An ``NvrClient`` bound to THIS camera's recorder-node base URL (MN-1b).

        Unassigned camera / missing node → ``base_url=None`` → we return the shared
        ``self.nvr`` (global ``VE_NVR_URL``) UNCHANGED — single-node deployments byte-
        identical (and preserves ``self.nvr = stub`` test injection)."""
        base = await node_base_for_camera(self.db, self.scope.tenant_id, camera_or_id)
        if base is None:
            return self.nvr
        return NvrClient(bearer=self.bearer, base_url=base)

    async def _nvr_for_recording(self, camera, recording) -> NvrClient:
        """An ``NvrClient`` bound to the node that HOLDS this recording's footage.

        Routes by the RECORDING's ``media_node_id`` (the machine the file lives on) so old
        footage stays reachable after the camera is reassigned to a different recorder.
        FALLBACK — a recording with NULL ``media_node_id`` (pre-locality / single-node) or
        an unresolvable node → ``_nvr_for(camera)`` (camera's current node / global
        ``VE_NVR_URL``), i.e. exactly the previous behaviour."""
        node_id = getattr(recording, "media_node_id", None)
        base = await node_base_for_id(self.db, self.scope.tenant_id, node_id)
        if base is None:
            return await self._nvr_for(camera)
        return NvrClient(bearer=self.bearer, base_url=base)

    # ── row helpers ─────────────────────────────────────────────────────
    async def _camera(self, camera_id: str) -> Camera:
        row = await self.db.get(Camera, camera_id)
        assert_owned(row, self.scope, message="camera not found")
        return row

    async def _recordings_in_window(
        self, camera_id: str, from_: datetime, to: datetime, profile: str | None = None
    ) -> list[Recording]:
        """Recording rows whose [start_time, end_time] OVERLAPS [from, to], scoped.

        A recording overlaps when start_time < to AND (end_time IS NULL OR end_time >
        from). A NULL end_time (still-open segment) is treated as overlapping.
        """
        stmt = (
            scoped(select(Recording), Recording, self.scope)
            .where(Recording.camera_id == camera_id)
            .where(Recording.start_time < to)
            .where(
                (Recording.end_time.is_(None)) | (Recording.end_time > from_)
            )
        )
        if profile:
            stmt = stmt.where(Recording.profile == profile)
        rows = list(
            (await self.db.execute(stmt.order_by(Recording.start_time.asc())))
            .scalars()
            .all()
        )
        return rows

    # ── start recorded playback ─────────────────────────────────────────
    async def start_playback(
        self, camera_id: str, from_: datetime, to: datetime, profile: str, *, actor
    ):
        """Verify camera + recordings-in-window → nvr playback URL → mint token → persist."""
        if to <= from_:
            raise PlaybackNotFound("empty playback window (to must be after from)")
        camera = await self._camera(camera_id)

        # Must have recordings in the window, else there is nothing to play (404).
        recs = await self._recordings_in_window(camera.id, from_, to, profile)
        if not recs:
            raise PlaybackNotFound("no recordings in the requested window")

        # Footage locality: route to the node that HOLDS the footage, not the camera's
        # CURRENT node. ``recs`` are ordered start_time.asc(), so ``recs[0]`` covers the
        # START of the window — the segment the playback begins on. We resolve its
        # ``media_node_id`` to the recorder base URL. FALLBACK: if that recording predates
        # locality (media_node_id NULL) or the node can't be resolved, use the camera's
        # current node / global VE_NVR_URL (``_nvr_for``) — single-node byte-identical.
        #
        # Playback sessions are TIME-KEYED: a seek starts a fresh start_playback with a new
        # window, so each seek re-resolves the node from the recording at its new start.
        # Seeking across a node boundary therefore naturally re-targets the correct
        # machine — no cross-node merge is needed within one session.
        nvr = await self._nvr_for_recording(camera, recs[0])

        from_iso = from_.astimezone(timezone.utc).isoformat()
        to_iso = to.astimezone(timezone.utc).isoformat()
        try:
            pb = await nvr.playback_list(
                camera_id=camera.id, profile=profile, from_=from_iso, to=to_iso
            )
        except NvrUnavailable as exc:
            raise PlaybackUpstreamError(exc.message) from exc

        playback_url = pb.get("playback_url")
        node = pb.get("node")
        name = pb.get("name")
        ranges = pb.get("ranges") or []
        if not playback_url:
            # nvr found the node but MediaMTX reports no recorded ranges → 404.
            raise PlaybackNotFound("no recorded segments available for playback")

        tenant_str = str(self.scope.tenant_id) if self.scope.tenant_id else None
        row = PlaybackSession(
            tenant_id=self.scope.tenant_id,
            camera_id=camera.id,
            kind="recorded",
            profile=profile,
            mediamtx_name=name,
            node=node,
            hls_url=playback_url,
            window_from=from_,
            window_to=to,
            created_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.flush()  # assign row.id for the token claim

        token, exp = mint_media_token(
            tenant_id=tenant_str,
            camera_id=camera.id,
            session_id=row.id,
            mode="playback",
            # Bounded review session — long TTL avoids the HLS variant/segment 401 when
            # the default 5-min token expires mid-view (baked into the master playlist).
            ttl_seconds=6 * 3600,
        )
        row.token_hash = token_hash(token)
        row.expires_at = datetime.fromtimestamp(exp, tz=timezone.utc)
        await self.db.commit()
        await self.db.refresh(row)

        from .schemas import PlaybackRange, RecordedPlaybackPublic

        return RecordedPlaybackPublic(
            session_id=row.id,
            camera_id=row.camera_id,
            kind="recorded",
            profile=row.profile,
            hls_url=_append_token(row.hls_url, token),
            token=token,
            from_=from_,
            to=to,
            ranges=[
                PlaybackRange(start=rg["start"], duration=rg.get("duration", 0.0))
                for rg in ranges
                if rg.get("start")
            ],
            expires_at=row.expires_at,
        )

    # ── recording-days calendar (which days of a month have footage) ────
    async def recording_days_camera(
        self, camera_id: str, month: str, tz_offset_minutes: int
    ):
        """Days of ``month`` (YYYY-MM) that have recorded footage for a camera, LOCAL tz.

        Resolves the UTC window that spans the month IN THE OPERATOR'S TZ, fetches the
        overlapping Recording rows (tenant-scoped), and buckets each recording's LOCAL
        coverage into day-of-month ints. A segment spanning local midnight marks BOTH
        days; the set is clamped to the month + returned sorted+unique.
        """
        year, mon, win_from, win_to = parse_month_window(month, tz_offset_minutes)
        # Ownership (+ tenant scope) enforced identically to timeline/playback.
        camera = await self._camera(camera_id)
        recs = await self._recordings_in_window(camera.id, win_from, win_to)

        tz = timezone(timedelta(minutes=tz_offset_minutes))
        days: set[int] = set()
        for r in recs:
            rs = _aware(r.start_time)
            # Open segment (no end) is treated as running to the window end.
            re = _aware(r.end_time) or win_to
            _mark_local_days(rs, re, win_from, win_to, tz, year, mon, days)

        from .schemas import RecordingDaysResponse

        return RecordingDaysResponse(year=year, month=mon, days=sorted(days))

    # ── timeline (scrub-bar coverage + gaps) ────────────────────────────
    async def timeline(
        self, camera_id: str, from_: datetime, to: datetime, profile: str | None = None
    ):
        """Coverage blocks + gaps + event markers for the scrub bar.

        Recording [start, end] intervals are clamped to [from, to] and merged into
        coverage blocks — but merging is now grouped BY ``trigger_type`` (Task 2): only
        touching/overlapping segments of the SAME trigger coalesce, so a camera that
        recorded continuous then a motion clip yields two differently-typed spans (the
        scrub bar colours bars by type, CTOCAM/Lumina-style) rather than one merged
        block. Each coverage span carries its ``trigger_type``; spans are sorted by
        start. The holes between coverage (across ALL types) within the window become
        gaps. Event MARKERS (P5-B) are the VmsEvent rows whose ``occurred_at`` falls in
        [from, to] — a tick per device/system event so the scrub bar shows
        motion/tamper/… where they happened.

        Overlap rule: if two DIFFERENT-typed spans overlap in time (e.g. a motion clip
        recorded inside a continuous block), they are kept as SEPARATE typed spans — the
        frontend layers/prioritises them. We do NOT clip or merge across types here (the
        simpler, lossless choice); gaps are computed from the union of all spans so an
        overlap never produces a phantom gap.
        """
        camera = await self._camera(camera_id)
        recs = await self._recordings_in_window(camera.id, from_, to, profile)
        markers = await self._event_markers(camera.id, from_, to)

        # Build clamped [start, end, trigger] intervals (skip zero/negative after clamp).
        intervals: list[tuple[datetime, datetime, str]] = []
        for r in recs:
            rs = _aware(r.start_time)
            # Open segment (no end) is treated as running to the window end.
            re = _aware(r.end_time) or to
            s = max(rs, from_)
            e = min(re, to)
            if e > s:
                intervals.append((s, e, r.trigger_type))

        # Merge WITHIN each trigger group: touching/overlapping same-type segments
        # coalesce; a different trigger never extends another's block.
        by_trigger: dict[str, list[tuple[datetime, datetime]]] = {}
        for s, e, trig in sorted(intervals, key=lambda iv: iv[0]):
            blocks = by_trigger.setdefault(trig, [])
            if blocks and s <= blocks[-1][1]:
                if e > blocks[-1][1]:
                    blocks[-1] = (blocks[-1][0], e)
            else:
                blocks.append((s, e))

        # Flatten to typed spans, sorted by start (stable within equal starts).
        coverage: list[tuple[datetime, datetime, str]] = sorted(
            ((s, e, trig) for trig, blocks in by_trigger.items() for s, e in blocks),
            key=lambda sp: sp[0],
        )

        # Gaps: the holes between coverage within [from, to], computed from the UNION
        # of all typed spans (overlaps across types must not create a phantom gap).
        union = sorted(((s, e) for s, e, _ in coverage), key=lambda iv: iv[0])
        gaps: list[tuple[datetime, datetime]] = []
        cursor = from_
        for s, e in union:
            if s > cursor:
                gaps.append((cursor, s))
            cursor = max(cursor, e)
        if cursor < to:
            gaps.append((cursor, to))

        # total_seconds = summed recorded duration; a same-window overlap (continuous +
        # motion) counts both spans' seconds, matching the "separate spans" model.
        total = sum((e - s).total_seconds() for s, e, _ in coverage)

        from .schemas import TimelineMarker, TimelineResponse, TimelineSegment

        return TimelineResponse(
            camera_id=camera.id,
            from_=from_,
            to=to,
            coverage=[
                TimelineSegment(start=s, end=e, trigger_type=trig)
                for s, e, trig in coverage
            ],
            gaps=[TimelineSegment(start=s, end=e) for s, e in gaps],
            markers=[
                TimelineMarker(
                    t=_aware(m.occurred_at),
                    event_type=m.event_type,
                    severity=m.severity,
                    event_id=m.id,
                    camera_id=m.camera_id,
                )
                for m in markers
            ],
            total_seconds=total,
        )

    async def _event_markers(
        self, camera_id: str, from_: datetime, to: datetime
    ) -> list[VmsEvent]:
        """VmsEvent rows for the camera whose ``occurred_at`` is within [from, to].

        Tenant-scoped (``scoped``) — a marker is only surfaced to the owning tenant, the
        same isolation the events feed enforces. Ordered by time for a stable scrub bar.
        """
        stmt = (
            scoped(select(VmsEvent), VmsEvent, self.scope)
            .where(VmsEvent.camera_id == camera_id)
            .where(VmsEvent.occurred_at >= from_)
            .where(VmsEvent.occurred_at <= to)
            .order_by(VmsEvent.occurred_at.asc())
        )
        return list((await self.db.execute(stmt)).scalars().all())


def day_window(day: datetime) -> tuple[datetime, datetime]:
    """Return the [00:00, 24:00) UTC window for a given day (date part only)."""
    start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    return start, start + timedelta(days=1)


def parse_month_window(
    month: str, tz_offset_minutes: int
) -> tuple[int, int, datetime, datetime]:
    """Validate ``YYYY-MM`` + return ``(year, month, win_from_utc, win_to_utc)``.

    The window is the [month-start 00:00, next-month-start 00:00) span IN THE OPERATOR'S
    LOCAL tz, expressed in UTC — so a recording at 23:00Z on the last day of the prior
    month (which is day 1 locally for +ve offsets) is correctly pulled in. Raises
    ``ValidationError`` (bad format / out-of-range) so the router surfaces a 4xx, not 500.
    """
    try:
        year_s, mon_s = month.split("-")
        year, mon = int(year_s), int(mon_s)
    except (ValueError, AttributeError) as exc:
        raise ValidationError("invalid 'month' — expected YYYY-MM") from exc
    if len(mon_s) != 2 or not (1 <= mon <= 12) or year < 1970 or year > 9999:
        raise ValidationError("invalid 'month' — expected YYYY-MM")

    tz = timezone(timedelta(minutes=tz_offset_minutes))
    local_start = datetime(year, mon, 1, tzinfo=tz)
    # First day of the NEXT month (December wraps to January of the next year).
    if mon == 12:
        local_end = datetime(year + 1, 1, 1, tzinfo=tz)
    else:
        local_end = datetime(year, mon + 1, 1, tzinfo=tz)
    return year, mon, local_start.astimezone(timezone.utc), local_end.astimezone(timezone.utc)


def _mark_local_days(
    start: datetime,
    end: datetime,
    win_from: datetime,
    win_to: datetime,
    tz: timezone,
    year: int,
    month: int,
    out: set[int],
) -> None:
    """Add every LOCAL day-of-month a recording [start, end] covers, clamped to the window.

    Clamps [start, end] to the month window, converts to the operator's tz, then walks
    each covered local calendar day (a range spanning midnight marks both). Only days
    whose (year, month) match the requested month are added — a segment straddling the
    month boundary contributes only its in-month days.
    """
    s = max(start, win_from)
    e = min(end, win_to)
    if e <= s:
        return
    ls = s.astimezone(tz)
    # ``win_to`` is exclusive (next-month 00:00 local); a segment ending exactly there
    # covers up to but not including that day, so step back one microsecond for the
    # last-covered day (avoids marking day-1 of the following month).
    le = (e - timedelta(microseconds=1)).astimezone(tz)
    cursor = ls.date()
    last = le.date()
    while cursor <= last:
        if cursor.year == year and cursor.month == month:
            out.add(cursor.day)
        cursor += timedelta(days=1)
