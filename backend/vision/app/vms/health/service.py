"""Camera-health service + background sampler — tenant-scoped reads, estate-wide sampling.

Two collaborators, mirroring the gvd_nvr ``camera_monitor`` pattern (adapted to
tenant-scoped + our driver seam + NATS spine, and de-scoped to reachability for P1):

  * ``HealthService`` (tenant-scoped) — the API surface: latest-per-camera snapshot,
    per-camera history, and an on-demand single-camera re-check. Every read goes
    through ``kernel.auth.scoped``; every by-id fetch through ``assert_owned`` — the
    exact discipline of ``CameraService`` / ``NvrService``.

  * ``HealthSampler`` (estate-wide, NOT tenant-scoped) — the background loop. It runs
    a lightweight reachability probe (``_tcp_reachable`` + last-seen) for every enabled
    camera across ALL tenants, updates ``Camera.status`` / ``last_seen_at``, writes a
    ``CameraHealth`` row, and publishes ``tenant.<id>.vms.camera.status`` (+
    ``device.nvr.status`` for NVRs) on a status transition. Bounded concurrency (a
    semaphore) so 200+ cameras don't stampede; graceful-on-unreachable throughout
    (an unreachable device is just ``status='offline'`` — the loop never crashes).

Why reachability-only (no heavy SOAP per camera)? At scale a full ONVIF ``GetProfiles``
per camera every cycle is prohibitively slow (a single call can block seconds). A TCP
connect to the device's ONVIF/RTSP port + a fresh ``last_seen_at`` is enough to drive
the online/offline status the UI + workflow need. Rich stream metrics
(bitrate/fps/packet-loss/latency) come from the Go ``nvr`` + MediaMTX in P2 — the
``CameraHealth`` columns already exist, the sampler leaves them null.

Auto-purge: each cycle drops ``CameraHealth`` rows older than ``retention_days`` so the
time-series table doesn't grow unbounded (the gvd_nvr map flagged this scaling gap —
fixed here as a set-based DELETE, not a per-camera LIMIT sweep).

Config (env, ``VE_`` prefix — read directly; not part of the shared kernel Settings):
  * ``VE_HEALTH_SAMPLE_INTERVAL_SEC``  — seconds between sampler cycles (default 45).
  * ``VE_HEALTH_SAMPLE_CONCURRENCY``   — max concurrent probes per cycle (default 32).
  * ``VE_HEALTH_PROBE_TIMEOUT_SEC``    — per-probe TCP connect timeout (default 2.5).
  * ``VE_HEALTH_RETENTION_DAYS``       — history retention window (default 30).
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kernel.auth import Scope, assert_owned, scoped

from app.vms.common.events import emit_camera_status, emit_nvr_status
from app.vms.models import NVR, Camera, CameraHealth

from .schemas import (
    CameraHealthHistoryResponse,
    CameraHealthListResponse,
    CameraHealthPublic,
)

log = logging.getLogger("vision.health")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


# ── config (env-driven; see module docstring) ───────────────────────────────────
def sample_interval_sec() -> int:
    return max(5, _env_int("VE_HEALTH_SAMPLE_INTERVAL_SEC", 45))


def sample_concurrency() -> int:
    return max(1, _env_int("VE_HEALTH_SAMPLE_CONCURRENCY", 32))


def probe_timeout_sec() -> float:
    return max(0.5, _env_float("VE_HEALTH_PROBE_TIMEOUT_SEC", 2.5))


def retention_days() -> int:
    return max(1, _env_int("VE_HEALTH_RETENTION_DAYS", 30))


# ── reachability probe (self-contained; mirrors gvd_nvr camera_monitor) ──────────
def _host_port(camera: Camera) -> tuple[str | None, int]:
    """Best (host, port) for a lightweight TCP reachability probe.

    Prefer the ONVIF host/port (the device management port). Fall back to the RTSP
    URL / network_info ip so a plain-RTSP camera is still probeable. Returns
    ``(None, ...)`` when no host is configured — the sampler treats that as offline.
    """
    if camera.onvif_host:
        return camera.onvif_host, int(camera.onvif_port or 80)
    ni = camera.network_info or {}
    ip = ni.get("ip")
    if ip:
        return ip, int(ni.get("port") or ni.get("rtsp_port") or 554)
    # Last resort: parse a main-stream rtsp path off a media profile URL if present.
    for prof in ("main_stream_url", "rtsp_url"):
        url = ni.get(prof)
        if url:
            parsed = urlparse(url)
            if parsed.hostname:
                return parsed.hostname, parsed.port or 554
    return None, 554


async def _tcp_reachable(host: str, port: int, timeout: float) -> bool:
    """True if a TCP connect to ``host:port`` succeeds within ``timeout``. Never raises."""
    try:
        fut = asyncio.open_connection(host, port)
        _reader, writer = await asyncio.wait_for(fut, timeout=timeout)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass
        return True
    except (asyncio.TimeoutError, OSError):
        return False
    except Exception as exc:  # noqa: BLE001 — a probe must never break the loop
        log.debug("reachability probe error for %s:%s — %s", host, port, exc)
        return False


class HealthService:
    """Tenant-scoped health reads + on-demand single-camera re-check."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    # ── row helper ──────────────────────────────────────────────────────
    async def _camera(self, camera_id: str) -> Camera:
        row = await self.db.get(Camera, camera_id)
        assert_owned(row, self.scope, message="Camera not found")
        return row

    # ── latest snapshot per camera ───────────────────────────────────────
    async def latest(self, *, camera_id: str | None = None) -> CameraHealthListResponse:
        """Latest ``CameraHealth`` row per camera in the caller's tenant.

        A correlated subquery picks the newest ``captured_at`` per camera_id, scoped to
        the caller's tenant so a tenant-admin only ever sees their own estate.
        """
        base = scoped(select(CameraHealth), CameraHealth, self.scope)
        if camera_id is not None:
            await self._camera(camera_id)  # ownership check
            base = base.where(CameraHealth.camera_id == camera_id)

        # newest captured_at per camera_id (scoped identically).
        latest_sub = scoped(
            select(
                CameraHealth.camera_id.label("cid"),
                func.max(CameraHealth.captured_at).label("mx"),
            ),
            CameraHealth,
            self.scope,
        )
        if camera_id is not None:
            latest_sub = latest_sub.where(CameraHealth.camera_id == camera_id)
        latest_sub = latest_sub.group_by(CameraHealth.camera_id).subquery()

        stmt = base.join(
            latest_sub,
            (CameraHealth.camera_id == latest_sub.c.cid)
            & (CameraHealth.captured_at == latest_sub.c.mx),
        ).order_by(CameraHealth.camera_id)

        rows = (await self.db.execute(stmt)).scalars().all()
        # Dedupe: two samples can share the exact captured_at (same-second) — keep one.
        seen: set[str] = set()
        items: list[CameraHealthPublic] = []
        for r in rows:
            if r.camera_id in seen:
                continue
            seen.add(r.camera_id)
            items.append(CameraHealthPublic.from_row(r))
        return CameraHealthListResponse(items=items, total=len(items))

    # ── per-camera history (paginated, from/to filter) ───────────────────
    async def history(
        self,
        camera_id: str,
        *,
        skip: int = 0,
        limit: int = 100,
        from_: datetime | None = None,
        to: datetime | None = None,
    ) -> CameraHealthHistoryResponse:
        await self._camera(camera_id)  # ownership check
        stmt = scoped(select(CameraHealth), CameraHealth, self.scope).where(
            CameraHealth.camera_id == camera_id
        )
        count_stmt = scoped(
            select(func.count()).select_from(CameraHealth), CameraHealth, self.scope
        ).where(CameraHealth.camera_id == camera_id)
        if from_ is not None:
            stmt = stmt.where(CameraHealth.captured_at >= from_)
            count_stmt = count_stmt.where(CameraHealth.captured_at >= from_)
        if to is not None:
            stmt = stmt.where(CameraHealth.captured_at <= to)
            count_stmt = count_stmt.where(CameraHealth.captured_at <= to)

        stmt = stmt.order_by(CameraHealth.captured_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count_stmt) or 0)
        return CameraHealthHistoryResponse(
            items=[CameraHealthPublic.from_row(r) for r in rows],
            total=total,
            skip=skip,
            limit=limit,
        )

    # ── on-demand single-camera re-check ─────────────────────────────────
    async def refresh(self, camera_id: str) -> CameraHealthPublic:
        """Re-probe ONE camera now → update status/last_seen + write a health row.

        Publishes ``vms.camera.status`` on a status transition (same as the sampler).
        Returns the freshly-written ``CameraHealth`` sample.
        """
        row = await self._camera(camera_id)
        sample = await sample_one(self.db, row)
        await self.db.commit()
        await self.db.refresh(sample)
        return CameraHealthPublic.from_row(sample)


