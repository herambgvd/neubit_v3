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
from kernel.errors import AppError, NotFoundError

from app.vms.common.media_token import mint_media_token, token_hash
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
        self.nvr = NvrClient(bearer=bearer)

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

        from_iso = from_.astimezone(timezone.utc).isoformat()
        to_iso = to.astimezone(timezone.utc).isoformat()
        try:
            pb = await self.nvr.playback_list(
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

    # ── timeline (scrub-bar coverage + gaps) ────────────────────────────
    async def timeline(
        self, camera_id: str, from_: datetime, to: datetime, profile: str | None = None
    ):
        """Coverage blocks + gaps + event markers for the scrub bar.

        Recording [start, end] intervals are clamped to [from, to], merged into
        contiguous coverage blocks (touching/overlapping segments coalesce), and the
        holes between them within the window become gaps. Event MARKERS (P5-B) are the
        VmsEvent rows whose ``occurred_at`` falls in [from, to] — a tick per device/system
        event so the scrub bar shows motion/tamper/… where they happened.
        """
        camera = await self._camera(camera_id)
        recs = await self._recordings_in_window(camera.id, from_, to, profile)
        markers = await self._event_markers(camera.id, from_, to)

        # Build clamped [start, end] intervals (skip zero/negative after clamping).
        intervals: list[tuple[datetime, datetime]] = []
        for r in recs:
            rs = _aware(r.start_time)
            # Open segment (no end) is treated as running to the window end.
            re = _aware(r.end_time) or to
            s = max(rs, from_)
            e = min(re, to)
            if e > s:
                intervals.append((s, e))

        intervals.sort(key=lambda iv: iv[0])
        coverage: list[tuple[datetime, datetime]] = []
        for s, e in intervals:
            if coverage and s <= coverage[-1][1]:
                # Overlaps/touches the last block → extend it.
                if e > coverage[-1][1]:
                    coverage[-1] = (coverage[-1][0], e)
            else:
                coverage.append((s, e))

        # Gaps: the holes between coverage blocks within [from, to].
        gaps: list[tuple[datetime, datetime]] = []
        cursor = from_
        for s, e in coverage:
            if s > cursor:
                gaps.append((cursor, s))
            cursor = max(cursor, e)
        if cursor < to:
            gaps.append((cursor, to))

        total = sum((e - s).total_seconds() for s, e in coverage)

        from .schemas import TimelineMarker, TimelineResponse, TimelineSegment

        return TimelineResponse(
            camera_id=camera.id,
            from_=from_,
            to=to,
            coverage=[TimelineSegment(start=s, end=e) for s, e in coverage],
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
