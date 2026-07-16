"""Media-node registry request/response schemas (pydantic v2).

An onboardable INDEPENDENT recorder machine: its Go ``nvr`` ``api_url`` (the routing +
heartbeat target) + optional MediaMTX media bases + a human ``label``. Tenant scope is
server-side. ``status`` / ``last_heartbeat`` / ``used_channels`` are server-maintained
(the heartbeat monitor owns them) — accepted only on ``Update`` for the operator-driven
``draining`` toggle.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

# The lifecycle statuses a node can carry (mirrors the model docstring). The heartbeat
# monitor drives online/offline; the operator may set ``draining`` via PATCH.
NODE_STATUSES = {"online", "offline", "draining", "error", "unknown"}


class MediaNodeCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=255)
    # The recorder's Go-nvr base URL — REQUIRED (the key routing/heartbeat field).
    api_url: str = Field(min_length=1, max_length=512)
    hls_base: Optional[str] = Field(default=None, max_length=512)
    webrtc_base: Optional[str] = Field(default=None, max_length=512)
    rtsp_base: Optional[str] = Field(default=None, max_length=512)
    label: Optional[str] = Field(default=None, max_length=255)
    capacity_channels: int = Field(default=0, ge=0)
    # Optional cosmetic host label (defaults to api_url's host if omitted server-side).
    host: Optional[str] = Field(default=None, max_length=255)


class MediaNodeUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    api_url: Optional[str] = Field(default=None, min_length=1, max_length=512)
    hls_base: Optional[str] = Field(default=None, max_length=512)
    webrtc_base: Optional[str] = Field(default=None, max_length=512)
    rtsp_base: Optional[str] = Field(default=None, max_length=512)
    label: Optional[str] = Field(default=None, max_length=255)
    host: Optional[str] = Field(default=None, max_length=255)
    capacity_channels: Optional[int] = Field(default=None, ge=0)
    # Operator override — only ``draining`` (graceful drain) is a meaningful manual set;
    # the monitor owns online/offline. Validated against NODE_STATUSES at the service.
    status: Optional[str] = Field(default=None, max_length=16)


class MediaNodePublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str
    host: str
    api_url: Optional[str] = None
    hls_base: Optional[str] = None
    webrtc_base: Optional[str] = None
    rtsp_base: Optional[str] = None
    label: Optional[str] = None
    capacity_channels: int
    used_channels: int
    status: str
    last_heartbeat: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    # Populated on the CREATE response only — reachability warning when the node did not
    # answer its health probe at register time (the row is still stored, marked offline).
    warning: Optional[str] = None

    @classmethod
    def from_row(cls, row, *, warning: str | None = None) -> "MediaNodePublic":
        return cls.model_validate(
            {
                "id": row.id,
                "name": row.name,
                "host": row.host,
                "api_url": row.api_url,
                "hls_base": row.hls_base,
                "webrtc_base": row.webrtc_base,
                "rtsp_base": row.rtsp_base,
                "label": row.label,
                "capacity_channels": row.capacity_channels,
                "used_channels": row.used_channels,
                "status": row.status,
                "last_heartbeat": row.last_heartbeat,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
                "warning": warning,
            }
        )


class MediaNodeListResponse(BaseModel):
    items: list[MediaNodePublic]
    total: int
    skip: int
    limit: int
