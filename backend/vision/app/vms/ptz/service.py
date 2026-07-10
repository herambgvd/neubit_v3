"""PTZ operator-control service (G1) — move / preset CRUD / patrols.

Tenant-scoped, mirroring the camera + videowall services: every camera fetch goes through
``assert_owned`` (cross-tenant → NotFound → 404); every preset/patrol is fetched *and*
verified to belong to a camera the caller owns. All PTZ device I/O goes through the
resolved brand driver; a driver failure surfaces as a ``DriverError`` (the router → 502).

A camera must be ``ptz_capable`` for any PTZ op — otherwise a ``ValidationError`` (→ 400).

Preset create is a two-step: tell the CAMERA to store the current position as a preset
(driver ``set_preset`` → an on-device ``preset_token``) AND persist a ``PtzPreset`` catalog
row carrying that token. Goto recalls the on-device token via the driver. Delete removes
both the on-device preset (best-effort) and the row.

Patrols persist as ``PtzPatrol`` rows; start/stop drives the process-local ``PatrolCycler``
(goto-preset in order on dwell) and flips ``is_running``. See ``cycler.py`` for the
restart caveat.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ConflictError, NotFoundError, ValidationError

from app.vms.common.crypto import decrypt_secret
from app.vms.drivers import Credentials, DriverError, PtzCommand, get_driver
from app.vms.models import Camera, PtzPatrol, PtzPreset

from .cycler import get_cycler
from .schemas import (
    PatrolCreate,
    PatrolPublic,
    PatrolUpdate,
    PresetCreate,
    PresetPublic,
)

log = logging.getLogger("vision.ptz")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


class PtzService:
    """Tenant-scoped PTZ move + preset/patrol control over ``ptz_presets`` / ``ptz_patrols``."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    # ── camera resolution + ptz gate ────────────────────────────────────
    async def _camera(self, camera_id: str, *, require_ptz: bool = True) -> Camera:
        row = await self.db.get(Camera, camera_id)
        assert_owned(row, self.scope, message="Camera not found")
        if require_ptz and not row.ptz_capable:
            raise ValidationError("camera is not PTZ-capable")
        return row

    def _creds_for(self, row: Camera) -> Credentials:
        return Credentials(
            username=row.onvif_user or "admin",
            password=decrypt_secret(row.onvif_enc_pass) or "",
            port=row.onvif_port or 80,
            rtsp_port=(row.network_info or {}).get("rtsp_port") or 554,
        )

    def _host(self, row: Camera) -> str:
        host = row.onvif_host or (row.network_info or {}).get("ip")
        if not host:
            raise DriverError("camera has no reachable host configured")
        return host

    async def _dispatch(self, row: Camera, cmd: PtzCommand) -> Any:
        driver = get_driver(row.brand)
        try:
            return await driver.ptz(self._host(row), self._creds_for(row), cmd)
        finally:
            await driver.aclose()

    # ── move / zoom / focus / stop ──────────────────────────────────────
    async def move(self, camera_id: str, *, mode: str, pan: float, tilt: float, zoom: float, speed: float) -> Any:
        row = await self._camera(camera_id)
        return await self._dispatch(
            row, PtzCommand(action=mode, pan=pan, tilt=tilt, zoom=zoom, speed=speed)
        )

    async def stop(self, camera_id: str) -> Any:
        row = await self._camera(camera_id)
        return await self._dispatch(row, PtzCommand(action="stop"))

    async def zoom(self, camera_id: str, *, direction: str, speed: float) -> Any:
        row = await self._camera(camera_id)
        z = speed if direction == "in" else -speed
        return await self._dispatch(row, PtzCommand(action="zoom", zoom=z, speed=speed))

    async def focus(self, camera_id: str, *, direction: str, speed: float) -> Any:
        row = await self._camera(camera_id)
        f = speed if direction == "near" else -speed
        return await self._dispatch(row, PtzCommand(action="focus", zoom=f, speed=speed))

    # ── presets ─────────────────────────────────────────────────────────
    async def list_presets(self, camera_id: str) -> list[PresetPublic]:
        await self._camera(camera_id, require_ptz=False)
        stmt = scoped(select(PtzPreset), PtzPreset, self.scope).where(
            PtzPreset.camera_id == camera_id
        ).order_by(PtzPreset.created_at)
        rows = (await self.db.execute(stmt)).scalars().all()
        return [PresetPublic.from_row(r) for r in rows]

    async def create_preset(self, camera_id: str, body: PresetCreate, *, actor) -> PresetPublic:
        row = await self._camera(camera_id)
        # Name unique per camera within the tenant.
        dup = await self.db.scalar(
            scoped(select(PtzPreset), PtzPreset, self.scope).where(
                PtzPreset.camera_id == camera_id, PtzPreset.name == body.name
            )
        )
        if dup is not None:
            raise ConflictError("a preset with this name already exists for this camera")

        # Tell the camera to store the CURRENT position as a preset → on-device token.
        token = await self._dispatch(
            row,
            PtzCommand(action="set_preset", preset_name=body.name, preset_token=body.preset_token),
        )
        token = str(token) if token else body.preset_token

        preset = PtzPreset(
            tenant_id=self.scope.tenant_id,
            camera_id=camera_id,
            name=body.name,
            preset_token=token,
            position=body.position,
            created_by=_actor_id(actor),
        )
        self.db.add(preset)
        await self.db.commit()
        await self.db.refresh(preset)
        return PresetPublic.from_row(preset)

    async def _preset_row(self, camera_id: str, preset_id: str) -> PtzPreset:
        stmt = scoped(select(PtzPreset), PtzPreset, self.scope).where(
            PtzPreset.id == preset_id, PtzPreset.camera_id == camera_id
        )
        preset = await self.db.scalar(stmt)
        if preset is None:
            raise NotFoundError("Preset not found")
        return preset

    async def goto_preset(self, camera_id: str, preset_id: str) -> Any:
        row = await self._camera(camera_id)
        preset = await self._preset_row(camera_id, preset_id)
        if not preset.preset_token:
            raise ValidationError("preset has no on-device token to recall")
        return await self._dispatch(
            row, PtzCommand(action="goto_preset", preset_token=preset.preset_token)
        )

    async def delete_preset(self, camera_id: str, preset_id: str) -> None:
        row = await self._camera(camera_id, require_ptz=False)
        preset = await self._preset_row(camera_id, preset_id)
        # Best-effort remove on-device (don't block row delete on an unreachable camera).
        if preset.preset_token and row.ptz_capable:
            try:
                await self._dispatch(
                    row, PtzCommand(action="delete_preset", preset_token=preset.preset_token)
                )
            except DriverError as exc:
                log.info("on-device delete_preset failed (camera=%s): %s", camera_id, exc)
        await self.db.delete(preset)
        await self.db.commit()

    # ── patrols ─────────────────────────────────────────────────────────
    async def list_patrols(self, camera_id: str) -> list[PatrolPublic]:
        await self._camera(camera_id, require_ptz=False)
        stmt = scoped(select(PtzPatrol), PtzPatrol, self.scope).where(
            PtzPatrol.camera_id == camera_id
        ).order_by(PtzPatrol.created_at)
        rows = (await self.db.execute(stmt)).scalars().all()
        out = []
        for r in rows:
            r.is_running = get_cycler().is_running(r.id) or r.is_running
            out.append(PatrolPublic.from_row(r))
        return out

    async def _patrol_row(self, camera_id: str, patrol_id: str) -> PtzPatrol:
        stmt = scoped(select(PtzPatrol), PtzPatrol, self.scope).where(
            PtzPatrol.id == patrol_id, PtzPatrol.camera_id == camera_id
        )
        patrol = await self.db.scalar(stmt)
        if patrol is None:
            raise NotFoundError("Patrol not found")
        return patrol

    async def _validate_stops(self, camera_id: str, stops: list) -> list[dict]:
        """Ensure every stop references a preset owned on THIS camera; return JSON stops."""
        out: list[dict] = []
        for stop in stops:
            preset_id = stop.preset_id
            preset = await self.db.scalar(
                scoped(select(PtzPreset), PtzPreset, self.scope).where(
                    PtzPreset.id == preset_id, PtzPreset.camera_id == camera_id
                )
            )
            if preset is None:
                raise ValidationError(f"preset {preset_id} not found for this camera")
            out.append({"preset_id": preset_id, "dwell_seconds": stop.dwell_seconds})
        return out

    async def create_patrol(self, camera_id: str, body: PatrolCreate, *, actor) -> PatrolPublic:
        await self._camera(camera_id)
        dup = await self.db.scalar(
            scoped(select(PtzPatrol), PtzPatrol, self.scope).where(
                PtzPatrol.camera_id == camera_id, PtzPatrol.name == body.name
            )
        )
        if dup is not None:
            raise ConflictError("a patrol with this name already exists for this camera")
        stops = await self._validate_stops(camera_id, body.stops)
        patrol = PtzPatrol(
            tenant_id=self.scope.tenant_id,
            camera_id=camera_id,
            name=body.name,
            stops=stops,
            speed=body.speed,
            is_active=body.is_active,
            is_running=False,
            schedule=body.schedule,
            created_by=_actor_id(actor),
        )
        self.db.add(patrol)
        await self.db.commit()
        await self.db.refresh(patrol)
        return PatrolPublic.from_row(patrol)

    async def update_patrol(self, camera_id: str, patrol_id: str, body: PatrolUpdate) -> PatrolPublic:
        patrol = await self._patrol_row(camera_id, patrol_id)
        data = body.model_dump(exclude_unset=True)
        if "name" in data and data["name"] is not None:
            patrol.name = data["name"]
        if body.stops is not None:
            patrol.stops = await self._validate_stops(camera_id, body.stops)
        if "speed" in data and data["speed"] is not None:
            patrol.speed = data["speed"]
        if "is_active" in data and data["is_active"] is not None:
            patrol.is_active = data["is_active"]
            if not patrol.is_active and patrol.is_running:
                patrol.is_running = False
                await get_cycler().stop(patrol.id)
        if "schedule" in data:
            patrol.schedule = data["schedule"]
        patrol.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(patrol)
        return PatrolPublic.from_row(patrol)

    async def delete_patrol(self, camera_id: str, patrol_id: str) -> None:
        patrol = await self._patrol_row(camera_id, patrol_id)
        await get_cycler().stop(patrol.id)
        await self.db.delete(patrol)
        await self.db.commit()

    async def start_patrol(self, camera_id: str, patrol_id: str) -> PatrolPublic:
        await self._camera(camera_id)
        patrol = await self._patrol_row(camera_id, patrol_id)
        if not patrol.is_active:
            raise ValidationError("patrol is inactive")
        if not (patrol.stops or []):
            raise ValidationError("patrol has no stops to cycle")
        patrol.is_running = True
        patrol.updated_at = _utcnow()
        await self.db.commit()
        get_cycler().start(patrol.id)
        await self.db.refresh(patrol)
        return PatrolPublic.from_row(patrol)

    async def stop_patrol(self, camera_id: str, patrol_id: str) -> PatrolPublic:
        patrol = await self._patrol_row(camera_id, patrol_id)
        patrol.is_running = False
        patrol.updated_at = _utcnow()
        await self.db.commit()
        await get_cycler().stop(patrol.id)
        await self.db.refresh(patrol)
        return PatrolPublic.from_row(patrol)
