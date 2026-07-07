"""Zone request/response schemas (pydantic)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, field_validator

from ..shared import (
    ThreatLevel,
    ZoneType,
    validate_description,
    validate_geo_polygon,
    validate_name,
)


def _validate_polygon(v: Optional[list[list[float]]]) -> Optional[list[list[float]]]:
    if v is None:
        return None
    if len(v) < 3:
        raise ValueError("Polygon must have at least 3 points")
    for point in v:
        if len(point) != 2:
            raise ValueError("Each polygon point must be [x, y]")
    return v


class CreateZoneRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    site_id: str
    floor_id: str
    name: str
    description: Optional[str] = None
    zone_type: ZoneType = "other"
    threat_level: ThreatLevel = "normal"
    color: Optional[str] = None
    alert_on_entry: bool = False
    alert_on_exit: bool = False
    max_occupancy: Optional[int] = None
    polygon: Optional[list[list[float]]] = None
    geo_polygon: Optional[dict[str, Any]] = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        return validate_name(v, entity="Zone name", required=True) or v

    @field_validator("description")
    @classmethod
    def _desc(cls, v: Optional[str]) -> Optional[str]:
        return validate_description(v)

    @field_validator("polygon")
    @classmethod
    def _polygon(cls, v):
        return _validate_polygon(v)

    @field_validator("geo_polygon")
    @classmethod
    def _geo_polygon(cls, v):
        return validate_geo_polygon(v)


class UpdateZoneRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = None
    description: Optional[str] = None
    zone_type: Optional[ZoneType] = None
    threat_level: Optional[ThreatLevel] = None
    color: Optional[str] = None
    alert_on_entry: Optional[bool] = None
    alert_on_exit: Optional[bool] = None
    max_occupancy: Optional[int] = None
    polygon: Optional[list[list[float]]] = None
    geo_polygon: Optional[dict[str, Any]] = None
    is_active: Optional[bool] = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: Optional[str]) -> Optional[str]:
        return validate_name(v, entity="Zone name", required=False)

    @field_validator("polygon")
    @classmethod
    def _polygon(cls, v):
        return _validate_polygon(v)

    @field_validator("geo_polygon")
    @classmethod
    def _geo_polygon(cls, v):
        return validate_geo_polygon(v)


class ZonePublic(BaseModel):
    model_config = ConfigDict(extra="ignore")

    zone_id: str
    site_id: str
    floor_id: str
    name: str
    description: Optional[str] = None
    zone_type: str
    threat_level: str
    color: Optional[str] = None
    alert_on_entry: bool
    alert_on_exit: bool
    max_occupancy: Optional[int] = None
    polygon: Optional[list[list[float]]] = None
    geo_polygon: Optional[dict[str, Any]] = None
    is_active: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "ZonePublic":
        return cls.model_validate(
            {
                "zone_id": row.zone_id,
                "site_id": row.site_id,
                "floor_id": row.floor_id,
                "name": row.name,
                "description": row.description,
                "zone_type": row.zone_type,
                "threat_level": row.threat_level,
                "color": row.color,
                "alert_on_entry": row.alert_on_entry,
                "alert_on_exit": row.alert_on_exit,
                "max_occupancy": row.max_occupancy,
                "polygon": row.polygon,
                "geo_polygon": row.geo_polygon,
                "is_active": row.is_active,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class ZoneListResponse(BaseModel):
    items: list[ZonePublic]
    total: int
    skip: int
    limit: int
