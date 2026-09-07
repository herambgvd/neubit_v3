"""Camera REGISTRY service — tenant-scoped CRUD over the estate's camera rows.

Mirrors the access service (``backend/access/app/access/service.py``): every read
goes through ``kernel.auth.scoped``; every by-id fetch through ``assert_owned``; new
rows are stamped with the caller's ``tenant_id``.

It does not touch a device. It used to: discovery, ONVIF probe, channel enumeration,
bulk-add onboarding, PTZ, and the imaging / I/O / encoder / OSD / motion / privacy-mask
config writes all decrypted a camera's credentials here and drove the device over a
brand driver. Every one of those is the recorder's — it owns the camera, holds the
credentials, and exposes the same operations over HTTP — and the console reaches them
through ``/vms/federation`` against the node that owns the camera.

What is left is the registry itself: which cameras this estate knows about, what they
are called, which site and group they belong to, which recorder fronts them, and who
may see them. That is the aggregation no single recorder can do.

Onboarding publishes on the NATS spine (``app.vms.common.events``):
  * create → ``device.camera.registered`` (Map/core) + ``vms.camera.status``.
  * update → ``device.camera.updated`` (+ ``vms.camera.status`` on status change).
  * delete → ``device.camera.deregistered``.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, owns, scoped
from kernel.errors import ConflictError, NotFoundError, ValidationError

from app.vms.common.node_routing import node_for_camera
from app.vms.federation import client as fed
from app.vms.common.crypto import decrypt_secret, encrypt_secret
from app.vms.common.events import emit_camera_lifecycle, emit_camera_status
from app.vms.common.stream_policy import (
    WEB_STREAM_ROLE,
    enforce_h264_web,
    needs_web_codec_enforcement,
)
from app.vms.models import Camera, CameraACL, CameraGroup, MediaNode, MediaProfile

from app.vms.groups.schemas import CameraACLPublic
from . import snapshot_frame
from .schemas import (
    CameraCreate,
    CameraListResponse,
    CameraPublic,
    CameraUpdate,
)

log = logging.getLogger("vision.service")

# Recording modes whose data-plane is driven immediately (so a media-node CHANGE
# must re-host them). Mirrors ``recording.service._IMMEDIATE_MODES``; schedule /
# motion / event are (re)opened by the scheduler / P5 on the new node.
_IMMEDIATE_RECORDING_MODES = {"continuous", "manual"}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


class CameraService:
    """Tenant-scoped CRUD + driver-backed onboarding over ``cameras``."""

    #: Strong refs to detached background tasks (web-codec auto-enforce) so the event
    #: loop doesn't GC them mid-flight. Class-level → survives the request-scoped service.
    _bg_tasks: set = set()

    def __init__(
        self,
        db: AsyncSession,
        scope: Scope,
        *,
        bearer: str | None = None,
        site_ids: list[str] | None = None,
    ) -> None:
        self.db = db
        self.scope = scope
        # The caller's JWT — forwarded to the Go nvr when the snapshot fallback needs to
        # bring the MediaMTX on-demand path up (same shared-JWT contract as live view).
        self.bearer = bearer
        # SITE ACCESS SCOPE (from the token's ``site_ids`` claim). EMPTY = unrestricted.
        # Non-empty confines this caller to cameras whose ``site_id`` is in the set —
        # enforced on both single-camera access (``_row``) and listing (``list_``).
        self.site_ids = [str(s) for s in (site_ids or [])]

    def _site_allowed(self, row: Camera) -> bool:
        """Whether a camera is inside the caller's site scope (always True when the
        caller is unrestricted). A camera with no site_id is outside every scope."""
        if not self.site_ids:
            return True
        return row.site_id is not None and str(row.site_id) in self.site_ids

    # ── row + credential helpers ────────────────────────────────────────
    async def _row(self, camera_id: str) -> Camera:
        row = await self.db.get(Camera, camera_id)
        assert_owned(row, self.scope, message="Camera not found", allow_shared=False)
        # Site scope: a camera outside the caller's sites is indistinguishable from a
        # missing one (NOT_FOUND, never FORBIDDEN — no cross-site existence leak).
        if not self._site_allowed(row):
            raise NotFoundError("Camera not found")
        return row

    async def _profiles(self, camera_id: str) -> list[MediaProfile]:
        stmt = (
            select(MediaProfile)
            .where(MediaProfile.camera_id == camera_id)
            .order_by(MediaProfile.name)
        )
        return list((await self.db.execute(stmt)).scalars().all())

    async def _public(self, row: Camera) -> CameraPublic:
        return CameraPublic.from_row(row, await self._profiles(row.id))

    async def _validate_node_usable(self, node_id: str) -> None:
        """Ensure ``node_id`` names a media node this tenant may home a camera on.

        Usable = the node exists AND is owned by the caller (its tenant matches, or
        it's a shared/NULL-tenant platform node) — mirrors ``kernel.auth.owns`` read
        semantics, the same rule ``node_base_for_camera`` routes by. A missing or
        cross-tenant node raises ``NotFoundError`` (NOT_FOUND, not FORBIDDEN — an id in
        another tenant must stay indistinguishable from a non-existent one).

        We do NOT reject an offline / draining node — assigning to a down recorder is
        the operator's call (the UI surfaces node status); the camera comes up on that
        node once it heartbeats. Only existence + tenant-usability are enforced here.
        """
        node = await self.db.get(MediaNode, node_id)
        # allow_shared=True is the POINT here, and it is spelled out because it is
        # the default for now and defaults change: a NULL-tenant node is a platform
        # recorder every tenant may home cameras on. Elsewhere that same default is
        # a bug — see kernel.auth.owns.
        if node is None or not owns(node, self.scope, allow_shared=True):
            raise NotFoundError("media node not found")

    async def _rehost_recording(self, camera: Camera, old_node_id: str | None) -> None:
        """Best-effort STOP on the old node after a camera's ``media_node_id`` CHANGED.

        Only the stop, and only the old node. Starting on the NEW node is the
        recorder's own job: it reconciles continuous and schedule modes every tick and
        will pick the camera up without being asked. The VMS driving a start as well
        meant two things racing to begin one recording.

        The stop is NOT redundant, which is why it stays: the old recorder still has a
        recording target for a camera it no longer fronts, and nothing on that box
        knows the camera moved. Only the VMS does — it is the thing that assigns
        cameras to recorders — so this is aggregation-level orchestration, not device
        control.

        Wrapped so ANY failure (nvr down, node gone) is logged and swallowed: a
        re-host failure must NEVER fail the PATCH/bulk that persisted the reassignment.

        # KNOWN LIMITATION (footage locality): historical recordings written while the
        # camera was on ``old_node_id`` still physically live on THAT node. Playback
        # routes by the camera's CURRENT ``media_node_id`` (MN-1b ``node_base_for_camera``),
        # so those old segments become unreachable via the normal per-camera path after a
        # move. We do NOT migrate footage here (no data loss — the files are intact on the
        # old recorder). FUTURE: route playback per-recording-node (persist the node a
        # Recording was captured on and resolve the base URL from the segment, not the
        # camera's live assignment).
        """
        if old_node_id == camera.media_node_id:
            return
        if not camera.is_enabled or camera.recording_mode not in _IMMEDIATE_RECORDING_MODES:
            return
        try:
            from app.vms.common.nvr_client import NvrClient

            profile = "sub" if camera.record_substream else "main"
            # The camera row now points at the NEW node, so the OLD node's base URL is
            # resolved directly (falling back to the global client when it was
            # unassigned or its api_url is gone).
            old_base = None
            if old_node_id:
                old = await self.db.get(MediaNode, old_node_id)
                old_base = (getattr(old, "api_url", None) or "").strip() or None
            old_nvr = NvrClient(bearer=self.bearer, base_url=old_base)
            await old_nvr.stop_recording(camera_id=camera.id, profile=profile)
        except Exception as exc:  # noqa: BLE001 — a re-host failure must not fail the write
            log.info("re-host stop on the old node failed for camera %s: %s", camera.id, exc)

    async def create(self, body: CameraCreate, *, actor, probe: bool = True) -> CameraPublic:
        # Name is unique within the caller's tenant (like access instance names).
        dup = await self.db.scalar(
            scoped(select(Camera), Camera, self.scope).where(Camera.name == body.name)
        )
        if dup is not None:
            raise ConflictError("a camera with this name already exists")

        actor_id = _actor_id(actor)
        onvif = body.onvif
        row = Camera(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            is_enabled=body.is_enabled,
            status="connecting",
            brand=body.brand,
            driver=body.driver,
            connection_type=body.connection_type,
            network_info=body.network_info.model_dump(exclude_none=True) if body.network_info else {},
            onvif_host=onvif.host if onvif else None,
            onvif_port=onvif.port if onvif else None,
            onvif_user=onvif.user if onvif else None,
            onvif_enc_pass=encrypt_secret(onvif.password) if (onvif and onvif.password) else None,
            onvif_profile_token=onvif.profile_token if onvif else None,
            recording_mode=body.recording.mode,
            recording_schedule=body.recording.schedule,
            recording_fps=body.recording.fps,
            record_substream=body.recording.record_substream,
            retention_days=body.recording.retention_days,
            pre_buffer_seconds=body.recording.pre_buffer_seconds,
            post_buffer_seconds=body.recording.post_buffer_seconds,
            anr_enabled=body.recording.anr_enabled,
            audio_enabled=body.recording.audio_enabled,
            privacy_masks=body.advanced.privacy_masks,
            motion_zones=body.advanced.motion_zones,
            motion_config=body.advanced.motion_config,
            backchannel=body.advanced.backchannel,
            ptz_capable=body.ptz.capable,
            ptz_presets=body.ptz.presets,
            site_id=body.placement.site_id,
            floor_id=body.placement.floor_id,
            zone_id=body.placement.zone_id,
            nvr_id=body.nvr_id,
            nvr_channel_number=body.nvr_channel_number,
            storage_pool_id=body.storage_pool_id,
            media_node_id=body.media_node_id,
            display_order=body.display_order,
            created_by=actor_id,
            updated_by=actor_id,
        )
        self.db.add(row)
        await self.db.flush()  # assign row.id before profiles reference it

        # Operator-supplied media profiles first (explicit wins over probe).
        for mp in body.media_profiles:
            self.db.add(
                MediaProfile(
                    camera_id=row.id,
                    tenant_id=row.tenant_id,
                    name=mp.name,
                    codec=mp.codec,
                    resolution=mp.resolution,
                    fps=mp.fps,
                    rtsp_path=mp.rtsp_path,
                    bitrate=mp.bitrate,
                )
            )

        # No device probe on create. Reading a camera's capabilities means opening an
        # ONVIF session with its credentials, and the recorder that owns the camera
        # holds those — it probes during its own onboarding, and the VMS reads the
        # result through federation. ``probe`` stays in the signature so callers do
        # not break; it no longer does anything.

        await self.db.commit()
        await self.db.refresh(row)

        await self._publish_lifecycle(row, "registered")
        await self._publish_status(row)
        return await self._public(row)

    async def list_(
        self,
        *,
        skip: int = 0,
        limit: int = 50,
        status: str | None = None,
        brand: str | None = None,
        site_id: str | None = None,
        group_id: str | None = None,
        q: str | None = None,
    ) -> CameraListResponse:
        stmt = scoped(select(Camera), Camera, self.scope)
        count_stmt = scoped(select(func.count()).select_from(Camera), Camera, self.scope)

        def _filters(s):
            # Site access scope: confine a scoped caller to their sites (empty = all).
            if self.site_ids:
                s = s.where(Camera.site_id.in_(self.site_ids))
            if status:
                s = s.where(Camera.status == status)
            if brand:
                s = s.where(Camera.brand == brand)
            if site_id:
                s = s.where(Camera.site_id == site_id)
            if q:
                term = f"%{q}%"
                s = s.where(or_(Camera.name.ilike(term), Camera.onvif_host.ilike(term)))
            return s

        stmt = _filters(stmt)
        count_stmt = _filters(count_stmt)

        # Group filter: membership is a JSON id-list on the group row.
        if group_id:
            grp = await self.db.get(CameraGroup, group_id)
            assert_owned(grp, self.scope, message="Camera group not found", allow_shared=False)
            ids = list(grp.camera_ids or []) or ["__none__"]
            stmt = stmt.where(Camera.id.in_(ids))
            count_stmt = count_stmt.where(Camera.id.in_(ids))

        stmt = stmt.order_by(Camera.display_order, Camera.created_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count_stmt) or 0)

        # Batch-load profiles for the page.
        cam_ids = [r.id for r in rows]
        profiles_by_cam: dict[str, list] = {cid: [] for cid in cam_ids}
        if cam_ids:
            prows = (
                await self.db.execute(
                    select(MediaProfile)
                    .where(MediaProfile.camera_id.in_(cam_ids))
                    .order_by(MediaProfile.name)
                )
            ).scalars().all()
            for p in prows:
                profiles_by_cam.setdefault(p.camera_id, []).append(p)

        return CameraListResponse(
            items=[CameraPublic.from_row(r, profiles_by_cam.get(r.id, [])) for r in rows],
            total=total,
            skip=skip,
            limit=limit,
        )

    async def get(self, camera_id: str) -> CameraPublic:
        return await self._public(await self._row(camera_id))

    async def update(self, camera_id: str, body: CameraUpdate, *, actor) -> CameraPublic:
        row = await self._row(camera_id)
        prev_status = row.status
        data = body.model_dump(exclude_unset=True)

        # Recorder-node reassignment: validate the target node BEFORE persisting, and
        # capture the previous node so we can best-effort re-host recording after commit.
        # ``media_node_id`` present in the payload (even set to null = unassign) is allowed;
        # a non-null value must name a node this tenant may use (else NotFound/Validation).
        old_node_id = row.media_node_id
        node_reassigned = "media_node_id" in data and data["media_node_id"] != old_node_id
        if node_reassigned and data["media_node_id"] is not None:
            await self._validate_node_usable(data["media_node_id"])

        simple = {
            "name", "is_enabled", "brand", "driver", "connection_type",
            "nvr_id", "nvr_channel_number", "storage_pool_id", "media_node_id",
            "display_order",
        }
        for k in simple & set(data):
            setattr(row, k, data[k])

        if body.network_info is not None:
            row.network_info = body.network_info.model_dump(exclude_none=True)
        if body.onvif is not None:
            o = body.onvif
            if o.host is not None:
                row.onvif_host = o.host
            if o.port is not None:
                row.onvif_port = o.port
            if o.user is not None:
                row.onvif_user = o.user
            if o.password is not None:
                row.onvif_enc_pass = encrypt_secret(o.password) if o.password else None
            if o.profile_token is not None:
                row.onvif_profile_token = o.profile_token
        if body.recording is not None:
            r = body.recording
            row.recording_mode = r.mode
            row.recording_schedule = r.schedule
            row.recording_fps = r.fps
            row.record_substream = r.record_substream
            row.retention_days = r.retention_days
            row.pre_buffer_seconds = r.pre_buffer_seconds
            row.post_buffer_seconds = r.post_buffer_seconds
            row.anr_enabled = r.anr_enabled
            row.audio_enabled = r.audio_enabled
        if body.advanced is not None:
            a = body.advanced
            row.privacy_masks = a.privacy_masks
            row.motion_zones = a.motion_zones
            row.motion_config = a.motion_config
            row.backchannel = a.backchannel
        if body.ptz is not None:
            row.ptz_capable = body.ptz.capable
            row.ptz_presets = body.ptz.presets
        if body.placement is not None:
            row.site_id = body.placement.site_id
            row.floor_id = body.placement.floor_id
            row.zone_id = body.placement.zone_id

        actor_id = _actor_id(actor)
        if actor_id:
            row.updated_by = actor_id
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)

        # Recorder moved → best-effort re-host active recording onto the new node
        # (never fails the PATCH; footage-locality caveat documented in _rehost_recording).
        if node_reassigned:
            await self._rehost_recording(row, old_node_id)

        await self._publish_lifecycle(row, "updated")
        if row.status != prev_status:
            await self._publish_status(row)
        return await self._public(row)

    async def delete(self, camera_id: str, *, actor) -> None:
        row = await self._row(camera_id)
        tenant_id = row.tenant_id
        payload = _lifecycle_payload(row)
        await self.db.delete(row)  # FK CASCADE removes media_profiles
        await self.db.commit()
        await emit_camera_lifecycle(tenant_id, "deregistered", payload)

    # ── bulk + reorder ──────────────────────────────────────────────────
    async def bulk(
        self, camera_ids: list[str], action: str, *, group_id, retention_days, media_node_id, actor
    ):
        # Load only rows the caller owns (scoped + id filter).
        stmt = scoped(select(Camera), Camera, self.scope).where(Camera.id.in_(camera_ids))
        rows = list((await self.db.execute(stmt)).scalars().all())
        affected = 0
        actor_id = _actor_id(actor)

        if action == "delete":
            deregistered = [(r.tenant_id, _lifecycle_payload(r)) for r in rows]
            for r in rows:
                await self.db.delete(r)
                affected += 1
            await self.db.commit()
            for tid, payload in deregistered:
                await emit_camera_lifecycle(tid, "deregistered", payload)
            return {"affected": affected}

        # ``assign_node``: validate the target node ONCE up-front (same rule as PATCH),
        # then home every owned camera on it. null = unassign (fall back to VE_NVR_URL).
        # Track each camera's previous node so we can best-effort re-host after commit.
        rehost_old: dict[str, str | None] = {}
        if action == "assign_node":
            if media_node_id is not None:
                await self._validate_node_usable(media_node_id)
            for r in rows:
                if r.media_node_id != media_node_id:
                    rehost_old[r.id] = r.media_node_id

        for r in rows:
            if action == "enable":
                r.is_enabled = True
            elif action == "disable":
                r.is_enabled = False
            elif action == "retention":
                if retention_days is None:
                    raise ValidationError("retention_days required for the retention action")
                r.retention_days = retention_days
            elif action == "assign_node":
                r.media_node_id = media_node_id
            if actor_id:
                r.updated_by = actor_id
            r.updated_at = _utcnow()
            affected += 1

        if action == "group":
            if not group_id:
                raise ValidationError("group_id required for the group action")
            grp = await self.db.get(CameraGroup, group_id)
            assert_owned(grp, self.scope, message="Camera group not found", allow_shared=False)
            merged = list(dict.fromkeys([*(grp.camera_ids or []), *[r.id for r in rows]]))
            grp.camera_ids = merged
            grp.updated_at = _utcnow()

        await self.db.commit()

        # Best-effort re-host of every reassigned camera (never fails the bulk op;
        # footage-locality caveat documented in _rehost_recording).
        if action == "assign_node":
            for r in rows:
                if r.id in rehost_old:
                    await self.db.refresh(r)
                    await self._rehost_recording(r, rehost_old[r.id])

        for r in rows:
            await self._publish_lifecycle(r, "updated")
        return {"affected": affected}

    async def reorder(self, items: list) -> dict:
        ids = [it.id for it in items]
        stmt = scoped(select(Camera), Camera, self.scope).where(Camera.id.in_(ids))
        owned = {r.id: r for r in (await self.db.execute(stmt)).scalars().all()}
        applied = 0
        for it in items:
            row = owned.get(it.id)
            if row is None:
                continue
            row.display_order = it.display_order
            row.updated_at = _utcnow()
            applied += 1
        await self.db.commit()
        return {"reordered": applied}

    async def snapshot_for(self, camera_id: str) -> bytes | None:
        """A JPEG snapshot for a camera, taken by the RECORDER that owns it.

        Cached ~30s, because the camera grid asks for sixteen of these at once and a
        snapshot makes the recorder talk to a device.

        The VMS does not grab this frame itself. It used to, two ways: the camera's
        own ONVIF GetSnapshotUri, and — after that went — a frame off the MediaMTX
        path, which still meant deriving the camera's RTSP URL with its decrypted
        password. Both are the recorder's business. It holds the credentials, it
        fronts the stream, and it already serves a snapshot endpoint.

        Returns ``None`` when the camera has no recorder or the recorder cannot
        produce a frame (→ the router 502s and the frontend shows its placeholder).
        Never raises.
        """
        row = await self._row(camera_id)

        cached = snapshot_frame.cache_get(camera_id, "sub")
        if cached is not None:
            return cached

        node = await node_for_camera(self.db, self.scope.tenant_id, row)
        if node is None:
            log.info("snapshot(camera=%s): no recorder fronts this camera", camera_id)
            return None
        try:
            jpeg, _ = await fed.snapshot_node(
                node.api_url, camera_id, credential=node.credential
            )
        except fed.NodeUnavailable as exc:
            log.info("snapshot(camera=%s): recorder could not produce a frame: %s", camera_id, exc)
            return None
        except Exception as exc:  # noqa: BLE001 — a snapshot must never raise
            log.info("snapshot(camera=%s) failed: %s", camera_id, exc)
            return None
        if not jpeg:
            return None
        snapshot_frame.cache_put(camera_id, "sub", jpeg)
        return jpeg

    async def get_acl(self, camera_id: str) -> list[CameraACLPublic]:
        await self._row(camera_id)  # ownership check
        stmt = scoped(select(CameraACL), CameraACL, self.scope).where(
            CameraACL.target_type == "camera", CameraACL.target_id == camera_id
        )
        rows = (await self.db.execute(stmt)).scalars().all()
        return [CameraACLPublic.from_row(r) for r in rows]

    async def put_acl(self, camera_id: str, entries: list, *, actor) -> list[CameraACLPublic]:
        """Replace the per-camera ACL wholesale (idempotent PUT)."""
        await self._row(camera_id)
        actor_id = _actor_id(actor)
        # Drop existing camera-scoped grants, re-create from the supplied set.
        await self.db.execute(
            scoped(sa_delete(CameraACL), CameraACL, self.scope).where(
                CameraACL.target_type == "camera", CameraACL.target_id == camera_id
            )
        )
        created = []
        for e in entries:
            row = CameraACL(
                tenant_id=self.scope.tenant_id,
                subject_type=e.subject_type,
                subject_id=e.subject_id,
                target_type="camera",
                target_id=camera_id,
                privileges=list(e.privileges or []),
                created_by=actor_id,
            )
            self.db.add(row)
            created.append(row)
        await self.db.commit()
        for r in created:
            await self.db.refresh(r)
        return [CameraACLPublic.from_row(r) for r in created]

    # ── NATS publish helpers ─────────────────────────────────────────────
    async def _publish_lifecycle(self, row: Camera, event: str) -> None:
        await emit_camera_lifecycle(row.tenant_id, event, _lifecycle_payload(row))

    async def _publish_status(self, row: Camera) -> None:
        await emit_camera_status(
            row.tenant_id,
            {"camera_id": row.id, "status": row.status, "is_enabled": row.is_enabled},
        )


# ── DTO → dict adapters (driver dataclasses → JSON-safe dicts) ───────────


def _caps_dict(caps) -> dict:
    if caps is None:
        return {}
    return {
        "ptz": caps.ptz,
        "imaging": caps.imaging,
        "events": caps.events,
        "analytics": caps.analytics,
        "audio": caps.audio,
        "io": caps.io,
        "recording_search": caps.recording_search,
        "backchannel": caps.backchannel,
        "media2": caps.media2,
        "services": list(caps.services or []),
    }


def _discovered_dict(d) -> dict:
    return {
        "ip": d.ip,
        "port": d.port,
        "xaddr": d.xaddr,
        "name": d.name,
        "manufacturer": d.manufacturer,
        "model": d.model,
        "firmware": d.firmware,
        "serial_number": d.serial_number,
        "mac": d.mac,
        "brand": d.brand,
        "auth_required": d.auth_required,
    }


def _deviceinfo_dict(info) -> dict:
    return {
        "reachable": info.reachable,
        "manufacturer": info.manufacturer,
        "model": info.model,
        "firmware": info.firmware,
        "serial_number": info.serial_number,
        "hardware_id": info.hardware_id,
        "mac": info.mac,
        "channel_count": info.channel_count,
        "has_ptz": info.has_ptz,
        "has_imaging": info.has_imaging,
        "has_events": info.has_events,
        "has_analytics": info.has_analytics,
        "has_audio": info.has_audio,
        "error": info.error,
    }


def _stream_dict(s) -> dict | None:
    if s is None:
        return None
    return {
        "profile_token": s.profile_token,
        "stream_url": s.stream_url,
        "resolution": s.resolution,
        "fps": s.fps,
        "codec": s.codec,
        "bitrate": s.bitrate,
    }


def _channel_dict(c) -> dict:
    return {
        "channel": c.channel,
        "name": c.name,
        "source_token": c.source_token,
        "channel_number": c.channel_number,
        "main": _stream_dict(c.main),
        "sub": _stream_dict(c.sub),
        "snapshot_url": c.snapshot_url,
        "ptz_capable": c.ptz_capable,
    }


def _lifecycle_payload(row: Camera) -> dict:
    """The ``device.camera.*`` payload core/sites + the Events Map consume."""
    return {
        "camera_id": row.id,
        "name": row.name,
        "site_id": row.site_id,
        "floor_id": row.floor_id,
        "zone_id": row.zone_id,
        "brand": row.brand,
        "network_info": row.network_info or {},
    }
