"""Device-placement request/response schemas (pydantic).

Ported from neubit_v2's ``module/sites/device/schemas.py`` + ``models.py``. The
``FloorPosition`` sub-model and the ``device_type`` / ``service`` enum validation are
part of the API contract the frontend depends on and must not drift.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, field_validator

from ..shared import DEVICE_TYPES, SERVICE_TYPES, validate_metadata_size


class FloorPosition(BaseModel):
    """Pixel position on the floor image; ``rotation`` in degrees (facing direction)."""

    model_config = ConfigDict(extra="ignore")

    x: float
    y: float
    rotation: float = 0


class RegisterDeviceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_id: str
    device_type: str
    service: str
    site_id: str
    floor_id: str
    zone_id: Optional[str] = None
    floor_position: FloorPosition
    metadata: Optional[dict[str, Any]] = None

    @field_validator("device_type")
    @classmethod
    def _device_type(cls, v: str) -> str:
        if v not in DEVICE_TYPES:
            raise ValueError(f"device_type must be one of: {sorted(DEVICE_TYPES)}")
        return v

    @field_validator("service")
    @classmethod
    def _service(cls, v: str) -> str:
        if v not in SERVICE_TYPES:
            raise ValueError(f"service must be one of: {sorted(SERVICE_TYPES)}")
        return v

    @field_validator("metadata")
    @classmethod
    def _meta(cls, v):
        return validate_metadata_size(v)


class UpdateDeviceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    floor_position: Optional[FloorPosition] = None
    zone_id: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None

    @field_validator("metadata")
    @classmethod
    def _meta(cls, v):
        return validate_metadata_size(v)


class DevicePlacementPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")

    placement_id: str
    device_id: str
    device_type: str
    service: str
    site_id: str
    floor_id: str
    zone_id: Optional[str] = None
    floor_position: FloorPosition
    metadata: Optional[dict[str, Any]] = None
    status: str
    status_updated_at: Optional[datetime] = None
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "DevicePlacementPublic":
        return cls.model_validate(
            {
                "placement_id": row.placement_id,
                "device_id": row.device_id,
                "device_type": row.device_type,
                "service": row.service,
                "site_id": row.site_id,
                "floor_id": row.floor_id,
                "zone_id": row.zone_id,
                "floor_position": row.floor_position,
                "metadata": row.placement_metadata,
                "status": row.status,
                "status_updated_at": row.status_updated_at,
                "created_by": row.created_by,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class DeviceListResponse(BaseModel):
    items: list[DevicePlacementPublic]
    count: int
