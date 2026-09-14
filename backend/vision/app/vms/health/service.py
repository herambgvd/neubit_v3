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

The same cycle now also bounds the other three tables that grew per camera per day
with nothing deleting from them — ``vms_events``, ``linkage_fires`` and
``playback_sessions``. They ride this loop rather than a loop of their own because a
sweeper is a thing you have to remember to start, and this one is already started,
already restarted on failure, and already stopped cleanly (``HealthSampler.stop``).
Each keeps its OWN window and env var: an ONVIF event stream, a rule-fire audit row
and a five-minute viewer session are three different retention questions, and one
number for all three would be wrong for at least two of them. See ``purge_all``.

``recordings`` is deliberately NOT swept — see the note on ``purge_all``.

Config (env, ``VE_`` prefix — read directly; not part of the shared kernel Settings):
  * ``VE_HEALTH_SAMPLE_INTERVAL_SEC``  — seconds between sampler cycles (default 45).
  * ``VE_HEALTH_SAMPLE_CONCURRENCY``   — max concurrent probes per cycle (default 32).
  * ``VE_HEALTH_PROBE_TIMEOUT_SEC``    — per-probe TCP connect timeout (default 2.5).
  * ``VE_HEALTH_RETENTION_DAYS``       — camera-health history window (default 30).
  * ``VE_VMS_EVENT_RETENTION_DAYS``    — device/system event window (default 365).
  * ``VE_LINKAGE_FIRE_RETENTION_DAYS`` — rule-fire audit window (default 365).
  * ``VE_PLAYBACK_SESSION_RETENTION_DAYS`` — viewer-session window (default 7).
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from sqlalchemy import and_, or_
from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kernel.auth import Scope, assert_owned, scoped

from app.vms.common.events import emit_camera_event, emit_camera_status, emit_nvr_status
from app.vms.events.normalize import dedup_key, event_payload
from app.vms.models import NVR, Camera, CameraHealth, LinkageFire, PlaybackSession, VmsEvent

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


# Every retention window below is floored at 1 day for the same reason the sampler
# knobs are floored: a typo or an empty env var must not turn into "delete
# everything older than now". ``_env_int`` already falls back to the default on
# garbage; the floor covers a deliberate 0.


def vms_event_retention_days() -> int:
    """Device/system event window — default 365 days.

    A year, because this table is the investigation record: a tamper or video-loss
    event is what an incident review, an insurance claim or a police request is
    reconstructed from, and those arrive months late. Shorter would bound the table
    a little better and lose evidence, which is the worse failure of the two. A year
    still bounds it, and the supervisor's dedup grain means a flapping camera does
    not write a row per notification.
    """
    return max(1, _env_int("VE_VMS_EVENT_RETENTION_DAYS", 365))


def linkage_fire_retention_days() -> int:
    """Rule-fire audit window — default 365 days, deliberately the same as events.

    A fire row exists to answer "why did that camera start recording / why did the
    wall display switch" about a specific event. Expiring it sooner than the event
    it explains would leave the event in the feed with its explanation already
    swept — so the two windows move together unless an operator separates them.
    """
    return max(1, _env_int("VE_LINKAGE_FIRE_RETENTION_DAYS", 365))


def playback_session_retention_days() -> int:
    """Viewer-session window — default 7 days, measured from ``expires_at``.

    Not evidence: the row is the control-plane bookkeeping for a media token whose
    whole life is ``VE_MEDIA_TOKEN_TTL_SEC`` (300s), kept only so release/renew can
    find the MediaMTX path. Once it has expired its remaining value is the audit
    line "this operator streamed this camera at this time", and a week covers the
    shift-review that asks. This is the fastest-growing of the three — one row per
    viewer stream, every tile of every wall — so it gets the shortest window.
    """
    return max(1, _env_int("VE_PLAYBACK_SESSION_RETENTION_DAYS", 7))


