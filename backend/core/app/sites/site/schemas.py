"""Site request/response schemas (pydantic).

``Address`` / ``Coordinates`` / ``GeoPoint`` are the nested value objects stored in
the JSON columns; validation (coordinate ranges, name/description length, email) is
identical to neubit_v2 so the API contract is unchanged.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from ..shared import (
    SiteType,
    ThreatLevel,
    validate_description,
    validate_name,
    validate_short,
)


class Address(BaseModel):
    model_config = ConfigDict(extra="ignore")
    street: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip_code: Optional[str] = None
    country: Optional[str] = "India"


class Coordinates(BaseModel):
    """Latitude/longitude pair, validated to within Earth bounds."""

    model_config = ConfigDict(extra="ignore")
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class GeoPoint(BaseModel):
    """GeoJSON Point — derived from Coordinates for spatial indexing."""

    model_config = ConfigDict(extra="ignore")
    type: str = "Point"
    coordinates: list[float]  # [lng, lat]


class CreateSiteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    location_code: Optional[str] = None
    description: Optional[str] = None
    site_type: SiteType = "building"
    parent_id: Optional[str] = None
    threat_level: ThreatLevel = "normal"
    address: Optional[Address] = None
    coordinates: Optional[Coordinates] = None
    contact_person: Optional[str] = None
    contact_phone: Optional[str] = None
    email_address: Optional[EmailStr] = None
    image_url: Optional[str] = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        return validate_name(v, entity="Site name", required=True) or v

    @field_validator("description")
    @classmethod
    def _desc(cls, v: Optional[str]) -> Optional[str]:
        return validate_description(v)

    @field_validator("contact_person", "contact_phone")
    @classmethod
    def _shorts(cls, v: Optional[str]) -> Optional[str]:
        return validate_short(v)


class UpdateSiteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = None
    location_code: Optional[str] = None
    description: Optional[str] = None
    site_type: Optional[SiteType] = None
    parent_id: Optional[str] = None
    threat_level: Optional[ThreatLevel] = None
    address: Optional[Address] = None
    coordinates: Optional[Coordinates] = None
    contact_person: Optional[str] = None
    contact_phone: Optional[str] = None
    email_address: Optional[EmailStr] = None
    image_url: Optional[str] = None
    is_active: Optional[bool] = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: Optional[str]) -> Optional[str]:
        return validate_name(v, entity="Site name", required=False)

    @field_validator("description")
    @classmethod
    def _desc(cls, v: Optional[str]) -> Optional[str]:
        return validate_description(v)


class ThreatLevelUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    threat_level: ThreatLevel


class SitePublic(BaseModel):
    model_config = ConfigDict(extra="ignore")

    site_id: str
    name: str
    location_code: Optional[str] = None
    description: Optional[str] = None
    site_type: str
    parent_id: Optional[str] = None
    threat_level: str
    address: Optional[Address] = None
    coordinates: Optional[Coordinates] = None
    contact_person: Optional[str] = None
    contact_phone: Optional[str] = None
    email_address: Optional[str] = None
    image_url: Optional[str] = None
    is_active: bool
    created_at: datetime
    updated_at: datetime
    floor_count: int = 0

    @classmethod
    def from_row(cls, row, *, floor_count: int = 0) -> "SitePublic":
        return cls.model_validate(
            {
                "site_id": row.site_id,
                "name": row.name,
                "location_code": row.location_code,
                "description": row.description,
                "site_type": row.site_type,
                "parent_id": row.parent_id,
                "threat_level": row.threat_level,
                "address": row.address,
                "coordinates": row.coordinates,
                "contact_person": row.contact_person,
                "contact_phone": row.contact_phone,
                "email_address": row.email_address,
                "image_url": row.image_url,
                "is_active": row.is_active,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
                "floor_count": floor_count,
            }
        )


class SiteListResponse(BaseModel):
    items: list[SitePublic]
    total: int
    skip: int
    limit: int
