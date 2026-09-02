"""Video-wall service — tenant-scoped CRUD + shared live-state (VW-A).

Mirrors the camera service: every read goes through ``kernel.auth.scoped``; every by-id
fetch through ``assert_owned`` (cross-tenant → NotFound → 404); new rows are stamped with
the caller's ``tenant_id``.

The LIVE wall state is a single JSON blob on the ``video_walls`` row —
``{monitor_id: {cell_index(str): camera_id}}``. Every state mutation (push / clear / apply
preset / save preset / start-stop tour) writes that one row and publishes the NEW FULL
state on ``tenant.<id>.vms.wall.<wall_id>.state`` (``emit_wall_state``) so the core SSE
bridge fans it to every operator UI + display-client, which just replace their local copy.

Ownership rule: a monitor / preset / tour is always fetched *and* verified to belong to a
wall the caller owns — a foreign wall_id yields a clean 404, never a cross-tenant leak.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from urllib.parse import quote

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ConflictError, NotFoundError, ValidationError

from app.vms.common.crypto import decrypt_secret
from app.vms.common.events import emit_wall_state
from app.vms.models import Camera, MediaProfile, VideoWall, WallMonitor, WallPreset, WallTour

from .decoder_service import VideoDecoderService

from .schemas import (
    MonitorCreate,
    MonitorListResponse,
    MonitorPublic,
    MonitorUpdate,
    PresetCreate,
    PresetListResponse,
    PresetPublic,
    PresetUpdate,
    TourCreate,
    TourListResponse,
    TourPublic,
    TourUpdate,
    WallCreate,
    WallListResponse,
    WallPublic,
    WallStateResponse,
    WallUpdate,
)

log = logging.getLogger("vision.videowall")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


def _inject_rtsp_creds(url: str, username: str, password: str) -> str:
    """Inject percent-encoded rtsp creds into a URL authority (idempotent) — ported from
    the live service. Skips URLs whose authority already carries an ``@``."""
    if not username or "://" not in url:
        return url
    proto, rest = url.split("://", 1)
    authority = rest.split("/", 1)[0]
    if "@" in authority:
        return url
    user = quote(username, safe="")
    pwd = quote(password or "", safe="")
    return f"{proto}://{user}:{pwd}@{rest}"


class VideoWallService:
    """Tenant-scoped video-wall CRUD + shared live-state broadcast."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope
        # VW-B decoder push — lazily used for kind='decoder' monitors (shares the DB+scope).
        self._decoders = VideoDecoderService(db, scope)

    # ── row fetch helpers (ownership-checked) ───────────────────────────
    async def _wall(self, wall_id: str) -> VideoWall:
        row = await self.db.get(VideoWall, wall_id)
        assert_owned(row, self.scope, message="Video wall not found")
        return row

    async def _monitor(self, wall_id: str, monitor_id: str) -> WallMonitor:
        await self._wall(wall_id)  # ownership of the parent wall
        row = await self.db.get(WallMonitor, monitor_id)
        if row is None or row.wall_id != wall_id:
            raise NotFoundError("Monitor not found")
        assert_owned(row, self.scope, message="Monitor not found")
        return row

    async def _preset(self, wall_id: str, preset_id: str) -> WallPreset:
        await self._wall(wall_id)
        row = await self.db.get(WallPreset, preset_id)
        if row is None or row.wall_id != wall_id:
            raise NotFoundError("Preset not found")
        assert_owned(row, self.scope, message="Preset not found")
        return row

    async def _tour(self, wall_id: str, tour_id: str) -> WallTour:
        await self._wall(wall_id)
        row = await self.db.get(WallTour, tour_id)
        if row is None or row.wall_id != wall_id:
            raise NotFoundError("Tour not found")
        assert_owned(row, self.scope, message="Tour not found")
        return row

    # ── wall CRUD ───────────────────────────────────────────────────────
    async def create_wall(self, body: WallCreate, *, actor) -> WallPublic:
        dup = await self.db.scalar(
            scoped(select(VideoWall), VideoWall, self.scope).where(VideoWall.name == body.name)
        )
        if dup is not None:
            raise ConflictError("a video wall with this name already exists")
        actor_id = _actor_id(actor)
        row = VideoWall(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            description=body.description,
            site_id=body.site_id,
            rows=body.rows,
            cols=body.cols,
            is_active=body.is_active,
            state={},
            created_by=actor_id,
            updated_by=actor_id,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return WallPublic.from_row(row)

    async def list_walls(self, *, skip: int = 0, limit: int = 50, site_id: str | None = None) -> WallListResponse:
        stmt = scoped(select(VideoWall), VideoWall, self.scope)
        count_stmt = scoped(select(func.count()).select_from(VideoWall), VideoWall, self.scope)
        if site_id:
            stmt = stmt.where(VideoWall.site_id == site_id)
            count_stmt = count_stmt.where(VideoWall.site_id == site_id)
        stmt = stmt.order_by(VideoWall.created_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count_stmt) or 0)
        return WallListResponse(
            items=[WallPublic.from_row(r) for r in rows], total=total, skip=skip, limit=limit
        )

    async def get_wall(self, wall_id: str) -> WallPublic:
        return WallPublic.from_row(await self._wall(wall_id))

    async def update_wall(self, wall_id: str, body: WallUpdate, *, actor) -> WallPublic:
        row = await self._wall(wall_id)
        data = body.model_dump(exclude_unset=True)
        for k in {"name", "description", "site_id", "rows", "cols", "is_active"} & set(data):
            setattr(row, k, data[k])
        actor_id = _actor_id(actor)
        if actor_id:
            row.updated_by = actor_id
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return WallPublic.from_row(row)

    async def delete_wall(self, wall_id: str, *, actor) -> None:
        row = await self._wall(wall_id)
        # Cascade the wall's monitors/presets/tours (no DB FK; explicit cleanup).
        for model in (WallMonitor, WallPreset, WallTour):
            children = (
                await self.db.execute(select(model).where(model.wall_id == wall_id))
            ).scalars().all()
            for c in children:
                await self.db.delete(c)
        await self.db.delete(row)
        await self.db.commit()

    # ── monitor CRUD ────────────────────────────────────────────────────
    async def create_monitor(self, wall_id: str, body: MonitorCreate, *, actor) -> MonitorPublic:
        await self._wall(wall_id)
        row = WallMonitor(
            tenant_id=self.scope.tenant_id,
            wall_id=wall_id,
            name=body.name,
            position=body.position,
            kind=body.kind,
            layout=body.layout,
            decoder_id=body.decoder_id,
            decoder_channel=body.decoder_channel,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return MonitorPublic.from_row(row)

    async def list_monitors(self, wall_id: str) -> MonitorListResponse:
        await self._wall(wall_id)
        rows = (
            await self.db.execute(
                scoped(select(WallMonitor), WallMonitor, self.scope)
                .where(WallMonitor.wall_id == wall_id)
                .order_by(WallMonitor.position)
            )
        ).scalars().all()
        return MonitorListResponse(items=[MonitorPublic.from_row(r) for r in rows], total=len(rows))

    async def update_monitor(self, wall_id: str, monitor_id: str, body: MonitorUpdate) -> MonitorPublic:
        row = await self._monitor(wall_id, monitor_id)
        data = body.model_dump(exclude_unset=True)
        for k in {"name", "position", "kind", "layout", "decoder_id", "decoder_channel"} & set(data):
            setattr(row, k, data[k])
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return MonitorPublic.from_row(row)

    async def delete_monitor(self, wall_id: str, monitor_id: str, *, actor) -> None:
        wall = await self._wall(wall_id)
        row = await self._monitor(wall_id, monitor_id)
        await self.db.delete(row)
        # Drop the monitor's slice from the live state + broadcast.
        state = dict(wall.state or {})
        if monitor_id in state:
            state.pop(monitor_id, None)
            wall.state = state
            wall.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(wall)
        await self._broadcast(wall, action="monitor_deleted", actor=actor)

    # ── live state ──────────────────────────────────────────────────────
    async def get_state(self, wall_id: str) -> WallStateResponse:
        wall = await self._wall(wall_id)
        return WallStateResponse(wall_id=wall.id, state=wall.state or {})

    async def push_cell(self, wall_id: str, monitor_id: str, cell_index: int, camera_id: str, *, actor) -> WallStateResponse:
        wall = await self._wall(wall_id)
        # Monitor must belong to this wall (ownership-checked).
        monitor = await self._monitor(wall_id, monitor_id)
        state = dict(wall.state or {})
        mon = dict(state.get(monitor_id) or {})
        mon[str(cell_index)] = camera_id
        state[monitor_id] = mon
        wall.state = state
        wall.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(wall)
        await self._broadcast(wall, action="push", actor=actor)
        # VW-B: also push to the physical decoder if this monitor is a decoder (best-effort;
        # runs AFTER the state write+broadcast so a decoder failure can't break the wall).
        await self._push_to_decoder(monitor, cell_index, camera_id)
        return WallStateResponse(wall_id=wall.id, state=wall.state or {})

    async def clear_cell(self, wall_id: str, monitor_id: str, cell_index: int | None, *, actor) -> WallStateResponse:
        wall = await self._wall(wall_id)
        monitor = await self._monitor(wall_id, monitor_id)
        state = dict(wall.state or {})
        if cell_index is None:
            # Clear the whole monitor.
            state.pop(monitor_id, None)
        else:
            mon = dict(state.get(monitor_id) or {})
            mon.pop(str(cell_index), None)
            if mon:
                state[monitor_id] = mon
            else:
                state.pop(monitor_id, None)
        wall.state = state
        wall.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(wall)
        await self._broadcast(wall, action="clear", actor=actor)
        # VW-B: clear the physical decoder cell/output too (best-effort, post-broadcast).
        await self._clear_on_decoder(monitor, cell_index)
        return WallStateResponse(wall_id=wall.id, state=wall.state or {})

    async def apply_preset(self, wall_id: str, preset_id: str, *, actor) -> WallStateResponse:
        wall = await self._wall(wall_id)
        preset = await self._preset(wall_id, preset_id)
        wall.state = dict(preset.state or {})
        wall.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(wall)
        await self._broadcast(wall, action="apply_preset", actor=actor, extra={"preset_id": preset_id})
        # VW-B: re-push the whole new state to every decoder monitor (best-effort).
        await self._reconcile_decoders(wall, wall.state or {})
        return WallStateResponse(wall_id=wall.id, state=wall.state or {})

    # ── presets ─────────────────────────────────────────────────────────
    async def save_preset(self, wall_id: str, body: PresetCreate, *, actor) -> PresetPublic:
        wall = await self._wall(wall_id)
        dup = await self.db.scalar(
            scoped(select(WallPreset), WallPreset, self.scope)
            .where(WallPreset.wall_id == wall_id, WallPreset.name == body.name)
        )
        if dup is not None:
            raise ConflictError("a preset with this name already exists on this wall")
        # Explicit state wins; otherwise snapshot the wall's CURRENT live state.
        snapshot = body.state if body.state is not None else dict(wall.state or {})
        if body.is_default:
            await self._clear_default_presets(wall_id)
        row = WallPreset(
            tenant_id=self.scope.tenant_id,
            wall_id=wall_id,
            name=body.name,
            state=snapshot,
            is_default=body.is_default,
            created_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return PresetPublic.from_row(row)

    async def list_presets(self, wall_id: str) -> PresetListResponse:
        await self._wall(wall_id)
        rows = (
            await self.db.execute(
                scoped(select(WallPreset), WallPreset, self.scope)
                .where(WallPreset.wall_id == wall_id)
                .order_by(WallPreset.created_at.desc())
            )
        ).scalars().all()
        return PresetListResponse(items=[PresetPublic.from_row(r) for r in rows], total=len(rows))

    async def update_preset(self, wall_id: str, preset_id: str, body: PresetUpdate) -> PresetPublic:
        row = await self._preset(wall_id, preset_id)
        data = body.model_dump(exclude_unset=True)
        if "name" in data:
            row.name = data["name"]
        if "state" in data and data["state"] is not None:
            row.state = data["state"]
        if data.get("is_default"):
            await self._clear_default_presets(wall_id)
            row.is_default = True
        elif "is_default" in data:
            row.is_default = bool(data["is_default"])
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return PresetPublic.from_row(row)

    async def delete_preset(self, wall_id: str, preset_id: str) -> None:
        row = await self._preset(wall_id, preset_id)
        await self.db.delete(row)
        await self.db.commit()

    async def _clear_default_presets(self, wall_id: str) -> None:
        rows = (
            await self.db.execute(
                scoped(select(WallPreset), WallPreset, self.scope)
                .where(WallPreset.wall_id == wall_id, WallPreset.is_default.is_(True))
            )
        ).scalars().all()
        for r in rows:
            r.is_default = False

    # ── tours ───────────────────────────────────────────────────────────
    async def create_tour(self, wall_id: str, body: TourCreate, *, actor) -> TourPublic:
        await self._wall(wall_id)
        dup = await self.db.scalar(
            scoped(select(WallTour), WallTour, self.scope)
            .where(WallTour.wall_id == wall_id, WallTour.name == body.name)
        )
        if dup is not None:
            raise ConflictError("a tour with this name already exists on this wall")
        await self._validate_preset_ids(wall_id, body.preset_ids)
        row = WallTour(
            tenant_id=self.scope.tenant_id,
            wall_id=wall_id,
            name=body.name,
            preset_ids=list(body.preset_ids or []),
            dwell_seconds=body.dwell_seconds,
            created_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return TourPublic.from_row(row)

    async def list_tours(self, wall_id: str) -> TourListResponse:
        await self._wall(wall_id)
        rows = (
            await self.db.execute(
                scoped(select(WallTour), WallTour, self.scope)
                .where(WallTour.wall_id == wall_id)
                .order_by(WallTour.created_at.desc())
            )
        ).scalars().all()
        return TourListResponse(items=[TourPublic.from_row(r) for r in rows], total=len(rows))

    async def update_tour(self, wall_id: str, tour_id: str, body: TourUpdate) -> TourPublic:
        row = await self._tour(wall_id, tour_id)
        data = body.model_dump(exclude_unset=True)
        if "name" in data:
            row.name = data["name"]
        if "preset_ids" in data and data["preset_ids"] is not None:
            await self._validate_preset_ids(wall_id, data["preset_ids"])
            row.preset_ids = list(data["preset_ids"])
        if "dwell_seconds" in data and data["dwell_seconds"] is not None:
            row.dwell_seconds = data["dwell_seconds"]
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return TourPublic.from_row(row)

    async def delete_tour(self, wall_id: str, tour_id: str) -> None:
        row = await self._tour(wall_id, tour_id)
        await self.db.delete(row)
        await self.db.commit()

    async def set_tour_running(self, wall_id: str, tour_id: str, running: bool, *, actor) -> TourPublic:
        row = await self._tour(wall_id, tour_id)
        row.is_running = running
        row.updated_at = _utcnow()
        # Starting a tour applies its first preset immediately (so operators + clients
        # jump to the tour's opening state); the dwell cycler (VW-D) advances thereafter.
        if running and row.preset_ids:
            try:
                await self.apply_preset(wall_id, row.preset_ids[0], actor=actor)
            except NotFoundError:
                log.info("tour %s first preset %s missing — skipping apply", tour_id, row.preset_ids[0])
        await self.db.commit()
        await self.db.refresh(row)
        return TourPublic.from_row(row)

    async def _validate_preset_ids(self, wall_id: str, preset_ids: list[str]) -> None:
        if not preset_ids:
            return
        rows = (
            await self.db.execute(
                scoped(select(WallPreset.id), WallPreset, self.scope)
                .where(WallPreset.wall_id == wall_id, WallPreset.id.in_(preset_ids))
            )
        ).scalars().all()
        owned = set(rows)
        missing = [pid for pid in preset_ids if pid not in owned]
        if missing:
            raise ValidationError(f"unknown preset ids for this wall: {missing}")

    # ── decoder push (VW-B) ─────────────────────────────────────────────
    #
    # When a monitor's ``kind == 'decoder'`` the wall must also push the camera's RTSP to
    # the physical decoder output cell over the brand SDK, so a hardware control-room wall
    # (not just browser kiosks) shows the cameras. Browser monitors render client-side and
    # are unaffected.
    #
    # DISCIPLINE: decoder push is BEST-EFFORT. Every hook is wrapped so a missing decoder /
    # bad credential / dead appliance is LOGGED and swallowed — it must NEVER break the
    # wall-state write or the SSE broadcast (those already committed before the push runs).

    async def _rtsp_for_camera(self, camera_id: str) -> str | None:
        """Build the RTSP URL a hardware decoder pulls for ``camera_id`` (creds injected).

        A physical decoder pulls RTSP directly from the camera, so this mirrors the live
        service's ``_rtsp_source_for`` derivation: a stored ``MediaProfile.rtsp_path``
        (prefer main for a wall display → sub → any) → a constructed Hik-style fallback
        from the camera host + rtsp_port. Credentials are decrypted in-memory and injected.
        Returns ``None`` when nothing is derivable (→ the push is skipped). Ownership: the
        camera is fetched tenant-scoped, so a foreign camera_id yields None."""
        camera = await self.db.scalar(
            scoped(select(Camera), Camera, self.scope).where(Camera.id == camera_id)
        )
        if camera is None:
            return None
        profiles = {
            p.name: p
            for p in (
                await self.db.execute(
                    select(MediaProfile).where(MediaProfile.camera_id == camera.id)
                )
            ).scalars().all()
        }
        chosen = None
        for name in ("main", "sub"):  # prefer main-stream quality for a wall display.
            mp = profiles.get(name)
            if mp and mp.rtsp_path:
                chosen = mp.rtsp_path
                break
        if chosen is None:
            for mp in profiles.values():
                if mp.rtsp_path:
                    chosen = mp.rtsp_path
                    break

        username = camera.onvif_user or ""
        password = decrypt_secret(camera.onvif_enc_pass) or ""
        use_creds = bool(username and password)

        if chosen:
            return _inject_rtsp_creds(chosen, username, password) if use_creds else chosen

        # Fallback: construct a Hik-style RTSP from host + rtsp_port (main stream).
        host = camera.onvif_host or (camera.network_info or {}).get("ip")
        if not host:
            return None
        rtsp_port = (camera.network_info or {}).get("rtsp_port") or 554
        # channel 0 is a valid NVR channel index — explicit None check, never `or 1`.
        channel = camera.nvr_channel_number if camera.nvr_channel_number is not None else 1
        base = f"rtsp://{host}:{rtsp_port}/Streaming/Channels/{channel:d}01"
        return _inject_rtsp_creds(base, username, password) if use_creds else base

    async def _push_to_decoder(
        self, monitor: WallMonitor, cell_index: int, camera_id: str
    ) -> None:
        """Push ``camera_id``'s RTSP onto ``monitor``'s decoder output cell — best-effort.

        No-op unless the monitor is a wired decoder (kind='decoder' + decoder_id set)."""
        if monitor.kind != "decoder" or not monitor.decoder_id:
            return
        try:
            resolved = await self._decoders.resolve_driver(monitor.decoder_id)
            if resolved is None:
                log.info(
                    "wall decoder push skipped: decoder %s missing/disabled/unsupported",
                    monitor.decoder_id,
                )
                return
            driver, dec, creds = resolved
            rtsp = await self._rtsp_for_camera(camera_id)
            if not rtsp:
                log.info("wall decoder push skipped: no RTSP for camera %s", camera_id)
                return
            channel = monitor.decoder_channel if monitor.decoder_channel is not None else 1
            result = await driver.display(dec.host, creds, channel, cell_index, rtsp)
            if not result.ok:
                log.info(
                    "wall decoder display failed (decoder=%s ch=%s cell=%s): %s",
                    dec.id, channel, cell_index, result.error,
                )
        except Exception as exc:  # noqa: BLE001 — best-effort; never break wall state.
            log.warning("wall decoder push errored (monitor=%s): %s", monitor.id, exc)

    async def _clear_on_decoder(self, monitor: WallMonitor, cell_index: int | None) -> None:
        """Clear ``monitor``'s decoder output cell (or whole output) — best-effort."""
        if monitor.kind != "decoder" or not monitor.decoder_id:
            return
        try:
            resolved = await self._decoders.resolve_driver(monitor.decoder_id)
            if resolved is None:
                return
            driver, dec, creds = resolved
            channel = monitor.decoder_channel if monitor.decoder_channel is not None else 1
            result = await driver.clear(dec.host, creds, channel, cell_index)
            if not result.ok:
                log.info(
                    "wall decoder clear failed (decoder=%s ch=%s cell=%s): %s",
                    dec.id, channel, cell_index, result.error,
                )
        except Exception as exc:  # noqa: BLE001 — best-effort; never break wall state.
            log.warning("wall decoder clear errored (monitor=%s): %s", monitor.id, exc)

    async def _reconcile_decoders(self, wall: VideoWall, state: dict) -> None:
        """Re-push the WHOLE state to every decoder monitor of ``wall`` — used after
        ``apply_preset`` (which replaces the entire wall state). Best-effort per cell."""
        monitors = (
            await self.db.execute(
                select(WallMonitor).where(
                    WallMonitor.wall_id == wall.id, WallMonitor.kind == "decoder"
                )
            )
        ).scalars().all()
        for mon in monitors:
            if not mon.decoder_id:
                continue
            mon_state = state.get(mon.id) or {}
            if not mon_state:
                await self._clear_on_decoder(mon, None)
                continue
            for cell_str, camera_id in mon_state.items():
                try:
                    cell = int(cell_str)
                except (TypeError, ValueError):
                    continue
                await self._push_to_decoder(mon, cell, camera_id)

    # ── broadcast ───────────────────────────────────────────────────────
    async def _broadcast(self, wall: VideoWall, *, action: str, actor, extra: dict | None = None) -> None:
        payload = {
            "state": wall.state or {},
            "rows": wall.rows,
            "cols": wall.cols,
            "action": action,
            "actor_id": _actor_id(actor),
        }
        if extra:
            payload.update(extra)
        await emit_wall_state(wall.tenant_id, wall.id, payload)
