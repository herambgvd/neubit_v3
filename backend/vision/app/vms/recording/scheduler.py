"""Recording scheduler (P3-A) — weekly-window → nvr start/stop.

For every camera in ``recording_mode='schedule'``, this periodic task evaluates the
weekly schedule against the current wall-clock; as a window OPENS it calls the Go
``nvr`` to start recording, and as it CLOSES it stops. It runs estate-wide (all
tenants) in ``app.main`` lifespan (like the health sampler), owns its own DB
session per cycle, and only calls the nvr on a state TRANSITION (tracked in-memory)
so a window that stays open is not re-driven every tick.

Schedule shape (``Camera.recording_schedule``)::

    {"mon": [{"start": "08:00", "end": "18:00"}], "tue": [...], ...}

Days are lower-case 3-letter keys (mon..sun); windows are HH:MM 24h. An overnight
window (end < start) wraps past midnight. Times compare against the server clock
(UTC by default) — documented; per-site timezones are a later refinement.

Graceful: an unreachable nvr / camera with no RTSP is logged + retried next tick —
it never crashes the loop. Motion/event modes are handled by P5, not here.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, time as dtime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.vms.common.node_routing import node_base_for_camera
from app.vms.common.nvr_client import NvrClient, NvrUnavailable
from app.vms.common.service_token import mint_service_token
from app.vms.models import Camera

log = logging.getLogger("vision.recording_scheduler")

_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def _interval_sec() -> int:
    try:
        return max(15, int(os.getenv("VE_RECORD_SCHEDULE_INTERVAL_SEC", "").strip() or 30))
    except (TypeError, ValueError):
        return 30


def _parse_hhmm(v: str) -> dtime | None:
    try:
        hh, mm = str(v).split(":", 1)
        return dtime(int(hh), int(mm))
    except (ValueError, TypeError):
        return None


def window_open(schedule: dict, now: datetime) -> bool:
    """True if ``now`` falls inside any weekly window in ``schedule``.

    Pure + testable. Handles overnight windows (end < start wraps midnight) by also
    checking the previous day's wrapping windows.
    """
    if not schedule:
        return False
    day = _DAYS[now.weekday()]
    prev_day = _DAYS[(now.weekday() - 1) % 7]
    cur = now.time()

    for w in schedule.get(day, []) or []:
        s = _parse_hhmm(w.get("start", ""))
        e = _parse_hhmm(w.get("end", ""))
        if s is None or e is None:
            continue
        if s <= e:
            if s <= cur < e:
                return True
        else:  # overnight window: [start, 24:00)
            if cur >= s:
                return True
    # Previous day's overnight window spilling into today: [00:00, end)
    for w in schedule.get(prev_day, []) or []:
        s = _parse_hhmm(w.get("start", ""))
        e = _parse_hhmm(w.get("end", ""))
        if s is None or e is None:
            continue
        if s > e and cur < e:
            return True
    return False


class RecordingScheduler:
    """Estate-wide weekly-schedule → nvr start/stop, on state transitions only."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker
        self._task: asyncio.Task | None = None
        self._running = False
        # camera_id → last-driven desired state (True=recording), so we only call
        # the nvr on a transition. Rebuilt lazily; a restart re-drives once (safe).
        self._state: dict[str, bool] = {}

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        log.info("recording scheduler started (interval=%ss)", _interval_sec())

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        log.info("recording scheduler stopped")

    async def _loop(self) -> None:
        try:
            await asyncio.sleep(min(8, _interval_sec()))
        except asyncio.CancelledError:
            return
        backoff = _interval_sec()
        while self._running:
            try:
                await self.run_cycle()
                backoff = _interval_sec()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — one bad cycle must not kill the loop
                backoff = min(backoff * 2, 300)
                log.warning("recording scheduler cycle error (%s) — backing off %ss", exc, backoff)
            try:
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                return

    async def run_cycle(self, *, now: datetime | None = None) -> int:
        """One pass: drive schedule-window transitions AND ensure continuous cameras
        are recording.

        Returns the number of cameras whose recording state was TOGGLED this cycle
        (handy for tests). ``now`` is injectable for deterministic tests.
        """
        now = now or datetime.now(timezone.utc)
        toggled = 0
        async with self._sessionmaker() as db:
            # ── schedule mode: open/close weekly windows on transition ──────────
            sched = (
                await db.execute(
                    select(Camera).where(
                        Camera.recording_mode == "schedule",
                        Camera.is_enabled.is_(True),
                    )
                )
            ).scalars().all()
            for cam in sched:
                desired = window_open(cam.recording_schedule or {}, now)
                prev = self._state.get(cam.id)
                if prev == desired:
                    continue
                if await self._drive(db, cam, desired):
                    self._state[cam.id] = desired
                    toggled += 1

            # ── continuous mode: ensure it's recording (self-healing) ───────────
            # Any camera set to continuous — via the recording tab, bulk, onboarding, or
            # channel map — should be recording without a separate click, and should
            # resume after an nvr restart. We start any continuous+enabled camera that
            # isn't already in the nvr's active recording set. Idempotent + best-effort.
            cont = (
                await db.execute(
                    select(Camera).where(
                        Camera.recording_mode == "continuous",
                        Camera.is_enabled.is_(True),
                    )
                )
            ).scalars().all()
            if cont:
                active = await self._active_camera_ids()
                for cam in cont:
                    if cam.id in active:
                        continue  # already recording
                    if await self._drive(db, cam, True):
                        toggled += 1
        return toggled

    async def _active_camera_ids(self) -> set[str]:
        """The set of camera_ids the nvr is actively recording (best-effort, all
        tenants). Empty set on an unreachable nvr → we simply (re)assert starts."""
        nvr = NvrClient(bearer=mint_service_token(tenant_id=None))
        try:
            targets = await nvr.recording_status()
        except NvrUnavailable:
            return set()
        return {str(t.get("camera_id")) for t in targets if t.get("camera_id")}

    async def _drive(self, db: AsyncSession, cam: Camera, on: bool) -> bool:
        """Call the nvr start/stop for a transition. Returns True on success.

        Best-effort: a down nvr / no-RTSP returns False (no state cached → retried
        next tick). Uses a minted service token scoped to the camera's tenant.
        """
        tenant = str(cam.tenant_id) if cam.tenant_id else None
        # MN-1b: route to THIS camera's assigned recorder node; unassigned cameras
        # resolve to None → NvrClient falls back to the global VE_NVR_URL (unchanged).
        # Only pass ``base_url`` when a node resolved, so the single-node path constructs
        # the client exactly as before (``NvrClient(bearer=...)``).
        base = await node_base_for_camera(db, cam.tenant_id, cam)
        token = mint_service_token(tenant_id=tenant)
        nvr = NvrClient(bearer=token, base_url=base) if base else NvrClient(bearer=token)
        profile = "sub" if cam.record_substream else "main"
        trigger = "continuous" if cam.recording_mode == "continuous" else "schedule"
        try:
            if on:
                rtsp = await _rtsp_for(db, cam, profile)
                if not rtsp:
                    log.info("scheduler: camera %s has no RTSP — skip open", cam.id)
                    return False
                record_dir = await _record_dir_for(db, cam)
                await nvr.start_recording(
                    camera_id=cam.id, profile=profile, rtsp_url=rtsp, trigger=trigger,
                    audio=bool(cam.audio_enabled), record_dir=record_dir,
                )
                log.info("scheduler: recording ON camera %s (%s)", cam.id, trigger)
            else:
                await nvr.stop_recording(camera_id=cam.id, profile=profile)
                log.info("scheduler: window CLOSE → stop camera %s", cam.id)
            return True
        except NvrUnavailable as exc:
            log.info("scheduler: nvr drive failed for %s (%s) — retry next tick", cam.id, exc)
            return False


async def _rtsp_for(db: AsyncSession, cam: Camera, profile: str) -> str | None:
    """Derive the camera RTSP source (reuses LiveService's logic, platform scope)."""
    from kernel.auth import Scope
    from app.vms.live.service import LiveService

    live = LiveService(db, Scope(tenant_id=cam.tenant_id, is_superadmin=True), bearer=None)
    return await live._rtsp_source_for(cam, profile)


async def _record_dir_for(db: AsyncSession, cam: Camera) -> str | None:
    """The camera's assigned storage-pool path (per-camera storage), or None for the
    nvr's default recordings volume — so scheduler/auto starts honor the pool too."""
    pool_id = getattr(cam, "storage_pool_id", None)
    if not pool_id:
        return None
    from app.vms.models import StoragePool

    pool = await db.get(StoragePool, pool_id)
    path = (getattr(pool, "path", None) or "").strip() if pool else None
    return path or None
