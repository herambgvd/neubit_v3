"""Site request/response schemas (pydantic).

``Address`` / ``Coordinates`` / ``GeoPoint`` are the nested value objects stored in
the JSON columns; validation (coordinate ranges, name/description length, email) is
identical to neubit_v2 so the API contract is unchanged.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ...core.fields import AsciiEmail
from ..shared import (
    SiteType,
    ThreatLevel,
    validate_description,
    validate_name,
    validate_phone,
    validate_short,
    validate_zip_code,
)


class Address(BaseModel):
    model_config = ConfigDict(extra="ignore")
    street: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip_code: Optional[str] = None
    country: Optional[str] = "India"


class AddressIn(Address):
    """Write-side address. The zip rule lives here, not on ``Address``, so rows
    saved before the rule existed still deserialize into ``SitePublic``."""

    @field_validator("zip_code")
    @classmethod
    def _zip(cls, v: Optional[str]) -> Optional[str]:
        return validate_zip_code(v)


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
    address: Optional[AddressIn] = None
    coordinates: Optional[Coordinates] = None
    contact_person: Optional[str] = None
    contact_phone: Optional[str] = None
    email_address: Optional[AsciiEmail] = None
    image_url: Optional[str] = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        return validate_name(v, entity="Site name", required=True) or v

    @field_validator("description")
    @classmethod
    def _desc(cls, v: Optional[str]) -> Optional[str]:
        return validate_description(v)

    @field_validator("contact_person")
    @classmethod
    def _shorts(cls, v: Optional[str]) -> Optional[str]:
        return validate_short(v)

    @field_validator("contact_phone")
    @classmethod
    def _phone(cls, v: Optional[str]) -> Optional[str]:
        return validate_phone(validate_short(v))


class UpdateSiteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = None
    location_code: Optional[str] = None
    description: Optional[str] = None
    site_type: Optional[SiteType] = None
    parent_id: Optional[str] = None
    threat_level: Optional[ThreatLevel] = None
    address: Optional[AddressIn] = None
    coordinates: Optional[Coordinates] = None
    contact_person: Optional[str] = None
    contact_phone: Optional[str] = None
    email_address: Optional[AsciiEmail] = None
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

    @field_validator("contact_person")
    @classmethod
    def _shorts(cls, v: Optional[str]) -> Optional[str]:
        return validate_short(v)

    @field_validator("contact_phone")
    @classmethod
    def _phone(cls, v: Optional[str]) -> Optional[str]:
        return validate_phone(validate_short(v))


class BuildingFactsUpdate(BaseModel):
    """The building facts, written as a SET rather than as a patch.

    Its own request (and its own route) for one reason: ``UpdateSiteRequest``
    is applied with ``exclude_none=True``, so on that path a null can never be
    SENT — you can change an area but not take one back. For a figure a rating
    divides by, "I recorded 12000 by mistake and there is no reliable number"
    has to be sayable. Here an explicit ``null`` CLEARS the value and the site
    returns to "no area recorded", which is a first-class state.

    Nothing here is inferred and nothing has a default. A tariff without a
    currency is refused rather than assumed to be rupees.
    """

    model_config = ConfigDict(extra="forbid")

    gross_floor_area_sqm: Optional[float] = Field(default=None, gt=0, le=10_000_000)
    energy_tariff_per_kwh: Optional[float] = Field(default=None, gt=0, le=1_000_000)
    tariff_currency: Optional[str] = Field(default=None, min_length=1, max_length=8)
    occupancy: Optional[int] = Field(default=None, ge=0, le=10_000_000)

    @field_validator("tariff_currency")
    @classmethod
    def _cur(cls, v: Optional[str]) -> Optional[str]:
        return v.strip().upper() if v and v.strip() else None


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
    # --- BUILDING FACTS (migration 0018) ------------------------------------
    # Null means NOT RECORDED, everywhere, and every consumer must render it as
    # such. Building Intelligence → Ratings divides by `gross_floor_area_sqm`
    # and produces NO rating when it is null — never a default, never an
    # estimate, never a national average.
    gross_floor_area_sqm: Optional[float] = None
    energy_tariff_per_kwh: Optional[float] = None
    tariff_currency: Optional[str] = None
    occupancy: Optional[int] = None
    building_facts_updated_at: Optional[datetime] = None
    building_facts_updated_by: Optional[str] = None
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
                "gross_floor_area_sqm": row.gross_floor_area_sqm,
                "energy_tariff_per_kwh": row.energy_tariff_per_kwh,
                "tariff_currency": row.tariff_currency,
                "occupancy": row.occupancy,
                "building_facts_updated_at": row.building_facts_updated_at,
                "building_facts_updated_by": row.building_facts_updated_by,
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


# ── Time-of-Use tariff slabs (migration 0019) ─────────────────────────────────
#
# The scalar `energy_tariff_per_kwh` above stays: it is the legitimate simple
# case. PRECEDENCE: if any slab with `effective_from` on or before the date
# being priced exists, the slab set overrides the scalar ENTIRELY for that
# date; an hour no slab covers has NO price (absence, never a fallback into the
# scalar). The scalar applies only when no slab set is in effect.
#
# `PUT /sites/{id}/tariff-slabs` is a FULL REPLACE — the same retraction
# property as building-facts: an explicit empty list clears the set, because a
# wrong rate an operator cannot take back is worse than none.


class TariffSlabIn(BaseModel):
    """One window. Minutes since midnight; `end < start` WRAPS midnight
    (22:00 → 06:00); `end == start` is refused (full day is 0 → 1440).

    Coverage of the 24h cycle is NOT enforced here: a partial tariff is a
    partial statement, and the UI warns about gaps/overlaps rather than the
    server inventing filler slabs.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=64)
    start_minute: int = Field(ge=0, lt=1440)
    end_minute: int = Field(gt=0, le=1440)
    rate_per_kwh: float = Field(gt=0, le=1_000_000)
    currency: str = Field(min_length=1, max_length=8)
    effective_from: date

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("A slab needs a name")
        return v

    @field_validator("currency")
    @classmethod
    def _cur(cls, v: str) -> str:
        v = v.strip().upper()
        if not v:
            raise ValueError("A rate needs a currency — a bare 8.5 is not a price")
        return v

    @field_validator("end_minute")
    @classmethod
    def _window(cls, v: int, info) -> int:
        start = info.data.get("start_minute")
        if start is not None and v == start:
            raise ValueError(
                "A window cannot start and end at the same minute — use 0 → 1440 for a full day"
            )
        return v


