"""NVR-onboarding service — tenant-scoped CRUD + driver-backed estate ops.

The NVR counterpart to ``CameraService`` (order-critical: the client owns mixed-brand
NVRs/DVRs — connect, enumerate channels, monitor health; footage/playback extraction
is P4). Mirrors the camera service discipline exactly:

  * every read goes through ``kernel.auth.scoped``; every by-id fetch through
    ``assert_owned``; new rows are stamped with the caller's ``tenant_id``.
  * NVR credentials are stored REVERSIBLY encrypted (``vms.common.crypto``) in
    ``enc_creds`` — decrypted only to build a driver ``Credentials`` in-memory, never
    persisted plain.
  * graceful-on-unreachable throughout (no live NVRs in dev): probe/discover/channels
    go through the driver, which returns empty/None on failure — the service NEVER 500s.
    A create against an unreachable host lands at ``status='connecting'``.

Channel → camera mapping (``map_channels``) REUSES ``CameraService.bulk_add`` — the
multi-channel onboarding primitive already used by ONVIF bulk-add — so a channel-camera
gets ``connection_type='nvr_channel'``, ``nvr_id``, ``nvr_channel_number``,
``onvif_profile_token`` + probed MediaProfiles, and each publishes ``device.camera.registered``.
Mapping is IDEMPOTENT: a channel already mapped (same ``nvr_id`` + ``nvr_channel_number``)
is skipped, not double-created.

Delete ORPHANS the channel-cameras (their ``nvr_id`` is ``ON DELETE SET NULL`` in the
model) rather than deleting them, then publishes ``device.nvr.deregistered``.

Onboarding publishes on the NATS spine (``app.vms.common.events``):
  * create → ``device.nvr.registered`` + ``vms.nvr.status``.
  * update → ``device.nvr.updated`` (+ ``vms.nvr.status`` on a status change).
  * refresh/status change → ``device.nvr.status`` + ``vms.nvr.status``.
  * delete → ``device.nvr.deregistered``.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import func, or_, select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ConflictError

from app.vms.common.crypto import decrypt_secret, encrypt_secret
from app.vms.common.events import emit_nvr_lifecycle, emit_nvr_status
from app.vms.drivers import Credentials, get_driver
from app.vms.models import NVR, Camera

from app.vms.cameras.schemas import BulkAddChannel
from app.vms.cameras.service import CameraService, _channel_dict, _discovered_dict
from .schemas import (
    MapChannelsResult,
    NvrCreate,
    NvrHealthResponse,
    NvrListResponse,
    NvrPublic,
    NvrUpdate,
)

log = logging.getLogger("vision.nvr_service")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


class NvrService:
    """Tenant-scoped CRUD + driver-backed onboarding over ``nvrs``."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope
        # Reuse the camera service for the channel → camera creation path (map-channels).
        self.cameras = CameraService(db, scope)

    # ── row + credential helpers ────────────────────────────────────────
    async def _row(self, nvr_id: str) -> NVR:
        row = await self.db.get(NVR, nvr_id)
        assert_owned(row, self.scope, message="NVR not found")
        return row

    def _creds_for(self, row: NVR) -> Credentials:
        """Build a driver ``Credentials`` from a stored NVR row (decrypting the secret)."""
        return Credentials(
            username=row.username or "admin",
            password=decrypt_secret(row.enc_creds) or "",
            port=row.port or 80,
        )

    async def _mapped_channel_count(self, nvr_id: str) -> int:
        return int(
            await self.db.scalar(
                scoped(select(func.count()).select_from(Camera), Camera, self.scope).where(
                    Camera.nvr_id == nvr_id
                )
            )
            or 0
        )

    async def _public(self, row: NVR) -> NvrPublic:
        return NvrPublic.from_row(row)

    # ── probe-on-create / refresh (best-effort estate autofill) ──────────
    async def _probe_into(self, row: NVR) -> None:
        """Probe the NVR via its driver → fill status/channel_count/capabilities/storage.

        Graceful: any failure (unreachable, driver missing) leaves the row at
        ``status='connecting'`` with the last error recorded — NEVER raises.
        """
        driver = get_driver(row.brand)
        creds = self._creds_for(row)
        try:
            info = await driver.probe(row.host, creds)
            if not info.reachable:
                row.status = "connecting"
                row.last_error = info.error
                return
            caps = await driver.get_capabilities(row.host, creds)
            row.status = "online"
            row.last_seen_at = _utcnow()
            row.last_error = None
            if info.channel_count:
                row.channel_count = info.channel_count
            row.capabilities = {**(row.capabilities or {}), **_caps_dict(caps), **(caps.raw or {})}
            # Identity + coarse storage hints go into storage_info/version blobs.
            row.version_info = {
                **(row.version_info or {}),
                "manufacturer": info.manufacturer,
                "model": info.model,
                "firmware": info.firmware,
                "serial_number": info.serial_number,
            }
        except Exception as exc:  # noqa: BLE001 — probe must never break create/refresh
            log.info("NVR probe failed for %s (%s): %s", row.id, row.host, exc)
            row.status = "connecting"
            row.last_error = str(exc)
        finally:
            await driver.aclose()

    # ── CRUD ────────────────────────────────────────────────────────────
    async def create(self, body: NvrCreate, *, actor, probe: bool = True) -> NvrPublic:
        # Name is unique within the caller's tenant (like camera/instance names).
        dup = await self.db.scalar(
            scoped(select(NVR), NVR, self.scope).where(NVR.name == body.name)
        )
        if dup is not None:
            raise ConflictError("an NVR with this name already exists")

        actor_id = _actor_id(actor)
        row = NVR(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            is_enabled=body.is_enabled,
            brand=body.brand,
            driver=body.driver,
            host=body.host,
            port=body.port,
            username=body.username or "",
            enc_creds=encrypt_secret(body.password) if body.password else None,
            channel_count=body.channel_count,
            status="connecting",
            created_by=actor_id,
            updated_by=actor_id,
        )
        self.db.add(row)
        await self.db.flush()

        if probe:
            await self._probe_into(row)

        await self.db.commit()
        await self.db.refresh(row)

        await emit_nvr_lifecycle(row.tenant_id, "registered", _lifecycle_payload(row))
        await emit_nvr_status(row.tenant_id, _status_payload(row))
        return await self._public(row)

    async def list_(
        self,
        *,
        skip: int = 0,
        limit: int = 50,
        status: str | None = None,
        brand: str | None = None,
        q: str | None = None,
    ) -> NvrListResponse:
        stmt = scoped(select(NVR), NVR, self.scope)
        count_stmt = scoped(select(func.count()).select_from(NVR), NVR, self.scope)

        def _filters(s):
            if status:
                s = s.where(NVR.status == status)
            if brand:
                s = s.where(NVR.brand == brand)
            if q:
                term = f"%{q}%"
                s = s.where(or_(NVR.name.ilike(term), NVR.host.ilike(term)))
            return s

        stmt = _filters(stmt).order_by(NVR.created_at.desc()).offset(skip).limit(limit)
        count_stmt = _filters(count_stmt)

        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count_stmt) or 0)
        return NvrListResponse(
            items=[NvrPublic.from_row(r) for r in rows], total=total, skip=skip, limit=limit
        )

    async def get(self, nvr_id: str) -> NvrPublic:
        return await self._public(await self._row(nvr_id))

    async def update(self, nvr_id: str, body: NvrUpdate, *, actor) -> NvrPublic:
        row = await self._row(nvr_id)
        prev_status = row.status
        data = body.model_dump(exclude_unset=True)

        if "name" in data and data["name"] != row.name:
            dup = await self.db.scalar(
                scoped(select(NVR), NVR, self.scope).where(
                    NVR.name == data["name"], NVR.id != row.id
                )
            )
            if dup is not None:
                raise ConflictError("an NVR with this name already exists")

        for k in ("name", "is_enabled", "brand", "driver", "host", "port", "channel_count"):
            if k in data and data[k] is not None:
                setattr(row, k, data[k])
        if "username" in data and data["username"] is not None:
            row.username = data["username"]
        # Rotate the credential only when a password is explicitly supplied.
        if "password" in data and data["password"] is not None:
            row.enc_creds = encrypt_secret(data["password"]) if data["password"] else None

        actor_id = _actor_id(actor)
        if actor_id:
            row.updated_by = actor_id
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)

        await emit_nvr_lifecycle(row.tenant_id, "updated", _lifecycle_payload(row))
        if row.status != prev_status:
            await emit_nvr_status(row.tenant_id, _status_payload(row))
        return await self._public(row)

    async def delete(self, nvr_id: str, *, actor) -> None:
        """Delete the NVR row + ORPHAN its channel-cameras (nvr_id → NULL).

        The ``Camera.nvr_id`` FK is ``ON DELETE SET NULL`` in the model, so the
        channel-cameras survive — but their ``connection_type`` still reads
        ``nvr_channel`` and the operator can re-home/re-map them. We proactively NULL
        the FK before deleting (rather than relying solely on the DB cascade) so the
        behaviour is explicit + testable across backends. The channel-cameras are NOT
        deleted and NOT deregistered; only the NVR publishes ``device.nvr.deregistered``.
        """
        row = await self._row(nvr_id)
        tenant_id = row.tenant_id
        payload = _lifecycle_payload(row)

        # Orphan channel-cameras: nvr_id → NULL (explicit, tenant-scoped).
        await self.db.execute(
            scoped(sa_update(Camera), Camera, self.scope)
            .where(Camera.nvr_id == nvr_id)
            .values(nvr_id=None, updated_at=_utcnow())
        )
        await self.db.delete(row)
        await self.db.commit()
        await emit_nvr_lifecycle(tenant_id, "deregistered", payload)

    # ── discovery (driver-backed, graceful, NVR-filtered) ────────────────
    async def discover(self, *, brand: str | None, network: str | None) -> list[dict]:
        """Discover devices on the LAN, filtered to NVR-type candidates. Never 500s.

        Discovery is coarse (WS-Discovery / subnet-scan surfaces both cameras and NVRs).
        We keep candidates whose reported channel-count > 1 or whose model/name looks
        like a recorder (NVR/DVR/XVR). If a brand-specific driver can't discern, we
        return everything it found (graceful — the operator picks).
        """
        driver = get_driver(brand)
        try:
            found = await driver.discover(network)
        except Exception as exc:  # noqa: BLE001 — discover must never 500
            log.info("NVR discover failed (brand=%s net=%s): %s", brand, network, exc)
            found = []
        finally:
            await driver.aclose()
        out = [_discovered_dict(d) for d in found if _looks_like_nvr(d)]
        return out

    # ── channel enumeration (saved NVR + unsaved host) ───────────────────
    async def enumerate_channels(self, nvr_id: str) -> list[dict]:
        """Enumerate a SAVED NVR's channels (reads host/creds off the row). Never 500s."""
        row = await self._row(nvr_id)
        return await self._enumerate(row.brand, row.host, self._creds_for(row))

    async def enumerate_channels_host(
        self, *, host: str, port: int, username: str, password: str, brand: str | None
    ) -> list[dict]:
        """Enumerate an UNSAVED host's channels (pre-onboard preview). Never 500s."""
        creds = Credentials(username=username or "admin", password=password or "", port=port or 80)
        return await self._enumerate(brand, host, creds)

    async def _enumerate(self, brand: str | None, host: str, creds: Credentials) -> list[dict]:
        driver = get_driver(brand)
        try:
            channels = await driver.enumerate_channels(host, creds)
        except Exception as exc:  # noqa: BLE001 — enumerate must never 500
            log.info("NVR channels failed (%s): %s", host, exc)
            channels = []
        finally:
            await driver.aclose()
        return [_channel_dict(c) for c in channels]

    # ── map channels → cameras (reuses CameraService.bulk_add; idempotent) ─
    async def map_channels(self, nvr_id: str, channels: list, *, actor) -> MapChannelsResult:
        """Create a channel-camera per SELECTED channel (``add=True``), skipping any
        channel already mapped to this NVR. Reuses ``CameraService.bulk_add`` so each
        channel-camera gets ``connection_type='nvr_channel'`` + ``nvr_id`` +
        ``nvr_channel_number`` + ``onvif_profile_token`` + probed MediaProfiles, and
        publishes ``device.camera.registered``. Idempotent."""
        row = await self._row(nvr_id)

        # Existing mapped channel numbers for this NVR (idempotency guard).
        existing = set(
            (
                await self.db.execute(
                    scoped(select(Camera.nvr_channel_number), Camera, self.scope).where(
                        Camera.nvr_id == nvr_id
                    )
                )
            )
            .scalars()
            .all()
        )

        selected = [c for c in channels if getattr(c, "add", True)]
        to_add: list[BulkAddChannel] = []
        skipped = 0
        for c in selected:
            if c.channel_number in existing:
                skipped += 1
                continue
            to_add.append(
                BulkAddChannel(
                    channel_number=c.channel_number,
                    name=c.name or f"{row.name} — CH{c.channel_number}",
                    profile_token=c.profile_token,
                    nvr_id=nvr_id,
                    site_id=c.site_id,
                    floor_id=c.floor_id,
                )
            )

        created_public = []
        if to_add:
            # Decrypt the NVR's own creds to probe stream-uris for the new channel-cameras.
            creds = self._creds_for(row)
            result = await self.cameras.bulk_add(
                host=row.host,
                port=row.port,
                username=creds.username,
                password=creds.password,
                brand=row.brand,
                channels=to_add,
                actor=actor,
            )
            created_public = result.items

        await self.db.refresh(row)
        return MapChannelsResult(
            created=created_public,
            created_count=len(created_public),
            skipped_count=skipped,
            nvr=await self._public(row),
        )

    # ── health + refresh ─────────────────────────────────────────────────
    async def health(self, nvr_id: str) -> NvrHealthResponse:
        """Current health snapshot (no live probe — reads the stored status/estate)."""
        row = await self._row(nvr_id)
        return NvrHealthResponse(
            nvr_id=row.id,
            status=row.status,
            is_enabled=row.is_enabled,
            channel_count=row.channel_count,
            mapped_channel_count=await self._mapped_channel_count(row.id),
            storage_info=row.storage_info or {},
            capabilities=row.capabilities or {},
            last_seen_at=row.last_seen_at,
            last_error=row.last_error,
        )

    async def refresh(self, nvr_id: str, *, actor) -> NvrPublic:
        """Re-probe the NVR → update status/channel_count/capabilities/last_seen_at.
        Publishes ``device.nvr.status`` + ``vms.nvr.status`` on a status change."""
        row = await self._row(nvr_id)
        prev_status = row.status
        await self._probe_into(row)
        actor_id = _actor_id(actor)
        if actor_id:
            row.updated_by = actor_id
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)

        await emit_nvr_lifecycle(row.tenant_id, "status", _status_payload(row))
        if row.status != prev_status:
            await emit_nvr_status(row.tenant_id, _status_payload(row))
        return await self._public(row)


