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
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, String, Uuid, text
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
