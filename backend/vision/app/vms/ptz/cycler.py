"""Patrol cycler (G1) — the process-local guard-tour runner.

A running PTZ patrol goto-presets each of its ordered stops in turn, holding
``dwell_seconds`` between advances. This is a pure SERVER-SIDE goto cycler (no brand
depends on native tours; the goto loop works for every driver). It is intentionally
simple:

  * One ``asyncio.Task`` per running patrol, keyed by ``patrol_id`` in a module-level
    singleton (``get_cycler()``). Start = spawn the task + flip ``is_running=True``;
    stop = cancel the task + flip ``is_running=False``.
  * Each tick opens its OWN DB session (via the app sessionmaker) — the cycler is NOT
    request-scoped and must not hold a request session across ``await asyncio.sleep``.
  * It re-reads the patrol every tick, so a PATCH to its stops takes effect on the next
    loop; if the patrol is deleted / deactivated / no longer running, the loop exits.
  * A goto failure (unreachable camera) is logged and skipped — one bad stop does not kill
    the tour.

⚠️ Restart caveat (documented + accepted, per the G1 plan): the cycler tasks are
PROCESS-LOCAL. A vision-process restart drops every running task. ``PtzPatrol.is_running``
persists the operator's intent; on restart the service re-arms running patrols in
``rearm_running()`` (called from the app lifespan), so tours resume automatically. If that
re-arm is disabled, an operator simply re-starts the patrol. No cross-process scheduler is
used (single-writer control plane); a lost-then-resumed tour is acceptable.
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.vms.common.crypto import decrypt_secret
from app.vms.drivers import Credentials, PtzCommand, get_driver
from app.vms.models import Camera, PtzPatrol, PtzPreset

log = logging.getLogger("vision.ptz.cycler")


def _creds_for(row: Camera) -> Credentials:
    return Credentials(
        username=row.onvif_user or "admin",
        password=decrypt_secret(row.onvif_enc_pass) or "",
        port=row.onvif_port or 80,
        rtsp_port=(row.network_info or {}).get("rtsp_port") or 554,
    )


class PatrolCycler:
    """Singleton runner: one asyncio task per running patrol (keyed by patrol_id)."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession] | None = None) -> None:
        self._sessionmaker = sessionmaker
        self._tasks: dict[str, asyncio.Task] = {}

    def bind(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        """Attach the app sessionmaker (called from the lifespan before re-arm)."""
        self._sessionmaker = sessionmaker

    def is_running(self, patrol_id: str) -> bool:
        task = self._tasks.get(patrol_id)
        return bool(task and not task.done())

    def start(self, patrol_id: str) -> None:
        """Spawn the cycler task for a patrol (idempotent — a running task is left alone)."""
        if self._sessionmaker is None:
            log.warning("patrol cycler has no sessionmaker bound — cannot start %s", patrol_id)
            return
        if self.is_running(patrol_id):
            return
        self._tasks[patrol_id] = asyncio.create_task(self._run(patrol_id))
        log.info("patrol %s started", patrol_id)

    async def stop(self, patrol_id: str) -> None:
        """Cancel a running patrol task (best-effort)."""
        task = self._tasks.pop(patrol_id, None)
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        log.info("patrol %s stopped", patrol_id)

    async def stop_all(self) -> None:
        for pid in list(self._tasks):
            await self.stop(pid)

    async def rearm_running(self) -> int:
        """Re-start every patrol whose ``is_running`` flag is set (restart recovery).

        Called from the app lifespan after ``bind``. Returns the number re-armed.
        """
        if self._sessionmaker is None:
            return 0
        async with self._sessionmaker() as db:
            rows = (
                await db.execute(
                    select(PtzPatrol).where(
                        PtzPatrol.is_running.is_(True), PtzPatrol.is_active.is_(True)
                    )
                )
            ).scalars().all()
        for row in rows:
            self.start(row.id)
        if rows:
            log.info("re-armed %d running patrol(s) after restart", len(rows))
        return len(rows)

    async def _run(self, patrol_id: str) -> None:
        """The per-patrol loop: goto each stop in order, dwell, repeat. Re-reads state
        every tick so edits/stop/delete take effect. Exits when no longer runnable."""
        assert self._sessionmaker is not None
        while True:
            # Load patrol + resolve stops → (preset_token, dwell) each tick.
            async with self._sessionmaker() as db:
                patrol = await db.get(PtzPatrol, patrol_id)
                if patrol is None or not patrol.is_running or not patrol.is_active:
                    return
                stops = list(patrol.stops or [])
                speed = patrol.speed
                camera_id = patrol.camera_id
                if not stops:
                    # Nothing to cycle — idle a bit, re-check for edits.
                    await asyncio.sleep(2)
                    continue
                cam = await db.get(Camera, camera_id)
                if cam is None:
                    return
                host = cam.onvif_host or (cam.network_info or {}).get("ip")
                brand = cam.brand
                creds = _creds_for(cam)
                # Resolve each stop's on-device preset token.
                resolved: list[tuple[str | None, int]] = []
                for stop in stops:
                    preset = await db.get(PtzPreset, stop.get("preset_id"))
                    token = preset.preset_token if preset else None
                    resolved.append((token, int(stop.get("dwell_seconds", 5) or 5)))

            if not host:
                await asyncio.sleep(5)
                continue

            driver = get_driver(brand)
            try:
                for token, dwell in resolved:
                    if token is None:
                        continue
                    try:
                        await driver.ptz(
                            host, creds,
                            PtzCommand(action="goto_preset", preset_token=token, speed=speed),
                        )
                    except Exception as exc:  # noqa: BLE001 — one bad stop doesn't kill the tour
                        log.debug("patrol %s goto %s failed: %s", patrol_id, token, exc)
                    await asyncio.sleep(dwell)
            except asyncio.CancelledError:
                raise
            finally:
                await driver.aclose()


# ── module singleton ─────────────────────────────────────────────────────
_CYCLER: PatrolCycler | None = None


def get_cycler() -> PatrolCycler:
    """Return the process-wide patrol cycler singleton."""
    global _CYCLER
    if _CYCLER is None:
        _CYCLER = PatrolCycler()
    return _CYCLER
