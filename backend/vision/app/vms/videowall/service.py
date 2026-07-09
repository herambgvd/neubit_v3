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

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ConflictError, NotFoundError, ValidationError

from app.vms.common.events import emit_wall_state
from app.vms.models import VideoWall, WallMonitor, WallPreset, WallTour

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


class VideoWallService:
    """Tenant-scoped video-wall CRUD + shared live-state broadcast."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

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
        await self._monitor(wall_id, monitor_id)
        state = dict(wall.state or {})
        mon = dict(state.get(monitor_id) or {})
        mon[str(cell_index)] = camera_id
        state[monitor_id] = mon
        wall.state = state
        wall.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(wall)
        await self._broadcast(wall, action="push", actor=actor)
        return WallStateResponse(wall_id=wall.id, state=wall.state or {})

    async def clear_cell(self, wall_id: str, monitor_id: str, cell_index: int | None, *, actor) -> WallStateResponse:
        wall = await self._wall(wall_id)
        await self._monitor(wall_id, monitor_id)
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
        return WallStateResponse(wall_id=wall.id, state=wall.state or {})

    async def apply_preset(self, wall_id: str, preset_id: str, *, actor) -> WallStateResponse:
        wall = await self._wall(wall_id)
        preset = await self._preset(wall_id, preset_id)
        wall.state = dict(preset.state or {})
        wall.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(wall)
        await self._broadcast(wall, action="apply_preset", actor=actor, extra={"preset_id": preset_id})
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