# ── helpers ──────────────────────────────────────────────────────────────


def _looks_like_nvr(d) -> bool:
    """Heuristic: keep discovery candidates that look like a recorder (NVR/DVR/XVR).

    Multi-input appliances report a model/name containing NVR/DVR/XVR, or a
    channel-count hint > 1. When nothing distinguishes it we keep it (graceful — the
    operator decides). LIVE-VALIDATE: refine against the owner's real estate; discovery
    surfaces both cameras + recorders and brands differ in how they self-describe.
    """
    text = " ".join(
        str(v or "")
        for v in (getattr(d, "name", None), getattr(d, "model", None), getattr(d, "manufacturer", None))
    ).lower()
    if any(k in text for k in ("nvr", "dvr", "xvr", "recorder")):
        return True
    # No explicit camera marker either → keep (operator picks). Only drop if it clearly
    # self-identifies as a single camera (has "ipc"/"camera" and no recorder marker).
    if any(k in text for k in ("ipc", "ip camera", "camera", "dome", "bullet")):
        return False
    return True


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


def _lifecycle_payload(row: NVR) -> dict:
    """The ``device.nvr.*`` payload core/sites consume."""
    return {
        "nvr_id": row.id,
        "name": row.name,
        "brand": row.brand,
        "host": row.host,
        "status": row.status,
        "channel_count": row.channel_count,
        "storage": row.storage_info or {},
    }


def _status_payload(row: NVR) -> dict:
    """The ``vms.nvr.status`` realtime payload (workflow correlation + realtime)."""
    return {
        "nvr_id": row.id,
        "status": row.status,
        "is_enabled": row.is_enabled,
        "channel_count": row.channel_count,
        "storage": row.storage_info or {},
    }
