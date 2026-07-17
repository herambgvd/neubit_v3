"""Camera-onboarding service — tenant-scoped CRUD + driver-backed ops.

Mirrors the access service (``backend/access/app/access/service.py``): every read
goes through ``kernel.auth.scoped``; every by-id fetch through ``assert_owned``;
new rows are stamped with the caller's ``tenant_id``. ONVIF/RTSP credentials are
stored REVERSIBLY encrypted (``vms.common.crypto``) — the plaintext is handed to a
driver in-memory only, never persisted.

Graceful-on-unreachable is the discipline throughout (no live devices in dev):
probe/discover/channels/snapshot go through the driver, which returns empty/None
on failure — the service never 500s. Only explicit operator actions (``ptz`` /
``configure`` writes) surface a ``DriverError`` as a clean 502.

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

from app.vms.common.crypto import decrypt_secret, encrypt_secret
from app.vms.common.events import emit_camera_lifecycle, emit_camera_status
from app.vms.common.stream_policy import (
    WEB_STREAM_ROLE,
    enforce_h264_web,
    needs_web_codec_enforcement,
)
from app.vms.drivers import Credentials, DriverError, PtzCommand, get_driver
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

    def __init__(self, db: AsyncSession, scope: Scope, *, bearer: str | None = None) -> None:
        self.db = db
        self.scope = scope
        # The caller's JWT — forwarded to the Go nvr when the snapshot fallback needs to
        # bring the MediaMTX on-demand path up (same shared-JWT contract as live view).
        self.bearer = bearer

    # ── row + credential helpers ────────────────────────────────────────
    async def _row(self, camera_id: str) -> Camera:
        row = await self.db.get(Camera, camera_id)
        assert_owned(row, self.scope, message="Camera not found")
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

    def _creds_for(self, row: Camera) -> Credentials:
        """Build a driver ``Credentials`` from a stored camera row (decrypting)."""
        return Credentials(
            username=row.onvif_user or "admin",
            password=decrypt_secret(row.onvif_enc_pass) or "",
            port=row.onvif_port or 80,
            rtsp_port=(row.network_info or {}).get("rtsp_port") or 554,
        )

    # ── recorder-node assignment (media_node_id) ─────────────────────────
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
        if node is None or not owns(node, self.scope):
            raise NotFoundError("media node not found")

    async def _rehost_recording(self, camera: Camera, old_node_id: str | None) -> None:
        """Best-effort re-host after a camera's ``media_node_id`` CHANGED.

        If the camera is actively recording (an immediate mode, enabled), stop the
        recording on the OLD node and start it on the NEW node so footage keeps flowing
        to the recorder that now fronts the camera. Wrapped so ANY failure (nvr down,
        no RTSP derivable, driver error) is logged and swallowed — a re-host failure
        must NEVER fail the PATCH/bulk that persisted the reassignment. The recording
        scheduler / reconcile self-heals the data-plane on its next pass.

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
            from app.vms.recording.service import RecordingService

            rec = RecordingService(self.db, self.scope, bearer=self.bearer)
            profile = "sub" if camera.record_substream else "main"
            # Stop on the OLD node. The camera row now points at the NEW node, so we
            # resolve the OLD node's base URL directly (fall back to the global client
            # when it was unassigned / its api_url is gone).
            try:
                old_base = None
                if old_node_id:
                    old = await self.db.get(MediaNode, old_node_id)
                    old_base = (getattr(old, "api_url", None) or "").strip() or None
                old_nvr = NvrClient(bearer=self.bearer, base_url=old_base) if old_base else rec.nvr
                await old_nvr.stop_recording(camera_id=camera.id, profile=profile)
            except Exception as exc:  # noqa: BLE001 — stop is best-effort
                log.info("re-host stop on old node failed for camera %s: %s", camera.id, exc)
            # Re-assert the recording state on the NEW node. Only CONTINUOUS auto-follows
            # the camera to its new recorder (the row already carries the new assignment,
            # so ``_drive_start`` routes to it via ``_nvr_for``). MANUAL is operator-triggered
            # — auto-starting it on a mere node MOVE would falsely mark an idle camera as
            # recording (a lit "REC" badge on a manual camera). For manual we instead ensure
            # the new node is NOT left with an active recording target.
            if camera.recording_mode == "continuous":
                await rec._drive_start(camera, trigger="continuous")
            else:
                try:
                    new_nvr = await rec._nvr_for(camera)
                    await new_nvr.stop_recording(camera_id=camera.id, profile=profile)
                except Exception as exc:  # noqa: BLE001 — new-node stop is best-effort
                    log.info("re-host stop on new node failed for camera %s: %s", camera.id, exc)
        except Exception as exc:  # noqa: BLE001 — a re-host failure must not fail the write
            log.info("re-host recording failed for camera %s: %s", camera.id, exc)

    # ── probe-on-create (best-effort capability autofill) ────────────────
    async def _autofill_from_device(self, row: Camera) -> None:
        """Probe the device via its driver and fill capabilities/profiles/PTZ.

        Graceful: any failure (unreachable, driver missing) leaves the row at
        ``status='connecting'`` with whatever the operator supplied — NEVER raises.
        """
        host = row.onvif_host or (row.network_info or {}).get("ip")
        if not host:
            return
        driver = get_driver(row.brand)
        creds = self._creds_for(row)
        try:
            info = await driver.probe(host, creds)
            if not info.reachable:
                row.last_error = info.error
                return
            caps = await driver.get_capabilities(host, creds)
            row.status = "online"
            row.last_seen_at = _utcnow()
            row.last_error = None
            row.onvif_capabilities = {**(row.onvif_capabilities or {}), **caps.raw, **_caps_dict(caps)}
            row.ptz_capable = row.ptz_capable or caps.ptz
            # Enumerate channels → persist main/sub as MediaProfiles for channel 0.
            channels = await driver.enumerate_channels(host, creds)
            if channels:
                ch = channels[0]
                row.onvif_profile_token = row.onvif_profile_token or (
                    ch.main.profile_token if ch.main else None
                )
                await self._persist_channel_profiles(row.id, row.tenant_id, ch)
                # Record the last-known SUB (web) codec for the badge + policy gate.
                if ch.sub is not None and ch.sub.codec:
                    row.sub_stream_codec = ch.sub.codec.upper()
        except Exception as exc:  # noqa: BLE001 — probe must never break create
            log.info("probe-on-create failed for camera %s (%s): %s", row.id, host, exc)
            row.last_error = str(exc)
        finally:
            await driver.aclose()

    async def _persist_channel_profiles(self, camera_id: str, tenant_id, channel) -> None:
        """Upsert main/sub MediaProfiles for a driver ``Channel`` (idempotent by name)."""
        existing = {p.name: p for p in await self._profiles(camera_id)}
        for pname, sinfo in (("main", channel.main), ("sub", channel.sub)):
            if sinfo is None:
                continue
            row = existing.get(pname)
            if row is None:
                row = MediaProfile(camera_id=camera_id, tenant_id=tenant_id, name=pname)
                self.db.add(row)
            row.codec = sinfo.codec or row.codec
            row.resolution = sinfo.resolution or row.resolution
            row.fps = sinfo.fps or row.fps
            row.rtsp_path = sinfo.stream_url or row.rtsp_path
            row.bitrate = sinfo.bitrate or row.bitrate

    # ── CRUD ────────────────────────────────────────────────────────────
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
            pos_overlay=body.advanced.pos_overlay,
            dewarp=body.advanced.dewarp,
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

        # Best-effort device probe to auto-fill capabilities/profiles/PTZ.
        if probe:
            await self._autofill_from_device(row)

        await self.db.commit()
        await self.db.refresh(row)

        await self._publish_lifecycle(row, "registered")
        await self._publish_status(row)
        # Non-blocking: force the web (sub) stream to H.264 if policy on + sub is H.265.
        self._schedule_web_codec_enforcement(row.id)
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
            assert_owned(grp, self.scope, message="Camera group not found")
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
            row.pos_overlay = a.pos_overlay
            row.dewarp = a.dewarp
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
            assert_owned(grp, self.scope, message="Camera group not found")
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

    # ── discovery / onboarding helpers (driver-backed, graceful) ─────────
    async def discover(self, *, brand: str | None, network: str | None) -> list[dict]:
        driver = get_driver(brand)
        try:
            found = await driver.discover(network)
        except Exception as exc:  # noqa: BLE001 — discover must never 500
            log.info("discover failed (brand=%s net=%s): %s", brand, network, exc)
            found = []
        finally:
            await driver.aclose()
        return [_discovered_dict(d) for d in found]

    async def probe(self, *, host, port, username, password, brand):
        driver = get_driver(brand)
        creds = Credentials(username=username or "admin", password=password or "", port=port or 80)
        try:
            info = await driver.probe(host, creds)
            caps = await driver.get_capabilities(host, creds) if info.reachable else None
        except Exception as exc:  # noqa: BLE001
            log.info("probe failed (%s): %s", host, exc)
            return {"reachable": False, "error": str(exc)}
        finally:
            await driver.aclose()
        out = _deviceinfo_dict(info)
        out["capabilities"] = _caps_dict(caps) if caps else {}
        return out

    async def enumerate_channels(self, *, host, port, username, password, brand):
        driver = get_driver(brand)
        creds = Credentials(username=username or "admin", password=password or "", port=port or 80)
        try:
            channels = await driver.enumerate_channels(host, creds)
        except Exception as exc:  # noqa: BLE001
            log.info("channels failed (%s): %s", host, exc)
            channels = []
        finally:
            await driver.aclose()
        return [_channel_dict(c) for c in channels]

    async def snapshot(self, *, host, port, username, password, brand) -> bytes | None:
        driver = get_driver(brand)
        creds = Credentials(username=username or "admin", password=password or "", port=port or 80)
        try:
            return await driver.get_snapshot(host, creds)
        except Exception as exc:  # noqa: BLE001
            log.info("snapshot failed (%s): %s", host, exc)
            return None
        finally:
            await driver.aclose()

    async def snapshot_for(self, camera_id: str) -> bytes | None:
        """A JPEG snapshot for a camera — cached ~30s, with a live-stream fallback.

        Order:
          1. Serve a fresh cached frame if we have one (bounds ffmpeg spawns + the
             MediaMTX on-demand activation the grid would otherwise trigger 16×).
          2. Try the driver's ONVIF ``GetSnapshotUri`` → HTTP JPEG (fast when it
             works — direct cameras).
          3. Fall back to grabbing ONE frame off the live MediaMTX path with ffmpeg
             (``cameras/<tenant>/<cam>/sub``) — codec-agnostic, so it works for the
             NVR-channel H.265/H.264 cameras where ONVIF snapshot fails.

        Returns ``None`` when neither source yields a frame (→ the router 502s and the
        frontend shows its placeholder). Never raises.
        """
        row = await self._row(camera_id)

        # 1) cache — serve the last frame from EITHER source if still fresh.
        cached = snapshot_frame.cache_get(camera_id, "sub")
        if cached is not None:
            return cached

        # 2) driver ONVIF snapshot (fast path — works for direct cameras).
        host = row.onvif_host or (row.network_info or {}).get("ip")
        if host:
            driver = get_driver(row.brand)
            try:
                jpeg = await driver.get_snapshot(
                    host, self._creds_for(row), profile=row.onvif_profile_token
                )
            except Exception as exc:  # noqa: BLE001
                log.info("snapshot(camera=%s) ONVIF failed: %s", camera_id, exc)
                jpeg = None
            finally:
                await driver.aclose()
            if jpeg:
                snapshot_frame.cache_put(camera_id, "sub", jpeg)
                return jpeg

        # 3) fallback — grab a frame off the live MediaMTX stream (sub profile).
        #
        # The MediaMTX path is on-demand: it only exists once the Go nvr has been asked
        # to "ensure" it (which configures the source = the camera's RTSP URL). A raw
        # read of an un-provisioned path is a 400. So we mirror the live-view control
        # flow — build the RTSP source (LiveService, decrypts creds) → nvr ensure → then
        # pull one frame from the now-live MediaMTX path. All best-effort: any failure
        # degrades to None. The path is left up (its idle-close timer reaps it).
        jpeg = await self._snapshot_from_mediamtx(row)
        if jpeg:
            snapshot_frame.cache_put(camera_id, "sub", jpeg)
            return jpeg
        return None

    async def _snapshot_from_mediamtx(self, row: Camera) -> bytes | None:
        """Ensure the camera's ``sub`` MediaMTX path is up, then grab one JPEG frame.

        Reuses ``LiveService`` (RTSP-source derivation + nvr ensure) so the snapshot
        pulls from exactly the same on-demand path live view uses — codec-agnostic
        (H.264/H.265). Never raises; returns ``None`` on any failure.
        """
        from app.vms.live.service import LiveService, LiveUpstreamError

        profile = "sub"
        live = LiveService(self.db, self.scope, bearer=self.bearer)
        # Bring the on-demand path up (idempotent on the nvr/MediaMTX side).
        try:
            rtsp_source = await live._rtsp_source_for(row, profile)  # noqa: SLF001
            if not rtsp_source:
                log.info("snapshot(camera=%s): no RTSP source derivable", row.id)
                return None
            await live.nvr.ensure_stream(
                camera_id=row.id, rtsp_url=rtsp_source, profile=profile
            )
        except (LiveUpstreamError, Exception) as exc:  # noqa: BLE001
            # nvr unreachable / MediaMTX upstream error — degrade to None (502 upstream).
            log.info("snapshot(camera=%s): ensure-stream failed: %s", row.id, exc)
            return None

        # Now read one frame from the (freshly ensured) MediaMTX path.
        path = snapshot_frame.mediamtx_path(row.tenant_id, row.id, profile)
        rtsp_url = f"{snapshot_frame.rtsp_base()}/{path}"
        return await snapshot_frame.grab_frame(rtsp_url)

    async def bulk_add(
        self, *, host, port, username, password, brand, channels, actor
    ) -> CameraListResponse:
        """Create N cameras (one per supplied channel) in ONE transaction.

        Each channel gets an ``onvif_profile_token`` + ``nvr_channel_number``; the
        driver is probed once for stream-uris (graceful if unreachable → cameras
        persist with ``status='connecting'``). This is the multi-channel NVR/DVR
        onboarding primitive the NVR module (P1-E) reuses.
        """
        driver = get_driver(brand)
        creds = Credentials(username=username or "admin", password=password or "", port=port or 80)

        # One enumeration to enrich stream-uris (best-effort; may be empty). Index it by
        # EVERY stable key so a per-channel spec matches regardless of which identifier the
        # caller sent — source/profile token (most stable), the ONVIF channel_number hint,
        # or the sequential channel index. Matching ONLY by ch.channel (1,2,3…) missed
        # single-channel maps (idx=0) → cameras created with NO MediaProfiles → no stream.
        enum_by_ch: dict[int, Any] = {}
        enum_by_num: dict[int, Any] = {}
        enum_by_token: dict[str, Any] = {}
        try:
            for ch in await driver.enumerate_channels(host, creds):
                enum_by_ch[ch.channel] = ch
                if getattr(ch, "channel_number", None) is not None:
                    enum_by_num.setdefault(ch.channel_number, ch)
                if getattr(ch, "source_token", None):
                    enum_by_token.setdefault(str(ch.source_token), ch)
                for prof in (getattr(ch, "main", None), getattr(ch, "sub", None)):
                    tok = getattr(prof, "profile_token", None)
                    if tok:
                        enum_by_token.setdefault(str(tok), ch)
        except Exception as exc:  # noqa: BLE001
            log.info("bulk-add enumerate failed (%s): %s", host, exc)
        finally:
            await driver.aclose()

        actor_id = _actor_id(actor)
        enc_pass = encrypt_secret(password) if password else None
        created: list[Camera] = []
        base_order = int(
            await self.db.scalar(
                scoped(select(func.coalesce(func.max(Camera.display_order), 0)), Camera, self.scope)
            )
            or 0
        )

        for idx, spec in enumerate(channels):
            ch_no = spec.channel_number if spec.channel_number is not None else idx + 1
            name = spec.name or f"{host} — CH{ch_no}"
            dup = await self.db.scalar(
                scoped(select(Camera), Camera, self.scope).where(Camera.name == name)
            )
            if dup is not None:
                # NVR channels routinely share generic names ("Channel 1") across
                # different recorders, so mapping a second NVR must not hard-fail on
                # a name clash — auto-disambiguate with an NVR-scoped suffix. Only the
                # explicit single-camera add path keeps the hard error (user typed it).
                if spec.nvr_id:
                    stem = name
                    n = 2
                    while dup is not None:
                        name = f"{stem} ({n})"
                        dup = await self.db.scalar(
                            scoped(select(Camera), Camera, self.scope).where(Camera.name == name)
                        )
                        n += 1
                else:
                    raise ConflictError(f"a camera named '{name}' already exists")

            # Match the enumerated channel by token (stable) → channel_number → sequential
            # index. This is what populates MediaProfiles; a miss = a camera with no stream.
            probe_ch = (
                (enum_by_token.get(str(spec.profile_token)) if spec.profile_token else None)
                or (enum_by_num.get(spec.channel_number) if spec.channel_number is not None else None)
                or enum_by_ch.get(ch_no)
                or enum_by_ch.get(idx + 1)
                or enum_by_ch.get(idx)
            )
            profile_token = spec.profile_token or (
                probe_ch.main.profile_token if (probe_ch and probe_ch.main) else None
            )
            row = Camera(
                tenant_id=self.scope.tenant_id,
                name=name,
                is_enabled=True,
                status="connecting",
                brand=brand or "onvif",
                connection_type="nvr_channel" if spec.nvr_id else "onvif",
                network_info={"ip": host, "port": port or 80},
                onvif_host=host,
                onvif_port=port or 80,
                onvif_user=username or "admin",
                onvif_enc_pass=enc_pass,
                onvif_profile_token=profile_token,
                nvr_id=spec.nvr_id,
                nvr_channel_number=ch_no,
                site_id=spec.site_id,
                floor_id=spec.floor_id,
                display_order=base_order + idx + 1,
                created_by=actor_id,
                updated_by=actor_id,
            )
            self.db.add(row)
            await self.db.flush()
            if probe_ch is not None:
                await self._persist_channel_profiles(row.id, row.tenant_id, probe_ch)
                if probe_ch.sub is not None and probe_ch.sub.codec:
                    row.sub_stream_codec = probe_ch.sub.codec.upper()
            created.append(row)

        await self.db.commit()
        for row in created:
            await self.db.refresh(row)
            await self._publish_lifecycle(row, "registered")
            await self._publish_status(row)
            # Non-blocking web-codec enforcement per created channel (policy-gated).
            self._schedule_web_codec_enforcement(row.id)

        items = [await self._public(r) for r in created]
        return CameraListResponse(items=items, total=len(items), skip=0, limit=len(items))

    # ── config sub-resources (driver-backed; explicit ops MAY 502) ───────
    async def ptz(self, camera_id: str, cmd: PtzCommand) -> Any:
        row = await self._row(camera_id)
        host = row.onvif_host or (row.network_info or {}).get("ip")
        if not host:
            raise DriverError("camera has no reachable host configured")
        driver = get_driver(row.brand)
        try:
            result = await driver.ptz(host, self._creds_for(row), cmd)
            if cmd.action in ("set_preset", "delete_preset", "get_presets") and isinstance(result, list):
                row.ptz_presets = result
                await self.db.commit()
            return result
        finally:
            await driver.aclose()

    # ONVIF read-sections whose result we persist on the camera row so the UI serves
    # them instantly (no auto re-probe on every tab open); the operator re-reads on
    # demand via ``refresh=True`` (the panel's ↻/Reload). Writes always hit the device
    # AND refresh the cache with the echoed current state.
    _CACHEABLE_SECTIONS = {"imaging", "io", "encoder", "osd"}

    async def configure(
        self, camera_id: str, section: str, payload: dict, *, refresh: bool = False
    ) -> dict:
        row = await self._row(camera_id)
        is_read = not payload
        cacheable = section in self._CACHEABLE_SECTIONS

        # Serve a cached read instantly unless the caller forced a refresh.
        if cacheable and is_read and not refresh:
            cached = (row.onvif_capabilities or {}).get(section)
            if cached:
                return cached

        host = row.onvif_host or (row.network_info or {}).get("ip")
        if not host:
            raise DriverError("camera has no reachable host configured")
        driver = get_driver(row.brand)
        # For an NVR channel, imaging is per video-source — pass the channel index so the
        # driver targets THIS channel's source, not the recorder's first one.
        channel = row.nvr_channel_number if row.nvr_id else None
        try:
            result = await driver.configure(
                host, self._creds_for(row), section, payload, channel=channel
            )
        finally:
            await driver.aclose()

        # Persist the live result (both reads and writes echo the current device state)
        # so the next tab open is instant.
        if cacheable and isinstance(result, dict):
            caps = dict(row.onvif_capabilities or {})
            caps[section] = result
            row.onvif_capabilities = caps
            await self.db.commit()
        return result

    async def get_local_config(self, camera_id: str, section: str) -> dict:
        """Return a locally-persisted config section (motion/privacy/onvif-events)."""
        row = await self._row(camera_id)
        if section == "motion_config":
            return {"motion_config": row.motion_config or {}}
        if section == "privacy_masks":
            return {"privacy_masks": row.privacy_masks or []}
        if section == "motion_zones":
            return {"motion_zones": row.motion_zones or []}
        if section == "onvif_events":
            return {"onvif_events": (row.onvif_capabilities or {}).get("_events_config", {})}
        raise ValidationError(f"unknown local config section: {section}")

    async def put_local_config(self, camera_id: str, section: str, value) -> dict:
        """Persist a config section locally (event ingestion at scale = Go nvr P5).

        ``privacy_masks`` / ``motion_zones`` are ALWAYS stored locally (the local
        catalog is source-of-truth for the G5 draw tool), then best-effort pushed to
        the device via the driver ``configure`` seam. The push NEVER blocks or fails
        the save — the echo carries ``pushed`` (True | False) + ``push_error`` so the
        UI can surface store-only vs applied-on-device per brand.
        """
        row = await self._row(camera_id)
        push_section: str | None = None
        if section == "motion_config":
            row.motion_config = value or {}
            out = {"motion_config": row.motion_config}
        elif section == "privacy_masks":
            row.privacy_masks = value or []
            out = {"privacy_masks": row.privacy_masks}
            push_section = "privacy_masks"
        elif section == "motion_zones":
            row.motion_zones = value or []
            out = {"motion_zones": row.motion_zones}
            push_section = "motion_zones"
        elif section == "onvif_events":
            caps = dict(row.onvif_capabilities or {})
            caps["_events_config"] = value or {}
            row.onvif_capabilities = caps
            out = {"onvif_events": caps["_events_config"]}
        else:
            raise ValidationError(f"unknown local config section: {section}")
        row.updated_at = _utcnow()
        await self.db.commit()

        # Best-effort device push for the drawn regions (graceful — never raises).
        if push_section is not None:
            pushed, push_error = await self._push_regions(row, push_section, value or [])
            out["pushed"] = pushed
            if push_error:
                out["push_error"] = push_error
        return out

    async def _push_regions(self, row: Camera, section: str, value) -> tuple[bool, str | None]:
        """Push privacy_masks / motion_zones to the device via ``driver.configure``.

        Graceful: returns ``(False, error)`` when no host / driver missing / device
        unreachable / brand doesn't support the region config — the local save already
        succeeded. Returns ``(True, None)`` when the driver reports the write applied.
        """
        host = row.onvif_host or (row.network_info or {}).get("ip")
        if not host:
            return False, "camera has no reachable host configured"
        driver = get_driver(row.brand)
        try:
            result = await driver.configure(host, self._creds_for(row), section, {section: value})
            return bool((result or {}).get("applied", True)), None
        except DriverError as exc:
            log.info("region push (%s) failed for camera %s: %s", section, row.id, exc)
            return False, str(exc)
        except Exception as exc:  # noqa: BLE001 — push must never break the local save
            log.info("region push (%s) errored for camera %s: %s", section, row.id, exc)
            return False, str(exc)
        finally:
            await driver.aclose()

    # ── stream codec policy (G8 — zero-transcode live view) ──────────────
    #
    # Force the SUB (web-viewing) stream to H.264 at the device so browsers play live with
    # zero transcode (main stays H.265 for storage-efficient recording). The H.265→H.264
    # transcode fallback (mediamtx /h264 + LivePlayer) STAYS as a safety net for devices
    # that can't be reconfigured — this only avoids the transcode where the device CAN.

    async def _apply_stream_policy_row(self, row: Camera, *, force: bool = False) -> dict:
        """Probe the sub codec + push it to H.264 via the driver, persisting the outcome.

        Returns a JSON-safe result dict {ok, supported, status, sub_codec, detail}. Never
        raises — driver failures degrade to ``ok=False``. ``force=True`` pushes even if the
        last-known sub codec is already H.264 (re-assert); default skips an H.264 sub.

        Statuses: ``applied`` (pushed to H.264), ``already_h264`` (skipped — no churn),
        ``unsupported`` (brand/NVR can't set the codec), ``unreachable`` (no host / down),
        ``failed`` (op ran, device rejected).
        """
        host = row.onvif_host or (row.network_info or {}).get("ip")
        if not host:
            return {"ok": False, "supported": True, "status": "unreachable",
                    "sub_codec": row.sub_stream_codec, "detail": "camera has no reachable host configured"}
        driver = get_driver(row.brand)
        creds = self._creds_for(row)
        try:
            # 1) Probe the current per-stream codecs (refreshes the badge + gates the push).
            sub_codec = row.sub_stream_codec
            try:
                codecs = await driver.get_stream_codecs(host, creds)
                for c in codecs:
                    if c.role == WEB_STREAM_ROLE and c.codec:
                        sub_codec = c.codec.upper()
                        break
            except Exception as exc:  # noqa: BLE001 — probe must not break the apply
                log.info("stream-codec probe failed for camera %s: %s", row.id, exc)
            if sub_codec:
                row.sub_stream_codec = sub_codec

            # 2) Skip when already H.264 (unless forced) — zero-churn on compliant devices.
            if not force and sub_codec and sub_codec.upper() == "H264":
                await self.db.commit()
                return {"ok": True, "supported": True, "status": "already_h264",
                        "sub_codec": sub_codec, "detail": "sub stream already H.264 (no transcode)"}

            # 3) Push sub → H.264 at the device (best-effort, graceful per brand).
            res = await driver.set_stream_codec(host, creds, profile=WEB_STREAM_ROLE, codec="h264")
            if res.ok:
                row.sub_stream_codec = "H264"
                row.web_codec_enforced_at = _utcnow()
                status = "already_h264" if (res.data or {}).get("already") else "applied"
            elif not res.supported:
                status = "unsupported"
            else:
                status = "failed"
            await self.db.commit()
            return {"ok": res.ok, "supported": res.supported, "status": status,
                    "sub_codec": row.sub_stream_codec, "detail": res.detail}
        except Exception as exc:  # noqa: BLE001 — never raise from the policy apply
            log.info("apply_stream_policy errored for camera %s: %s", row.id, exc)
            return {"ok": False, "supported": True, "status": "failed",
                    "sub_codec": row.sub_stream_codec, "detail": str(exc)}
        finally:
            await driver.aclose()

    async def apply_stream_policy(self, camera_id: str, *, force: bool = False) -> dict:
        """Manual apply (existing camera): push sub → H.264. Tenant-scoped + owned."""
        row = await self._row(camera_id)
        out = await self._apply_stream_policy_row(row, force=force)
        return {"camera_id": row.id, "camera_name": row.name, **out}

    async def bulk_apply_stream_policy(self, camera_ids: list[str], *, force: bool = False) -> dict:
        """Bulk apply — mirror the G7 fleet bulk contract (per-camera results, tenant
        isolation via scoped id-filter, one failure never aborts the batch)."""
        stmt = scoped(select(Camera), Camera, self.scope).where(Camera.id.in_(camera_ids))
        rows = {r.id: r for r in (await self.db.execute(stmt)).scalars().all()}
        ordered = [rows[cid] for cid in camera_ids if cid in rows]
        items: list[dict] = []
        succeeded = 0
        for row in ordered:
            res = await self._apply_stream_policy_row(row, force=force)
            if res["ok"]:
                succeeded += 1
            items.append({"camera_id": row.id, "camera_name": row.name, **res})
        return {"action": "apply-stream-policy", "total": len(items), "succeeded": succeeded, "items": items}

    async def _maybe_enforce_web_codec(self, camera_id: str) -> None:
        """Onboard auto-enforce hook — runs in a DETACHED task with a FRESH DB session so
        it NEVER blocks or fails the onboard. Gated by the policy flag + skips a sub
        already on H.264. Best-effort + logged; the camera row is already committed."""
        if not enforce_h264_web():
            return
        from app.db import get_sessionmaker

        try:
            async with get_sessionmaker()() as session:
                svc = CameraService(session, self.scope)
                row = await session.get(Camera, camera_id)
                if row is None:
                    return
                # Only push when the probed sub codec is known-not-H.264 (no churn / no
                # blind push against an unknown device).
                if not needs_web_codec_enforcement(row.sub_stream_codec):
                    return
                res = await svc._apply_stream_policy_row(row)
                log.info(
                    "auto-enforce H.264 web on camera %s: status=%s detail=%s",
                    camera_id, res.get("status"), res.get("detail"),
                )
        except Exception as exc:  # noqa: BLE001 — the hook must never surface
            log.info("auto-enforce web codec errored for camera %s: %s", camera_id, exc)

    def _schedule_web_codec_enforcement(self, camera_id: str) -> None:
        """Spawn the non-blocking onboard auto-enforce task (fire-and-forget)."""
        if not enforce_h264_web():
            return
        try:
            task = asyncio.create_task(self._maybe_enforce_web_codec(camera_id))
            # Keep a ref so the task isn't GC'd mid-flight; drop it on completion.
            self._bg_tasks.add(task)
            task.add_done_callback(self._bg_tasks.discard)
        except RuntimeError:
            # No running loop (shouldn't happen under FastAPI) — skip silently.
            log.debug("no event loop for web-codec enforcement of camera %s", camera_id)

    # ── per-camera ACL (VMS-owned, keyed on core subject ids) ────────────
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
