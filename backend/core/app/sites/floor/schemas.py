"""Floor request/response schemas (pydantic)."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, field_validator

from ..shared import validate_description, validate_name


class CreateFloorRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    site_id: str
    name: str
    floor_number: Optional[int] = None
    description: Optional[str] = None
    floorplan_url: Optional[str] = None
    total_area: Optional[float] = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        return validate_name(v, entity="Floor name", required=True) or v

    @field_validator("description")
    @classmethod
    def _desc(cls, v: Optional[str]) -> Optional[str]:
        return validate_description(v)

    @field_validator("floor_number")
    @classmethod
    def _floor_number(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and v < -5:
            raise ValueError("Floor number cannot be less than -5 (basement limit)")
        return v

    @field_validator("total_area")
    @classmethod
    def _area(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and v <= 0:
            raise ValueError("Total area must be positive")
        return v


class UpdateFloorRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = None
    floor_number: Optional[int] = None
    description: Optional[str] = None
    floorplan_url: Optional[str] = None
    total_area: Optional[float] = None
    is_active: Optional[bool] = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: Optional[str]) -> Optional[str]:
        return validate_name(v, entity="Floor name", required=False)

    @field_validator("floor_number")
    @classmethod
    def _floor_number(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and v < -5:
            raise ValueError("Floor number cannot be less than -5 (basement limit)")
        return v

    @field_validator("total_area")
    @classmethod
    def _area(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and v <= 0:
            raise ValueError("Total area must be positive")
        return v


class FloorPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")

    floor_id: str
    site_id: str
    name: str
    floor_number: Optional[int] = None
    description: Optional[str] = None
    floorplan_url: Optional[str] = None
    total_area: Optional[float] = None
    is_active: bool
    created_at: datetime
    updated_at: datetime
    zone_count: int = 0

    @classmethod
    def from_row(cls, row, *, zone_count: int = 0) -> "FloorPublic":
        return cls.model_validate(
            {
                "floor_id": row.floor_id,
                "site_id": row.site_id,
                "name": row.name,
                "floor_number": row.floor_number,
                "description": row.description,
                "floorplan_url": row.floorplan_url,
                "total_area": row.total_area,
                "is_active": row.is_active,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
                "zone_count": zone_count,
            }
        )


class FloorListResponse(BaseModel):
    items: list[FloorPublic]
    total: int
    skip: int
    limit: int
