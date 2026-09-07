"""Recording READ MODEL — the estate-wide index of what was recorded.

The recorder owns recording: it holds the policy (mode, weekly schedule, retention,
substream), reconciles it every tick, and writes the segments. This service holds
the one thing no single recorder can — the view ACROSS recorders.

It does two jobs and nothing else:

  * ``persist_segment`` — one ``Recording`` row per finalized segment the recorder
    announces on ``tenant.<id>.vms.recording.segment``, deduped by path.
  * ``list_`` / ``get`` — browse those rows, tenant-scoped.

What used to be here: set_config / get_config, manual start / stop, and the live
"what is recording right now" read, all of which drove the Go ``nvr`` over a service
token. They are the recorder's, and the console reaches them through
``/vms/federation/…`` against the node that owns the camera.

Discipline mirrors the other services: every read/by-id goes through
``kernel.auth.assert_owned`` / ``scoped``; new rows are stamped with the event's
``tenant_id``.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import AppError

from app.vms.common.node_routing import node_base_for_camera
from app.vms.common.nvr_client import NvrClient, NvrUnavailable
from app.vms.live.service import LiveService
from app.vms.models import Camera, Recording, StoragePool

log = logging.getLogger("vision.recording_service")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


class RecordingUpstreamError(AppError):
    """Camera unreachable / nvr down / no RTSP derivable → a clean 502 (never 500)."""

    code = "MEDIA_UPSTREAM"
    status_code = 502


# Modes whose recording is driven immediately (vs. schedule / motion / event which
# are toggled by the scheduler / P5 events).
_IMMEDIATE_MODES = {"continuous", "manual"}


class RecordingService:
    """Tenant-scoped recording policy + browse over ``recordings``."""

    def __init__(self, db: AsyncSession, scope: Scope, *, bearer: str | None = None) -> None:
        self.db = db
        self.scope = scope
        self.bearer = bearer
        # GLOBAL/default client (``VE_NVR_URL``) — used only for the estate-wide
        # ``recording_status`` probe. Every PER-CAMERA start/stop routes to the camera's
        # assigned MediaNode via ``_nvr_for`` (MN-1b, single-node back-compat preserved).
        self.nvr = NvrClient(bearer=bearer)
        # Reuse the live service purely for its RTSP-source derivation (no session).
        self._live = LiveService(db, scope, bearer=bearer)

    async def _camera(self, camera_id: str) -> Camera:
        row = await self.db.get(Camera, camera_id)
        assert_owned(row, self.scope, message="camera not found", allow_shared=False)
        return row

    async def list_(
        self,
        camera_id: str,
        *,
        skip: int = 0,
        limit: int = 50,
        from_: datetime | None = None,
        to: datetime | None = None,
        trigger: str | None = None,
    ):
        # Ensure the camera is owned (scoped) before listing its recordings.
        await self._camera(camera_id)
        stmt = scoped(select(Recording), Recording, self.scope).where(
            Recording.camera_id == camera_id
        )
        count_stmt = scoped(
            select(func.count(Recording.id)), Recording, self.scope
        ).where(Recording.camera_id == camera_id)
        if from_ is not None:
            stmt = stmt.where(Recording.start_time >= from_)
            count_stmt = count_stmt.where(Recording.start_time >= from_)
        if to is not None:
            stmt = stmt.where(Recording.start_time <= to)
            count_stmt = count_stmt.where(Recording.start_time <= to)
        if trigger:
            stmt = stmt.where(Recording.trigger_type == trigger)
            count_stmt = count_stmt.where(Recording.trigger_type == trigger)

        total = int((await self.db.execute(count_stmt)).scalar() or 0)
        rows = list(
            (
                await self.db.execute(
                    stmt.order_by(Recording.start_time.desc()).offset(skip).limit(limit)
                )
            )
            .scalars()
            .all()
        )
        from .schemas import RecordingListResponse, RecordingPublic

        return RecordingListResponse(
            items=[RecordingPublic.from_row(r) for r in rows],
            total=total,
            skip=skip,
            limit=limit,
        )

    async def get(self, rec_id: str):
        row = await self.db.get(Recording, rec_id)
        assert_owned(row, self.scope, message="recording not found", allow_shared=False)
        from .schemas import RecordingPublic

        return RecordingPublic.from_row(row)

    # ── segment persistence (called by the NATS consumer) ───────────────
    async def persist_segment(self, tenant_id, payload: dict) -> str | None:
        """Persist a Recording from an nvr segment event. Deduped by ``path``.

        Returns the new row id, or ``None`` if the segment was already stored (an
        at-least-once redelivery). Runs OUTSIDE a caller scope — the consumer trusts
        the tenant from the subject/payload.
        """
        path = payload.get("path")
        if not path:
            return None
        # Dedupe: skip if this path is already recorded.
        existing = (
            await self.db.execute(select(Recording.id).where(Recording.path == path))
        ).scalar_one_or_none()
        if existing:
            return None

        camera_id = payload.get("camera_id")
        if not camera_id:
            return None

        # tenant_id from the subject is a str (or None for platform). The Recording
        # column is a Uuid | None; coerce.
        import uuid as _uuid

        tid = None
        if tenant_id:
            try:
                tid = _uuid.UUID(str(tenant_id))
            except (ValueError, TypeError):
                tid = None

        # Footage locality: stamp the recorder node that produced this segment so playback
        # later routes to the machine that HOLDS the file (not the camera's future node).
        # Source priority: (a) an explicit node id in the segment event if the Go nvr ever
        # carries one; (b) else the camera's CURRENT media_node_id — accurate because the
        # segment was just recorded by the camera's current node. None (single-node /
        # unassigned) → stays NULL → playback falls back to the global VE_NVR_URL.
        # NB: use only unambiguous *id* keys — a bare ``node`` in nvr payloads elsewhere is
        # a MediaMTX node NAME, not a MediaNode id, so it is deliberately NOT consulted.
        media_node_id = payload.get("media_node_id") or payload.get("node_id")
        if not media_node_id:
            cam = await self.db.get(Camera, camera_id)
            media_node_id = getattr(cam, "media_node_id", None) if cam else None

        row = Recording(
            tenant_id=tid,
            camera_id=camera_id,
            profile=payload.get("profile") or "main",
            path=path,
            media_node_id=media_node_id or None,
            start_time=_parse_dt(payload.get("start")) or _utcnow(),
            end_time=_parse_dt(payload.get("end")),
            duration=_as_float(payload.get("duration")),
            file_size=_as_int(payload.get("size")),
            codec=payload.get("codec"),
            resolution=payload.get("resolution"),
            trigger_type=payload.get("trigger_type") or "continuous",
        )
        self.db.add(row)
        try:
            await self.db.commit()
        except Exception as exc:  # noqa: BLE001 — a racing insert (unique path) is fine
            await self.db.rollback()
            log.info("segment persist race for %s: %s", path, exc)
            return None

        # P3-B: assign the tenant's default storage pool + compute the SHA-256 on
        # finalize. All best-effort — a not-yet-readable file / failure leaves the row
        # ``unchecked`` for the worker to backfill; never fails the persist.
        try:
            await self._finalize_integrity(row, tid)
        except Exception as exc:  # noqa: BLE001 — integrity is best-effort at finalize
            await self.db.rollback()
            log.info("segment integrity finalize deferred for %s: %s", path, exc)
        return row.id

    async def _finalize_integrity(self, row: Recording, tid) -> None:
        """Assign the default pool; DEFER the checksum to the storage worker (P3-B).

        Runs under a per-tenant scope (so the default pool is the recording's OWN
        tenant's), not the consumer's platform writer scope. Commits its own delta.

        The SHA-256 is intentionally NOT computed here: reading the whole segment
        file synchronously in the ingest consumer throttles it to a crawl — fine for
        a trickle of live segments, catastrophic for a bulk re-index (thousands of
        files) and unscalable at 75-150 cameras. The row is left ``unchecked``; the
        storage worker verifies it later. Playback + coverage only need path +
        start_time, which are already persisted before this runs.
        """
        from app.vms.storage.service import StorageService

        pool_scope = Scope(tenant_id=tid, is_superadmin=(tid is None))
        storage = StorageService(self.db, pool_scope)
        pool = await storage.ensure_default_pool()
        if pool is not None and row.storage_pool_id is None:
            row.storage_pool_id = pool.id
        if not row.integrity_status:
            row.integrity_status = "unchecked"
        await self.db.commit()

def _parse_dt(v) -> datetime | None:
    if not v:
        return None
    try:
        # fromisoformat handles the RFC3339 the nvr emits (…±hh:mm / Z via replace).
        s = str(v).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def _as_float(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (ValueError, TypeError):
        return None


def _as_int(v) -> int | None:
    try:
        return int(v) if v is not None else None
    except (ValueError, TypeError):
        return None
