"""PTZ domain schemas (G1) — move / preset / patrol request + response models."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


# ── Move / zoom / focus ─────────────────────────────────────────────────
class PtzMoveBody(BaseModel):
    """POST /cameras/{id}/ptz/move — a continuous (velocity) or relative/absolute move.

    ``pan``/``tilt``/``zoom`` are -1.0..1.0 (direction × magnitude); ``speed`` scales a
    continuous move (0..1). ``mode`` selects the driver action.
    """

    model_config = ConfigDict(extra="forbid")
    mode: Literal["continuous", "relative", "absolute"] = "continuous"
    pan: float = Field(default=0.0, ge=-1.0, le=1.0)
    tilt: float = Field(default=0.0, ge=-1.0, le=1.0)
    zoom: float = Field(default=0.0, ge=-1.0, le=1.0)
    speed: float = Field(default=0.5, ge=0.0, le=1.0)


class PtzZoomBody(BaseModel):
    """POST /cameras/{id}/ptz/zoom — zoom-only move. ``direction`` in|out (or raw ``zoom``)."""

    model_config = ConfigDict(extra="forbid")
    direction: Literal["in", "out"] = "in"
    speed: float = Field(default=0.5, ge=0.0, le=1.0)


class PtzFocusBody(BaseModel):
    """POST /cameras/{id}/ptz/focus — focus-only continuous move (near|far)."""

    model_config = ConfigDict(extra="forbid")
    direction: Literal["near", "far"] = "near"
    speed: float = Field(default=0.5, ge=0.0, le=1.0)


class PtzResult(BaseModel):
    """Generic PTZ command result envelope (move/stop/goto)."""

    ok: bool = True
    result: object | None = None


# ── Presets ──────────────────────────────────────────────────────────────
class PresetCreate(BaseModel):
    """POST /cameras/{id}/ptz/presets — store the camera's CURRENT position as a preset.

    The service tells the camera to store the preset (driver ``set_preset`` → on-device
    ``preset_token``) AND persists a ``PtzPreset`` row. ``preset_token`` optionally targets
    a specific on-device slot; ``position`` is an advisory {pan,tilt,zoom} snapshot.
    """

    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=255)
    preset_token: Optional[str] = Field(default=None, max_length=255)
    position: Optional[dict] = None


class PresetPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    camera_id: str
    name: str
    preset_token: Optional[str] = None
    position: Optional[dict] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "PresetPublic":
        return cls(
            id=row.id,
            camera_id=row.camera_id,
            name=row.name,
            preset_token=row.preset_token,
            position=row.position,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


class PresetListResponse(BaseModel):
    items: list[PresetPublic]
    total: int


# ── Patrols ──────────────────────────────────────────────────────────────
class PatrolStop(BaseModel):
    """One stop in a patrol: a preset id + how long to dwell before advancing."""

    model_config = ConfigDict(extra="forbid")
    preset_id: str = Field(min_length=1, max_length=36)
    dwell_seconds: int = Field(default=5, ge=1, le=3600)


class PatrolCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=255)
    stops: list[PatrolStop] = Field(default_factory=list)
    speed: float = Field(default=0.5, ge=0.0, le=1.0)
    is_active: bool = True
    schedule: Optional[dict] = None


class PatrolUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    stops: Optional[list[PatrolStop]] = None
    speed: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    is_active: Optional[bool] = None
    schedule: Optional[dict] = None


class PatrolPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    camera_id: str
    name: str
    stops: list[dict]
    speed: float
    is_active: bool
    is_running: bool
    schedule: Optional[dict] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "PatrolPublic":
        return cls(
            id=row.id,
            camera_id=row.camera_id,
            name=row.name,
            stops=list(row.stops or []),
            speed=row.speed,
            is_active=row.is_active,
            is_running=row.is_running,
            schedule=row.schedule,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


class PatrolListResponse(BaseModel):
    items: list[PatrolPublic]
    total: int