#: Rows deleted per statement. Matches the one batching sweep already in the
#: codebase (``ingest/app/retention.py``) — big enough that a year of backlog drains
#: in a few cycles, small enough that each DELETE takes row locks briefly and the
#: request path never waits on a retention sweep. The CameraHealth purge below stays
#: a single set-based DELETE because it is bounded by cameras × cycles-per-day; these
#: three are not, and a first sweep against an appliance that has been running
#: unbounded for a year could otherwise be one enormous statement.
PURGE_BATCH = 5_000


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
        assert_owned(row, self.scope, message="Camera not found", allow_shared=False)
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
        # P5-A system event: an online↔offline transition is a camera_online /
        # camera_offline VmsEvent, published on the SAME ``tenant.<id>.vms.camera.<type>``
        # stream the workflow correlation engine consumes (a "camera offline" SOP can
        # fire off it). The row rides the caller's transaction (the sampler batches a
        # whole tenant + commits once); publish is best-effort here.
        await _emit_camera_status_event(db, camera, new_status)
    return sample


async def _emit_camera_status_event(db: AsyncSession, camera: Camera, new_status: str) -> None:
    """Add a camera_online/camera_offline VmsEvent to ``db`` + publish (best-effort).

    Does NOT commit — the row rides the sampler's (or refresh's) transaction. Deduped
    by the same (camera+type+bucket) grain as device events, so a flapping camera
    within one window collapses to a single row. Never raises out of the sampler."""
    event_type = "camera_online" if new_status == "online" else "camera_offline"
    now = camera.updated_at or _utcnow()
    key = dedup_key(camera.id, event_type, now)
    # Skip if an identical status event already exists in this window (idempotent).
    try:
        existing = (
            await db.execute(select(VmsEvent.id).where(VmsEvent.dedup_key == key))
        ).scalar_one_or_none()
        if existing:
            return
    except Exception:  # noqa: BLE001
        return
    row = VmsEvent(
        tenant_id=camera.tenant_id,
        camera_id=camera.id,
        event_type=event_type,
        severity="info" if new_status == "online" else "warning",
        source="system",
        title=f"Camera {new_status}",
        description=f"{camera.name} is {new_status}",
        raw={"status": new_status, "reason": "health-sampler reachability transition"},
        dedup_key=key,
        occurred_at=now,
        published=False,
    )
    db.add(row)
    try:
        await db.flush()  # assign id without committing (caller owns the commit)
        await emit_camera_event(camera.tenant_id, event_type, event_payload(row))
        row.published = True
    except Exception as exc:  # noqa: BLE001 — publish/flush best-effort; never break sampling
        log.debug("camera status event emit failed for %s: %s", camera.id, exc)


