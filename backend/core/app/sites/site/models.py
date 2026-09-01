"""Site ORM — a physical site / building / campus, top of the site hierarchy.

Tenant-scoped: every row carries a nullable ``tenant_id`` (the owning tenant; NULL
= a platform/super-admin/system row). Reads and by-id lookups go through
``app.tenancy.scope`` so isolation lives in one place.

Portable generic types (Uuid/String/Boolean/DateTime/JSON) keep the same model on
Postgres and SQLite (tests). ``address`` / ``coordinates`` / ``geo_location`` are
JSON blobs (validated by the pydantic schemas before they reach the DB).
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Float,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from ...db.base import Base


def _uuid_str() -> str:
    return str(uuid.uuid4())


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Site(Base):
    """One physical site / building / campus."""

    __tablename__ = "sites"

    site_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: the owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    location_code: Mapped[str | None] = mapped_column(String(64))
    description: Mapped[str | None] = mapped_column(String(2048))
    site_type: Mapped[str] = mapped_column(
        String(64), nullable=False, server_default=text("'building'")
    )
    # hierarchy: region → campus → building.
    parent_id: Mapped[str | None] = mapped_column(String(36), index=True)
    threat_level: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=text("'normal'"), index=True
    )
    threat_level_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    address: Mapped[dict | None] = mapped_column(JSON)
    coordinates: Mapped[dict | None] = mapped_column(JSON)
    geo_location: Mapped[dict | None] = mapped_column(JSON)
    contact_person: Mapped[str | None] = mapped_column(String(255))
    contact_phone: Mapped[str | None] = mapped_column(String(64))
    email_address: Mapped[str | None] = mapped_column(String(320))
    image_url: Mapped[str | None] = mapped_column(String(1024))

    # --- BUILDING FACTS (migration 0018) ---------------------------------------
    # What the building IS, as a physical and commercial thing. These are an
    # OPERATOR'S ASSERTIONS, not measurements, and every one of them is nullable
    # because NULL means NOT RECORDED — a fact this platform must be able to
    # state. Building Intelligence → Ratings divides by `gross_floor_area_sqm`
    # and refuses to produce a rating without it rather than defaulting,
    # estimating or substituting a national average.
    gross_floor_area_sqm: Mapped[float | None] = mapped_column(Float)
    energy_tariff_per_kwh: Mapped[float | None] = mapped_column(Float)
    # Stored beside the tariff rather than assumed: a bare 8.5 is not a price.
    tariff_currency: Mapped[str | None] = mapped_column(String(8))
    occupancy: Mapped[int | None] = mapped_column(Integer)
    # Who last stood behind these numbers, and when. `updated_at` cannot say —
    # it moves when anyone edits a phone number, and a figure a rating divides
    # by deserves its own provenance.
    building_facts_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    building_facts_updated_by: Mapped[str | None] = mapped_column(String(36))

    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true"), index=True
    )
    created_by: Mapped[str | None] = mapped_column(String(36))
    updated_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class SiteTariffSlab(Base):
    """One TIME-OF-USE tariff window for a site (migration 0019).

    The scalar ``Site.energy_tariff_per_kwh`` remains the simple case.
    PRECEDENCE: if any slab whose ``effective_from`` is on or before the date
    being priced exists, the slab set overrides the scalar ENTIRELY for that
    date; an hour no slab covers has NO price — absence, never a fallback into
    the scalar, because blending two assertions prices an hour nobody stated.

    Written only by ``PUT /sites/{id}/tariff-slabs`` — a FULL REPLACE of the
    whole list, so an explicit empty list clears the set (the retraction
    property building-facts established: a wrong rate an operator cannot take
    back is worse than none). ``effective_from`` makes a revision a new
    generation of rows rather than a silent rewrite of history.

    Windows are minutes since midnight: ``end > start`` is ``[start, end)``;
    ``end < start`` WRAPS midnight (22:00 -> 06:00); ``end == start`` is
    refused (a full day is ``0 -> 1440``). THIS TABLE SHIPS EMPTY.
    """

    __tablename__ = "site_tariff_slabs"

    slab_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    site_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    start_minute: Mapped[int] = mapped_column(Integer, nullable=False)
    end_minute: Mapped[int] = mapped_column(Integer, nullable=False)
    rate_per_kwh: Mapped[float] = mapped_column(Float, nullable=False)
    # Beside the rate, never assumed — a bare 8.5 is not a price.
    currency: Mapped[str] = mapped_column(String(8), nullable=False)
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class SiteEmissionFactor(Base):
    """A site's grid emission factor — kg CO2 per kWh (migration 0019).

    ``source`` is REQUIRED: the operator states where the number came from
    (e.g. "CEA CO2 Baseline Database v19"). A factor with no citation is an
    invented figure, which this platform's contracts forbid outright.

    Scalar per ``effective_from`` today. A later time-of-day variant is an
    ADDITION — nullable window columns on this table — not a rewrite; hence
    ``uq(site_id, effective_from)`` rather than a site-wide singleton.
    Written only by ``PUT /sites/{id}/emission-factors`` (full replace; an
    empty list clears). THIS TABLE SHIPS EMPTY.
    """

    __tablename__ = "site_emission_factors"

    factor_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    site_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    kg_co2_per_kwh: Mapped[float] = mapped_column(Float, nullable=False)
    source: Mapped[str] = mapped_column(String(512), nullable=False)
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )

    __table_args__ = (
        UniqueConstraint("site_id", "effective_from", name="uq_site_emission_factors_site_date"),
    )
