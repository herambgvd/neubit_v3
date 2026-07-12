"""RAID monitor worker (RAID compliance) — background task in ``app.main`` lifespan.

Polls software-RAID (mdadm) arrays via ``app.vms.common.raid_service`` every
``VE_RAID_POLL_SEC`` seconds, upserts a health snapshot into ``raid_arrays``, and fires
a ONE-SHOT alert on a health transition so operators swap a failed disk before a second
failure loses footage:

  * healthy → degraded/failed  →  ``raid_degraded`` system event (severity ``critical``)
  * degraded/failed → healthy  →  ``raid_recovered`` system event (severity ``info``)

The alert rides the same ``emit_system_event`` path as ``storage_low`` (persist VmsEvent
→ NATS → workflow correlation → incident/notification). GRACEFUL: on a non-Linux host
(mac / Docker Desktop) ``raid_service`` reports unavailable, the monitor logs ONCE and
idles — no rows, no errors. Follows the ``RetentionTieringWorker`` lifecycle exactly.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.vms.common.raid_service import raid_service
from app.vms.models import RaidArray

log = logging.getLogger("vision.raid_monitor")

# Alarm states: an array in one of these has lost redundancy and needs attention.
_ALARM = {"degraded", "failed"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


def poll_sec() -> int:
    return max(15, _env_int("VE_RAID_POLL_SEC", 60))


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class RaidMonitor:
    """Estate-wide software-RAID health poller + degrade alerter."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker
        self._task: asyncio.Task | None = None
        self._running = False
        self._warned_unavailable = False

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        log.info("raid monitor started (poll=%ss)", poll_sec())

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        log.info("raid monitor stopped")

    async def _loop(self) -> None:
        try:
            await asyncio.sleep(min(10, poll_sec()))
        except asyncio.CancelledError:
            return
        while self._running:
            try:
                await self.run_cycle()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — one bad cycle must not kill the loop
                log.warning("raid monitor cycle error: %s", exc)
            try:
                await asyncio.sleep(poll_sec())
            except asyncio.CancelledError:
                return

    async def run_cycle(self) -> dict:
        """One poll: enumerate arrays → upsert + detect transitions. Returns counts."""
        probe = raid_service.probe_available()
        if not probe.get("available"):
            if not self._warned_unavailable:
                log.info("raid inspection unavailable: %s", probe.get("reason"))
                self._warned_unavailable = True
            return {"arrays": 0, "degraded_alerts": 0, "recovered_alerts": 0}

        arrays = await raid_service.list_arrays()
        stats = {"arrays": len(arrays), "degraded_alerts": 0, "recovered_alerts": 0}
        async with self._sessionmaker() as db:
            for arr in arrays:
                transition = await self._upsert(db, arr)
                if transition == "degraded":
                    stats["degraded_alerts"] += 1
                elif transition == "recovered":
                    stats["recovered_alerts"] += 1
            await db.commit()

        for arr, kind in getattr(self, "_pending_alerts", []):
            await self._emit_alert(arr, kind)
        self._pending_alerts = []
        return stats

    async def _upsert(self, db: AsyncSession, arr: dict) -> str | None:
        """Upsert one array snapshot; return 'degraded'/'recovered' on a transition."""
        now = _utcnow()
        new_health = arr["health"]
        alarm = new_health in _ALARM

        row = await db.get(RaidArray, arr["device"])
        transition: str | None = None
        if row is None:
            row = RaidArray(device=arr["device"])
            db.add(row)
            prev_alarm = False
            # A brand-new array first seen ALREADY degraded → alert once.
            if alarm:
                transition = "degraded"
        else:
            prev_alarm = row.health in _ALARM
            if alarm and not prev_alarm:
                transition = "degraded"
            elif not alarm and prev_alarm and new_health == "healthy":
                transition = "recovered"

        row.level = arr["level"]
        row.state = arr["state"]
        row.health = new_health
        row.working_devices = arr["working_devices"]
        row.failed_devices = arr["failed_devices"]
        row.total_devices = arr["total_devices"]
        row.rebuild_status = arr["rebuild_status"]
        row.rebuild_percent = arr["rebuild_percent"]
        row.last_seen_at = now
        row.updated_at = now
        if alarm and row.first_degraded_at is None:
            row.first_degraded_at = now
        elif new_health == "healthy":
            row.first_degraded_at = None

        if transition:
            # Defer the NATS emit until after commit (emit opens its own session).
            self._pending_alerts = getattr(self, "_pending_alerts", [])
            self._pending_alerts.append((dict(arr), transition))
        return transition

    async def _emit_alert(self, arr: dict, kind: str) -> None:
        from app.vms.events.service import emit_system_event

        device = arr["device"]
        if kind == "degraded":
            failed = arr["failed_devices"]
            title = f"RAID array degraded: {device}"
            desc = (
                f"{device} ({arr['level']}) is {arr['health']} — {failed} failed / "
                f"{arr['total_devices']} devices. Replace the failed disk before another "
                "fails or footage is lost."
            )
            severity = "critical"
            event_type = "raid_degraded"
        else:
            title = f"RAID array recovered: {device}"
            desc = f"{device} ({arr['level']}) is healthy again ({arr['working_devices']} devices)."
            severity = "info"
            event_type = "raid_recovered"

        try:
            await emit_system_event(
                self._sessionmaker,
                tenant_id=None,  # RAID is node-global physical infrastructure
                event_type=event_type,
                title=title,
                severity=severity,
                raw={
                    "device": device,
                    "level": arr["level"],
                    "health": arr["health"],
                    "state": arr["state"],
                    "failed_devices": arr["failed_devices"],
                    "working_devices": arr["working_devices"],
                    "total_devices": arr["total_devices"],
                    "rebuild_percent": arr["rebuild_percent"],
                },
                description=desc,
            )
            log.info("raid %s alert emitted for %s", kind, device)
        except Exception as exc:  # noqa: BLE001 — alert emit must not break the poll
            log.warning("raid alert emit failed for %s: %s", device, exc)

    async def list_snapshot(self, db: AsyncSession) -> list[RaidArray]:
        """Latest stored array snapshots (for the read API), newest-degraded first."""
        rows = (await db.execute(select(RaidArray))).scalars().all()
        # Surface unhealthy arrays first.
        return sorted(rows, key=lambda r: (r.health == "healthy", r.device))