async def purge_batched(sessionmaker, model, whereclause, *, batch: int = PURGE_BATCH) -> int:
    """Delete rows matching ``whereclause`` from ``model``, ``batch`` at a time.

    Selects a batch of primary keys, deletes exactly those, commits, repeats. The
    shape is the ingest log sweep's, and the reason is the same: a single DELETE
    over a year of backlog holds row locks for as long as it runs, and this sweep
    shares its database with the request path. Committing per batch also means an
    interrupted sweep (a restart mid-purge) keeps the work it already did.

    Returns the number of rows removed. Raises — the caller decides whether one
    table's failure should stop the others.
    """
    removed = 0
    while True:
        async with sessionmaker() as db:
            ids = (
                await db.execute(select(model.id).where(whereclause).limit(batch))
            ).scalars().all()
            if not ids:
                return removed
            await db.execute(sa_delete(model).where(model.id.in_(ids)))
            await db.commit()
            removed += len(ids)
        if len(ids) < batch:
            return removed


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
            # gather(..., return_exceptions=True) rather than try/except: we are the
            # canceller, so the CancelledError coming back is our own acknowledgement
            # and there is nothing to handle. Written as an except clause it looked
            # like a swallowed cancellation, which is a real bug elsewhere in this
            # file — the task BODIES used to do exactly that. One shape that cannot
            # be mistaken for the other is worth more than three saved characters.
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None
        log.info("health sampler stopped")

    async def _loop(self) -> None:
        # Small settle before the first cycle (let NATS/DB finish warming up).
        #
        # No CancelledError guard on either sleep. There used to be one that
        # RETURNED, which ended the task as though its work had finished — a caller
        # awaiting it could not tell a clean stop from a cancellation, and asyncio's
        # contract is that CancelledError propagates. Catching it only to re-raise
        # is the same as not catching it, so it is simply not caught. stop() is
        # where it is absorbed, and that is correct there: stop() is the canceller.
        await asyncio.sleep(min(10, sample_interval_sec()))
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
            await asyncio.sleep(backoff)

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
        await self.purge_all()
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

    # ── estate retention: every table this service grows without bound ──────────
    async def purge_all(self) -> dict[str, int]:
        """Run every retention sweep this service owns. Returns rows removed per table.

        One table's failure does not cancel the rest: these are independent windows
        and a lock-timeout on the events table is no reason to let viewer sessions
        accumulate for another cycle. Nothing raises out of here — the caller is the
        sampler loop, and a purge is not worth a backoff on sampling.

        ``recordings`` is NOT in this list and must not be added. A ``Recording`` row
        is a pointer to a video segment the RECORDER owns and stores: deleting the
        row orphans the footage (nothing else names that file), and deleting the
        footage is the recorder's call, not this service's — under the single-
        ownership architecture the VMS aggregates and commands, it does not manage
        the recorder's disk. Recording retention belongs to the NVR's own retention
        worker, which is why this service's storage/tiering workers are not run at
        all (see ``app/main.py``). Bounding ``recordings`` from here would mean this
        service deciding when evidence stops existing on a box it does not own.
        """
        now = _utcnow()
        results: dict[str, int] = {}

        # (label, model, predicate) — evaluated fresh each cycle so an operator's env
        # change takes effect on the next sweep, not the next restart.
        sweeps = (
            (
                "camera_health",
                None,  # handled by purge(): a set-based DELETE, already bounded.
                None,
            ),
            (
                "vms_events",
                VmsEvent,
                and_(
                    VmsEvent.occurred_at
                    < now - timedelta(days=vms_event_retention_days()),
                    # An event that captured a snapshot or points at a recording is
                    # not just a log line — it is the index INTO evidence that still
                    # exists on disk. Sweeping it would leave an unreferenced
                    # snapshot file and a clip nobody can explain, which is the
                    # ``recordings`` problem wearing a different table's name. These
                    # rows are a small minority (only a capture rule writes them) and
                    # they age out with the media the recorder owns, not with us.
                    VmsEvent.snapshot_path.is_(None),
                    VmsEvent.recording_id.is_(None),
                ),
            ),
            (
                "linkage_fires",
                LinkageFire,
                and_(
                    LinkageFire.fired_at
                    < now - timedelta(days=linkage_fire_retention_days()),
                    # Same exemption, same reason: a fire that started a recording is
                    # the provenance of that clip.
                    LinkageFire.recording_id.is_(None),
                ),
            ),
            (
                "playback_sessions",
                PlaybackSession,
                or_(
                    PlaybackSession.expires_at
                    < now - timedelta(days=playback_session_retention_days()),
                    # ``expires_at`` is nullable and set a statement after the INSERT.
                    # A row that never got one would be immortal under an expiry-only
                    # predicate — the one row shape a sweep must not miss is the one
                    # written by a half-failed request. ``created_at`` is the floor
                    # for those.
                    and_(
                        PlaybackSession.expires_at.is_(None),
                        PlaybackSession.created_at
                        < now - timedelta(days=playback_session_retention_days()),
                    ),
                ),
            ),
        )

        for label, model, predicate in sweeps:
            try:
                if model is None:
                    results[label] = await self.purge()  # logs its own count
                else:
                    removed = await purge_batched(self._sessionmaker, model, predicate)
                    results[label] = removed
                    if removed:
                        log.info("retention sweep removed %s %s rows", removed, label)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — one table must not block the rest
                results[label] = 0
                log.warning("retention sweep for %s failed: %s", label, exc)
        return results