# ── shared sampling primitive (used by both refresh + the background sampler) ────
async def sample_one(db: AsyncSession, camera: Camera, *, timeout: float | None = None) -> CameraHealth:
    """Probe one camera, mutate its row, append a ``CameraHealth`` sample, emit on change.

    Does NOT commit — the caller owns the transaction (so the sampler can batch a whole
    tenant's cameras + purge in one commit). Graceful: an unreachable device yields
    ``status='offline'`` and never raises. ``bitrate/fps/packet_loss/latency`` are left
    null (P2 stream metrics).
    """
    t = timeout if timeout is not None else probe_timeout_sec()
    host, port = _host_port(camera)
    prev = camera.status
    reachable = bool(host) and await _tcp_reachable(host, port, t)
    new_status = "online" if reachable else "offline"

    now = _utcnow()
    camera.status = new_status
    if reachable:
        camera.last_seen_at = now
        camera.last_error = None
    else:
        camera.last_error = "unreachable (health probe: no TCP response)"
    camera.updated_at = now

    sample = CameraHealth(
        tenant_id=camera.tenant_id,
        camera_id=camera.id,
        status=new_status,
        captured_at=now,
    )
    db.add(sample)

    if new_status != prev:
        await emit_camera_status(
            camera.tenant_id,
            {"camera_id": camera.id, "status": new_status, "is_enabled": camera.is_enabled},
        )
    return sample