class TariffSlabsUpdate(BaseModel):
    """The whole list, every time. An empty list CLEARS the site's slabs and
    the scalar tariff (if recorded) is in effect again."""

    model_config = ConfigDict(extra="forbid")

    slabs: list[TariffSlabIn] = Field(max_length=200)


class TariffSlabPublic(BaseModel):
    model_config = ConfigDict(extra="ignore", from_attributes=True)

    slab_id: str
    site_id: str
    name: str
    start_minute: int
    end_minute: int
    rate_per_kwh: float
    currency: str
    effective_from: date
    position: int
    created_at: datetime


class TariffSlabListResponse(BaseModel):
    items: list[TariffSlabPublic]
    total: int


# ── Emission factors (migration 0019) ─────────────────────────────────────────


class EmissionFactorIn(BaseModel):
    """kg CO2 per kWh with a REQUIRED source. The operator says where the
    number came from; a factor with no citation is an invented figure and the
    platform refuses to hold one. One factor per `effective_from` — two on the
    same date would be a contradiction, not a history."""

    model_config = ConfigDict(extra="forbid")

    kg_co2_per_kwh: float = Field(gt=0, le=1000)
    source: str = Field(min_length=3, max_length=512)
    effective_from: date

    @field_validator("source")
    @classmethod
    def _source(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 3:
            raise ValueError(
                "A factor needs its source — where does this number come from?"
            )
        return v


class EmissionFactorsUpdate(BaseModel):
    """Full replace; an empty list clears (the retraction property)."""

    model_config = ConfigDict(extra="forbid")

    factors: list[EmissionFactorIn] = Field(max_length=50)


class EmissionFactorPublic(BaseModel):
    model_config = ConfigDict(extra="ignore", from_attributes=True)

    factor_id: str
    site_id: str
    kg_co2_per_kwh: float
    source: str
    effective_from: date
    created_at: datetime


class EmissionFactorListResponse(BaseModel):
    items: list[EmissionFactorPublic]
    total: int
