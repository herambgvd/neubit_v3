"""Dashboard aggregation service (G2) — tenant-scoped, READ-ONLY.

Rolls up EXISTING vision data into one ``DashboardSummary`` for the ops dashboard.
Every section is a set-based SQL aggregate (GROUP BY / SUM / COUNT) — NO per-camera
N+1. The node section additionally makes ONE best-effort call to the Go ``nvr``
``/status`` (fail-fast timeout) for resilience flags; the node LIST itself comes from
vision's own ``media_nodes`` table so it renders even when the nvr is down.

Discipline mirrors ``HealthService`` / ``ReportService``: every query is filtered
through ``kernel.auth.scoped`` so a tenant-admin only ever sees their own estate
(super-admin sees all). Graceful throughout — an empty tenant yields zeros, an
unreachable nvr marks the node section ``unknown``, and no single failing section can
crash the summary.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, scoped

from app.vms.common.nvr_client import NvrClient, NvrUnavailable
from app.vms.models import (
    NVR,
    Camera,
    MediaNode,
    Recording,
    StoragePool,
    VmsEvent,
)

from .schemas import (
    AlarmsRollup,
    CameraRollup,
    CountBucket,
    DashboardSummary,
    EventItem,
    MediaNodeSummary,
    NodesRollup,
    NvrRollup,
    RecordingRollup,
    StoragePoolSummary,
    StorageRollup,
)

log = logging.getLogger("vision.dashboard")

# A camera/nvr is "recording"/"healthy" if it has a finalized segment within this
# window (recordings arrive as the nvr finalizes each MediaMTX segment, ~minutes).
_RECORDING_ACTIVE_MIN = 15
# Window for the days-to-full growth extrapolation.
_GROWTH_DAYS = 7
# NVR/camera statuses that count as healthy/online.
_ONLINE = "online"
_OFFLINE = "offline"
_DEGRADED = "degraded"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class DashboardService:
    """Tenant-scoped read-only aggregation for the ops dashboard."""

    def __init__(self, db: AsyncSession, scope: Scope, *, bearer: str | None = None) -> None:
        self.db = db
        self.scope = scope
        self.bearer = bearer

    async def summary(self) -> DashboardSummary:
        now = _utcnow()
        day_ago = now - timedelta(hours=24)
        return DashboardSummary(
            cameras=await self._cameras(),
            recording=await self._recording(now, day_ago),
            storage=await self._storage(now),
            nodes=await self._nodes(),
            alarms=await self._alarms(day_ago),
            nvrs=await self._nvrs(),
            generated_at=now,
        )

    # ── cameras ─────────────────────────────────────────────────────────
    async def _cameras(self) -> CameraRollup:
        """Rollup of ``Camera.status`` (single GROUP BY, tenant-scoped)."""
        stmt = scoped(
            select(Camera.status, func.count()), Camera, self.scope
        ).group_by(Camera.status)
        rows = (await self.db.execute(stmt)).all()
        out = CameraRollup()
        for status, count in rows:
            n = int(count or 0)
            out.total += n
            if status == _ONLINE:
                out.online += n
            elif status == _OFFLINE:
                out.offline += n
            elif status == _DEGRADED:
                out.degraded += n
            else:
                out.other += n
        return out

    # ── recording ───────────────────────────────────────────────────────
    async def _recording(self, now: datetime, day_ago: datetime) -> RecordingRollup:
        """Recording status rollup + estate throughput.

        "recording" = distinct cameras with a finalized segment in the recent window;
        "idle" = enabled cameras not in that set; "failed" = distinct cameras with a
        ``recording_error`` event in the last 24h (subtracted from idle so a camera is
        counted once). total_segments + bytes_last_24h are set-based sums.
        """
        active_cutoff = now - timedelta(minutes=_RECORDING_ACTIVE_MIN)

        # distinct cameras with a recent finalized segment.
        active_stmt = scoped(
            select(func.count(func.distinct(Recording.camera_id))),
            Recording,
            self.scope,
        ).where(Recording.start_time >= active_cutoff)
        recording_n = int((await self.db.execute(active_stmt)).scalar() or 0)

        # enabled camera count (the denominator for idle).
        enabled_stmt = scoped(
            select(func.count()), Camera, self.scope
        ).where(Camera.is_enabled.is_(True))
        enabled_n = int((await self.db.execute(enabled_stmt)).scalar() or 0)

        # cameras with a recording_error event in the last 24h.
        failed_stmt = scoped(
            select(func.count(func.distinct(VmsEvent.camera_id))),
            VmsEvent,
            self.scope,
        ).where(
            VmsEvent.event_type == "recording_error",
            VmsEvent.occurred_at >= day_ago,
            VmsEvent.camera_id.isnot(None),
        )
        failed_n = int((await self.db.execute(failed_stmt)).scalar() or 0)

        total_segments = int(
            (await self.db.execute(
                scoped(select(func.count()), Recording, self.scope)
            )).scalar() or 0
        )
        bytes_24h = int(
            (await self.db.execute(
                scoped(
                    select(func.coalesce(func.sum(Recording.file_size), 0)),
                    Recording,
                    self.scope,
                ).where(Recording.created_at >= day_ago)
            )).scalar() or 0
        )

        # idle = enabled cameras that are neither actively recording nor failing.
        idle_n = max(0, enabled_n - recording_n - failed_n)
        return RecordingRollup(
            recording=recording_n,
            idle=idle_n,
            failed=failed_n,
            total_segments=total_segments,
            bytes_last_24h=bytes_24h,
        )

    # ── storage ─────────────────────────────────────────────────────────
    async def _storage(self, now: datetime) -> StorageRollup:
        """Per-pool capacity/used + days-to-full forecast + estate total.

        used_bytes per pool = SUM(Recording.file_size) grouped by storage_pool_id (one
        GROUP BY, not per-pool). days_to_full extrapolates from the bytes written in the
        last ``_GROWTH_DAYS`` (linear): remaining / (growth/day).
        """
        pools = (await self.db.execute(
            scoped(select(StoragePool), StoragePool, self.scope).order_by(StoragePool.name)
        )).scalars().all()

        # used bytes per pool (single grouped query).
        used_rows = (await self.db.execute(
            scoped(
                select(
                    Recording.storage_pool_id,
                    func.coalesce(func.sum(Recording.file_size), 0),
                ),
                Recording,
                self.scope,
            ).group_by(Recording.storage_pool_id)
        )).all()
        used_by_pool: dict[str | None, int] = {pid: int(b or 0) for pid, b in used_rows}

        # growth per pool over the last _GROWTH_DAYS (single grouped query).
        growth_cutoff = now - timedelta(days=_GROWTH_DAYS)
        growth_rows = (await self.db.execute(
            scoped(
                select(
                    Recording.storage_pool_id,
                    func.coalesce(func.sum(Recording.file_size), 0),
                ),
                Recording,
                self.scope,
            ).where(Recording.created_at >= growth_cutoff)
            .group_by(Recording.storage_pool_id)
        )).all()
        growth_by_pool: dict[str | None, int] = {pid: int(b or 0) for pid, b in growth_rows}

        summaries: list[StoragePoolSummary] = []
        total_capacity = 0
        have_capacity = False
        total_used = 0
        for p in pools:
            used = used_by_pool.get(p.id, 0)
            total_used += used
            cap = p.max_size_bytes
            used_pct = None
            if cap:
                have_capacity = True
                total_capacity += cap
                used_pct = round(used / cap * 100.0, 2) if cap else None
            days = _days_to_full(cap, used, growth_by_pool.get(p.id, 0), _GROWTH_DAYS)
            summaries.append(StoragePoolSummary(
                id=p.id,
                name=p.name,
                type=p.pool_type,
                capacity_bytes=cap,
                used_bytes=used,
                used_pct=used_pct,
                days_to_full=days,
            ))

        overall_pct = None
        if have_capacity and total_capacity:
            overall_pct = round(total_used / total_capacity * 100.0, 2)
        return StorageRollup(
            pools=summaries,
            total_capacity_bytes=total_capacity if have_capacity else None,
            total_used_bytes=total_used,
            used_pct=overall_pct,
        )

    # ── nodes / failover ────────────────────────────────────────────────
    async def _nodes(self) -> NodesRollup:
        """Media-node list (local registry) + best-effort nvr resilience flags.

        The node LIST always comes from vision's ``media_nodes`` table (renders even if
        the nvr is down). One fail-fast ``nvr /status`` call adds the resilience/
        streaming/recording flags; on any error the ``data_plane`` field is ``unknown``
        and those flags stay null.
        """
        nodes = (await self.db.execute(
            scoped(select(MediaNode), MediaNode, self.scope).order_by(MediaNode.name)
        )).scalars().all()

        summaries: list[MediaNodeSummary] = []
        healthy = 0
        for n in nodes:
            is_healthy = n.status == _ONLINE
            if is_healthy:
                healthy += 1
            summaries.append(MediaNodeSummary(
                id=n.id,
                name=n.name,
                healthy=is_healthy,
                status=n.status,
                used_channels=n.used_channels,
                capacity_channels=n.capacity_channels,
                last_heartbeat=n.last_heartbeat,
            ))

        roll = NodesRollup(
            nodes=summaries,
            total=len(summaries),
            healthy=healthy,
            unhealthy=len(summaries) - healthy,
        )

        # best-effort nvr resilience flags (never blocks / crashes the summary).
        try:
            status = await NvrClient(bearer=self.bearer).status()
            roll.data_plane = "ok"
            roll.resilience = bool(status.get("resilience"))
            roll.streaming = bool(status.get("streaming"))
            roll.recording = bool(status.get("recording"))
            roll.nats = bool(status.get("nats"))
            node_id = status.get("node")
            roll.nvr_node = str(node_id) if node_id is not None else None
        except NvrUnavailable as exc:
            log.info("dashboard: nvr status unavailable → node data unknown (%s)", exc)
            roll.data_plane = "unknown"
        except Exception as exc:  # noqa: BLE001 — one bad section must not fail the summary
            log.info("dashboard: nvr status error → node data unknown (%s)", exc)
            roll.data_plane = "unknown"
        return roll

    # ── alarms / events (24h) ───────────────────────────────────────────
    async def _alarms(self, day_ago: datetime) -> AlarmsRollup:
        """VmsEvent last-24h counts (total / unack / by-severity / by-type) + recent list."""
        base = scoped(select(func.count()), VmsEvent, self.scope).where(
            VmsEvent.occurred_at >= day_ago
        )
        total = int((await self.db.execute(base)).scalar() or 0)
        unack = int((await self.db.execute(
            base.where(VmsEvent.acknowledged.is_(False))
        )).scalar() or 0)

        by_sev = (await self.db.execute(
            scoped(
                select(VmsEvent.severity, func.count()), VmsEvent, self.scope
            ).where(VmsEvent.occurred_at >= day_ago).group_by(VmsEvent.severity)
        )).all()
        by_type = (await self.db.execute(
            scoped(
                select(VmsEvent.event_type, func.count()), VmsEvent, self.scope
            ).where(VmsEvent.occurred_at >= day_ago).group_by(VmsEvent.event_type)
        )).all()

        # recent list (newest first, capped).
        recent_rows = (await self.db.execute(
            scoped(select(VmsEvent), VmsEvent, self.scope)
            .where(VmsEvent.occurred_at >= day_ago)
            .order_by(VmsEvent.occurred_at.desc())
            .limit(20)
        )).scalars().all()

        by_type_sorted = sorted(
            (CountBucket(key=str(k), count=int(c)) for k, c in by_type),
            key=lambda b: b.count,
            reverse=True,
        )[:8]  # top few
        return AlarmsRollup(
            total=total,
            unacknowledged=unack,
            by_severity=[CountBucket(key=str(k), count=int(c)) for k, c in by_sev],
            by_type=by_type_sorted,
            recent=[
                EventItem(
                    id=r.id,
                    camera_id=r.camera_id,
                    event_type=r.event_type,
                    severity=r.severity,
                    title=r.title,
                    occurred_at=r.occurred_at,
                    acknowledged=r.acknowledged,
                )
                for r in recent_rows
            ],
        )

    # ── nvrs ────────────────────────────────────────────────────────────
    async def _nvrs(self) -> NvrRollup:
        """Registered-NVR rollup (GROUP BY ``NVR.status``). healthy = online."""
        rows = (await self.db.execute(
            scoped(select(NVR.status, func.count()), NVR, self.scope).group_by(NVR.status)
        )).all()
        out = NvrRollup()
        for status, count in rows:
            n = int(count or 0)
            out.total += n
            if status == _ONLINE:
                out.healthy += n
            else:
                out.unhealthy += n
        return out


def _days_to_full(
    capacity: int | None, used: int, growth_bytes: int, growth_days: int
) -> float | None:
    """Linear days-to-full from recent growth. ``None`` when it can't be forecast.

    Returns ``None`` for an unlimited pool (no capacity), when there is no recent
    growth (can't extrapolate), or when the pool is already at/over capacity (0.0 would
    be misleading — the caller shows used_pct instead). Otherwise
    ``remaining / (growth_bytes / growth_days)``, floored at 0.
    """
    if not capacity or capacity <= 0:
        return None
    if growth_bytes <= 0 or growth_days <= 0:
        return None
    remaining = capacity - used
    if remaining <= 0:
        return 0.0
    per_day = growth_bytes / growth_days
    if per_day <= 0:
        return None
    return round(remaining / per_day, 1)
