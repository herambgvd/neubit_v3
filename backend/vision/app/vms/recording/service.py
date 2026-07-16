"""Recording control-plane service (P3-A) — tenant-scoped.

Owns the per-camera recording POLICY (mode / weekly schedule / retention /
substream) + the browse/query over the ``recordings`` metadata table, and drives
the Go ``nvr`` data-plane (start/stop MediaMTX record) for the modes that record
immediately (continuous / manual). Schedule windows are toggled by the
``RecordingScheduler`` (a periodic task in vision's lifespan); motion/event are
fired by P5 (the nvr's event-clip entry point).

Discipline mirrors the camera/live services:
  * every read/by-id goes through ``kernel.auth.assert_owned`` / ``scoped``; new
    rows are stamped with the caller's ``tenant_id``.
  * GRACEFUL: an unreachable camera (no RTSP derivable) or a down nvr surfaces as a
    clean 502 (``RecordingUpstreamError``), never a 500 — a policy change still
    persists even if the nvr call fails (the scheduler/reconcile self-heals).

The RTSP-source derivation is REUSED from ``LiveService`` (same decrypt-in-memory,
prefer-substream logic) so recording and live share one code path.
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

    async def _nvr_for(self, camera_or_id) -> NvrClient:
        """An ``NvrClient`` bound to THIS camera's recorder-node base URL (MN-1b).

        Unassigned camera / missing node → ``base_url=None`` → we return the shared
        ``self.nvr`` (global ``VE_NVR_URL``) UNCHANGED — single-node deployments byte-
        identical (and preserves ``self.nvr = stub`` test injection)."""
        base = await node_base_for_camera(self.db, self.scope.tenant_id, camera_or_id)
        if base is None:
            return self.nvr
        return NvrClient(bearer=self.bearer, base_url=base)

    # ── row helpers ─────────────────────────────────────────────────────
    async def _camera(self, camera_id: str) -> Camera:
        row = await self.db.get(Camera, camera_id)
        assert_owned(row, self.scope, message="camera not found")
        return row

    def _record_profile(self, camera: Camera) -> str:
        """Which profile to record: the sub-stream if ``record_substream`` else main."""
        return "sub" if camera.record_substream else "main"

    async def _rtsp_for(self, camera: Camera, profile: str) -> str | None:
        return await self._live._rtsp_source_for(camera, profile)

    # ── config (PUT /cameras/{id}/recording) ────────────────────────────
    async def set_config(self, camera_id: str, body, *, actor):
        """Persist the recording policy; drive the nvr for immediate modes.

        continuous → start recording now; manual → leave as-is (operator toggles);
        schedule → the scheduler opens/closes windows; motion/event → P5. On a mode
        that should NOT be recording continuously (manual/schedule/motion/event with
        no window open), we STOP any active recording so a mode switch takes effect.
        """
        camera = await self._camera(camera_id)
        camera.recording_mode = body.mode
        camera.recording_schedule = body.schedule or {}
        camera.retention_days = body.retention_days
        camera.record_substream = body.record_substream
        camera.audio_enabled = body.audio_enabled
        # Per-camera storage pool — only overwrite when the field is present in the
        # request (None means "leave as-is" isn't distinguishable here, so the body
        # always carries the intended pool; empty string clears it to the default).
        if body.storage_pool_id is not None:
            camera.storage_pool_id = body.storage_pool_id or None
        actor_id = _actor_id(actor)
        if actor_id:
            camera.updated_by = actor_id
        camera.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(camera)

        recording_now = False
        # Drive the data-plane. Best-effort: a down nvr does not roll back the policy
        # (the scheduler/reconcile re-asserts it), but continuous is surfaced as 502
        # if it can't start right now so the operator sees the camera is unreachable.
        try:
            if body.mode == "continuous" and camera.is_enabled:
                await self._drive_start(camera, trigger="continuous")
                recording_now = True
            else:
                # Any non-continuous mode: stop an in-flight continuous recording so
                # the switch is honoured (schedule windows / manual re-enable later).
                nvr = await self._nvr_for(camera)
                await nvr.stop_recording(
                    camera_id=camera.id, profile=self._record_profile(camera)
                )
        except RecordingUpstreamError:
            raise
        except NvrUnavailable as exc:
            # Non-continuous stop is best-effort; a continuous start failure is 502.
            if body.mode == "continuous":
                raise RecordingUpstreamError(exc.message) from exc
            log.info("recording config stop best-effort failed: %s", exc)

        return self._config_public(camera, recording_now)

    async def get_config(self, camera_id: str):
        camera = await self._camera(camera_id)
        return self._config_public(camera, recording_now=False)

    async def active_recordings(self) -> dict:
        """The set of camera_ids ACTUALLY recording right now (live nvr state, not the
        per-camera policy mode). Drives the UI's real "● Recording" indicator. Degrades
        to available=False (unknown) if the nvr data-plane is unreachable."""
        try:
            targets = await self.nvr.recording_status()
        except NvrUnavailable:
            return {"available": False, "camera_ids": []}
        tenant = str(self.scope.tenant_id) if self.scope.tenant_id else None
        cam_ids: set[str] = set()
        for t in targets:
            # Tenant-scope the view (superadmin sees all; a tenant sees only its own).
            if tenant and str(t.get("tenant_id") or "") not in ("", tenant):
                continue
            cid = t.get("camera_id")
            if cid:
                cam_ids.add(str(cid))
        return {"available": True, "camera_ids": sorted(cam_ids)}

    # ── manual start / stop ─────────────────────────────────────────────
    async def start(self, camera_id: str, *, actor, trigger: str = "manual"):
        camera = await self._camera(camera_id)
        act = await self._drive_start(camera, trigger=trigger)
        return {
            "camera_id": camera.id,
            "profile": self._record_profile(camera),
            "recording": True,
            "trigger_type": act.get("trigger_type", trigger),
        }

    async def stop(self, camera_id: str, *, actor):
        camera = await self._camera(camera_id)
        profile = self._record_profile(camera)
        nvr = await self._nvr_for(camera)
        await nvr.stop_recording(camera_id=camera.id, profile=profile)
        return {
            "camera_id": camera.id,
            "profile": profile,
            "recording": False,
            "trigger_type": None,
        }

    async def _record_dir_for(self, camera: Camera) -> str | None:
        """The recordings root for THIS camera = its assigned storage pool's path
        (enterprise VMS per-camera storage). None → the nvr's default recordings volume."""
        pool_id = getattr(camera, "storage_pool_id", None)
        if not pool_id:
            return None
        pool = await self.db.get(StoragePool, pool_id)
        path = (getattr(pool, "path", None) or "").strip() if pool else None
        return path or None

    async def _drive_start(self, camera: Camera, *, trigger: str) -> dict:
        """Derive RTSP + ask the nvr to start recording. Raises 502 on failure."""
        profile = self._record_profile(camera)
        rtsp_url = await self._rtsp_for(camera, profile)
        if not rtsp_url:
            raise RecordingUpstreamError("camera has no reachable RTSP stream to record")
        record_dir = await self._record_dir_for(camera)
        nvr = await self._nvr_for(camera)
        try:
            return await nvr.start_recording(
                camera_id=camera.id, profile=profile, rtsp_url=rtsp_url,
                trigger=trigger, audio=bool(camera.audio_enabled), record_dir=record_dir,
            )
        except NvrUnavailable as exc:
            raise RecordingUpstreamError(exc.message) from exc

    # ── browse (GET /cameras/{id}/recordings, GET /recordings/{id}) ──────
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
        assert_owned(row, self.scope, message="recording not found")
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
        """Assign default pool + checksum a freshly-persisted segment (P3-B).

        Runs under a per-tenant scope (so the default pool is the recording's OWN
        tenant's), not the consumer's platform writer scope. Commits its own delta.
        """
        from app.vms.storage.service import StorageService, compute_integrity

        pool_scope = Scope(tenant_id=tid, is_superadmin=(tid is None))
        storage = StorageService(self.db, pool_scope)
        pool = await storage.ensure_default_pool()
        if pool is not None and row.storage_pool_id is None:
            row.storage_pool_id = pool.id
        # Compute + store the checksum (missing file → ``unchecked`` for the worker).
        await compute_integrity(self.db, pool_scope, row, missing_as_unchecked=True)
        await self.db.commit()

    # ── helpers ─────────────────────────────────────────────────────────
    def _config_public(self, camera: Camera, recording_now: bool):
        from .schemas import RecordingConfigPublic

        return RecordingConfigPublic(
            camera_id=camera.id,
            mode=camera.recording_mode,
            schedule=camera.recording_schedule or {},
            retention_days=camera.retention_days,
            record_substream=camera.record_substream,
            audio_enabled=bool(camera.audio_enabled),
            storage_pool_id=getattr(camera, "storage_pool_id", None),
            recording_now=recording_now,
        )


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
