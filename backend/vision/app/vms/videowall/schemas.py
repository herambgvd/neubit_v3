"""Video-wall control-plane request/response schemas (pydantic v2, VW-A).

The frozen contract the wall-management UI (VW-D), the operator console and the
display-client build against. Mirrors the camera domain's Create/Update/Public shape
discipline; ``tenant_id`` is enforced server-side, never a client field. String literals
(``kind``) are typed ``Literal`` unions for a clean OpenAPI.

The LIVE wall ``state`` is a single JSON blob: ``{monitor_id: {cell_index(str): camera_id}}``
— one atomic shape shared by the wall row, presets, and every SSE broadcast, so a client
"replaces the whole wall" on each update.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

# A wall's live/preset state: {monitor_id: {cell_index_str: camera_id}}.
WallState = dict[str, dict[str, str]]

MonitorKind = Literal["browser", "decoder"]


# ── Video wall ────────────────────────────────────────────────────────────────


class WallCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=1024)
    site_id: Optional[str] = Field(default=None, max_length=36)
    rows: int = Field(default=2, ge=1, le=16)
    cols: int = Field(default=2, ge=1, le=16)
    is_active: bool = True


class WallUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=1024)
    site_id: Optional[str] = Field(default=None, max_length=36)
    rows: Optional[int] = Field(default=None, ge=1, le=16)
    cols: Optional[int] = Field(default=None, ge=1, le=16)
    is_active: Optional[bool] = None


class WallPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str
    description: Optional[str] = None
    site_id: Optional[str] = None
    rows: int
    cols: int
    is_active: bool
    state: WallState = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "WallPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "name": row.name,
                "description": row.description,
                "site_id": row.site_id,
                "rows": row.rows,
                "cols": row.cols,
                "is_active": row.is_active,
                "state": row.state or {},
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class WallListResponse(BaseModel):
    items: list[WallPublic]
    total: int
    skip: int
    limit: int


# ── Monitors ─────────────────────────────────────────────────────────────────


class MonitorCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=255)
    position: int = Field(default=0, ge=0)
    kind: MonitorKind = "browser"
    layout: Literal[1, 4, 9, 16] = 1
    # VW-B decoder push — supplied only for kind='decoder'.
    decoder_id: Optional[str] = Field(default=None, max_length=36)
    decoder_channel: Optional[int] = Field(default=None, ge=0)


class MonitorUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    position: Optional[int] = Field(default=None, ge=0)
    kind: Optional[MonitorKind] = None
    layout: Optional[Literal[1, 4, 9, 16]] = None
    decoder_id: Optional[str] = Field(default=None, max_length=36)
    decoder_channel: Optional[int] = Field(default=None, ge=0)


class MonitorPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    wall_id: str
    name: str
    position: int
    kind: str
    layout: int
    decoder_id: Optional[str] = None
    decoder_channel: Optional[int] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "MonitorPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "wall_id": row.wall_id,
                "name": row.name,
                "position": row.position,
                "kind": row.kind,
                "layout": row.layout,
                "decoder_id": row.decoder_id,
                "decoder_channel": row.decoder_channel,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class MonitorListResponse(BaseModel):
    items: list[MonitorPublic]
    total: int


# ── Live state mutations ─────────────────────────────────────────────────────


class WallStateResponse(BaseModel):
    """The current full wall state — what SSE broadcasts + a one-shot GET return."""

    model_config = ConfigDict(extra="ignore")
    wall_id: str
    state: WallState = Field(default_factory=dict)


class PushCellBody(BaseModel):
    """Push a camera to a (monitor, cell) — the core live-wall action."""

    model_config = ConfigDict(extra="forbid")
    monitor_id: str = Field(min_length=1, max_length=36)
    cell_index: int = Field(ge=0, le=15)
    camera_id: str = Field(min_length=1, max_length=36)


class ClearCellBody(BaseModel):
    """Clear a cell (or a whole monitor when ``cell_index`` is omitted)."""

    model_config = ConfigDict(extra="forbid")
    monitor_id: str = Field(min_length=1, max_length=36)
    cell_index: Optional[int] = Field(default=None, ge=0, le=15)


# ── Presets ──────────────────────────────────────────────────────────────────


class PresetCreate(BaseModel):
    """Save a preset. ``state`` omitted → snapshot the wall's CURRENT live state."""

    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=255)
    is_default: bool = False
    state: Optional[WallState] = None


class PresetUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    is_default: Optional[bool] = None
    state: Optional[WallState] = None


class PresetPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    wall_id: str
    name: str
    is_default: bool
    state: WallState = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "PresetPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "wall_id": row.wall_id,
                "name": row.name,
                "is_default": row.is_default,
                "state": row.state or {},
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class PresetListResponse(BaseModel):
    items: list[PresetPublic]
    total: int


# ── Tours ────────────────────────────────────────────────────────────────────


class TourCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=255)
    preset_ids: list[str] = Field(default_factory=list, max_length=64)
    dwell_seconds: int = Field(default=10, ge=1, le=3600)


class TourUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    preset_ids: Optional[list[str]] = Field(default=None, max_length=64)
    dwell_seconds: Optional[int] = Field(default=None, ge=1, le=3600)


class TourPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    wall_id: str
    name: str
    preset_ids: list[str] = Field(default_factory=list)
    dwell_seconds: int
    is_running: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "TourPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "wall_id": row.wall_id,
                "name": row.name,
                "preset_ids": list(row.preset_ids or []),
                "dwell_seconds": row.dwell_seconds,
                "is_running": row.is_running,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class TourListResponse(BaseModel):
    items: list[TourPublic]
    total: int