class HealthSampler:
    """Estate-wide background reachability sampler (all tenants) + auto-purge.

    Started in ``app.main`` lifespan (like the NATS bus). Runs its own DB session per
    cycle (it is NOT request-scoped). Bounded concurrency via a semaphore; a per-cycle
    transient-DB backoff so a DB blip doesn't hot-loop. ``stop()`` cancels cleanly.
    """

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker
        self._task: asyncio.Task | None = None
        self._running = False

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        log.info(
            "health sampler started (interval=%ss concurrency=%s timeout=%ss retention=%sd)",
            sample_interval_sec(), sample_concurrency(), probe_timeout_sec(), retention_days(),
        )

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        log.info("health sampler stopped")

    async def _loop(self) -> None:
        # Small settle before the first cycle (let NATS/DB finish warming up).
        try:
            await asyncio.sleep(min(10, sample_interval_sec()))
        except asyncio.CancelledError:
            return
        backoff = sample_interval_sec()
        while self._running:
            try:
                await self.run_cycle()
                backoff = sample_interval_sec()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — one bad cycle must not kill the loop
                backoff = min(backoff * 2, 300)
                log.warning("health sampler cycle error (%s) — backing off %ss", exc, backoff)
            try:
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                return

    async def run_cycle(self) -> int:
        """One full pass: sample every enabled camera + NVR, then purge. Returns the
        number of cameras sampled (handy for tests + logging)."""
        sem = asyncio.Semaphore(sample_concurrency())
        async with self._sessionmaker() as db:
            cameras = (
                await db.execute(select(Camera).where(Camera.is_enabled.is_(True)))
            ).scalars().all()

            async def _guarded(cam: Camera) -> None:
                async with sem:
                    try:
                        await sample_one(db, cam)
                    except Exception as exc:  # noqa: BLE001
                        log.debug("health sample failed for camera %s: %s", cam.id, exc)

            if cameras:
                await asyncio.gather(*(_guarded(c) for c in cameras))
            await self._sample_nvrs(db)
            await db.commit()

        # Purge in its own short transaction (kept off the sample commit for clarity).
        await self.purge()
        return len(cameras)

    async def _sample_nvrs(self, db: AsyncSession) -> None:
        """Reachability-check enabled NVRs; publish ``device.nvr.status`` on transition.

        NVRs keep a richer health surface in the ``nvr`` domain (channel/storage) — here
        we only refresh reachability so the estate status stays live. No CameraHealth row
        is written for an NVR (that table is per-camera).
        """
        nvrs = (
            await db.execute(select(NVR).where(NVR.is_enabled.is_(True)))
        ).scalars().all()
        t = probe_timeout_sec()
        for nvr in nvrs:
            prev = nvr.status
            reachable = bool(nvr.host) and await _tcp_reachable(nvr.host, int(nvr.port or 80), t)
            new_status = "online" if reachable else "offline"
            if reachable:
                nvr.last_seen_at = _utcnow()
                nvr.last_error = None
            else:
                nvr.last_error = "unreachable (health probe: no TCP response)"
            nvr.status = new_status
            nvr.updated_at = _utcnow()
            if new_status != prev:
                await emit_nvr_status(
                    nvr.tenant_id,
                    {
                        "nvr_id": nvr.id,
                        "status": new_status,
                        "is_enabled": nvr.is_enabled,
                        "channel_count": nvr.channel_count,
                        "storage": nvr.storage_info or {},
                    },
                )

    async def purge(self, *, days: int | None = None) -> int:
        """Delete ``CameraHealth`` rows older than the retention window (all tenants).

        Set-based DELETE (not a per-camera LIMIT sweep) so it stays cheap at scale.
        Returns the number of rows deleted. Never raises out of a cycle.
        """
        d = days if days is not None else retention_days()
        cutoff = _utcnow() - timedelta(days=d)
        async with self._sessionmaker() as db:
            result = await db.execute(
                sa_delete(CameraHealth).where(CameraHealth.captured_at < cutoff)
            )
            await db.commit()
            deleted = int(result.rowcount or 0)
        if deleted:
            log.info("health auto-purge removed %s CameraHealth rows older than %sd", deleted, d)
        return deleted
