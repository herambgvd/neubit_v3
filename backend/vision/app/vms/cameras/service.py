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

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ConflictError, ValidationError

from app.vms.common.crypto import decrypt_secret, encrypt_secret
from app.vms.common.events import emit_camera_lifecycle, emit_camera_status
from app.vms.drivers import Credentials, DriverError, PtzCommand, get_driver
from app.vms.models import Camera, CameraACL, CameraGroup, MediaProfile

from app.vms.groups.schemas import CameraACLPublic
from .schemas import (
    CameraCreate,
    CameraListResponse,
    CameraPublic,
    CameraUpdate,
)

log = logging.getLogger("vision.service")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


class CameraService:
    """Tenant-scoped CRUD + driver-backed onboarding over ``cameras``."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

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
            privacy_masks=body.advanced.privacy_masks,
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
        if body.advanced is not None:
            a = body.advanced
            row.privacy_masks = a.privacy_masks
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
    async def bulk(self, camera_ids: list[str], action: str, *, group_id, retention_days, actor):
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

        for r in rows:
            if action == "enable":
                r.is_enabled = True
            elif action == "disable":
                r.is_enabled = False
            elif action == "retention":
                if retention_days is None:
                    raise ValidationError("retention_days required for the retention action")
                r.retention_days = retention_days
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
        row = await self._row(camera_id)
        host = row.onvif_host or (row.network_info or {}).get("ip")
        if not host:
            return None
        driver = get_driver(row.brand)
        try:
            return await driver.get_snapshot(host, self._creds_for(row), profile=row.onvif_profile_token)
        except Exception as exc:  # noqa: BLE001
            log.info("snapshot(camera=%s) failed: %s", camera_id, exc)
            return None
        finally:
            await driver.aclose()

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

        # One enumeration to enrich stream-uris (best-effort; may be empty).
        enum_by_ch: dict[int, Any] = {}
        try:
            for ch in await driver.enumerate_channels(host, creds):
                enum_by_ch[ch.channel] = ch
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
                raise ConflictError(f"a camera named '{name}' already exists")

            probe_ch = enum_by_ch.get(ch_no) or enum_by_ch.get(idx)
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
            created.append(row)

        await self.db.commit()
        for row in created:
            await self.db.refresh(row)
            await self._publish_lifecycle(row, "registered")
            await self._publish_status(row)

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

    async def configure(self, camera_id: str, section: str, payload: dict) -> dict:
        row = await self._row(camera_id)
        host = row.onvif_host or (row.network_info or {}).get("ip")
        if not host:
            raise DriverError("camera has no reachable host configured")
        driver = get_driver(row.brand)
        try:
            return await driver.configure(host, self._creds_for(row), section, payload)
        finally:
            await driver.aclose()

    async def get_local_config(self, camera_id: str, section: str) -> dict:
        """Return a locally-persisted config section (motion/privacy/onvif-events)."""
        row = await self._row(camera_id)
        if section == "motion_config":
            return {"motion_config": row.motion_config or {}}
        if section == "privacy_masks":
            return {"privacy_masks": row.privacy_masks or []}
        if section == "onvif_events":
            return {"onvif_events": (row.onvif_capabilities or {}).get("_events_config", {})}
        raise ValidationError(f"unknown local config section: {section}")

    async def put_local_config(self, camera_id: str, section: str, value) -> dict:
        """Persist a config section locally (event ingestion at scale = Go nvr P5)."""
        row = await self._row(camera_id)
        if section == "motion_config":
            row.motion_config = value or {}
            out = {"motion_config": row.motion_config}
        elif section == "privacy_masks":
            row.privacy_masks = value or []
            out = {"privacy_masks": row.privacy_masks}
        elif section == "onvif_events":
            caps = dict(row.onvif_capabilities or {})
            caps["_events_config"] = value or {}
            row.onvif_capabilities = caps
            out = {"onvif_events": caps["_events_config"]}
        else:
            raise ValidationError(f"unknown local config section: {section}")
        row.updated_at = _utcnow()
        await self.db.commit()
        return out

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
