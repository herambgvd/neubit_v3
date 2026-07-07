"""Zone ORM — a bounded area on a floor.

Tenant-scoped (nullable ``tenant_id``). ``polygon`` is floor-plan local coords
(``[[x, y], ...]``); ``geo_polygon`` is a GeoJSON polygon for a real-world geofence.
Both are JSON blobs, validated by the pydantic schemas before insert. Portable
generic types run on Postgres and SQLite.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Integer, String, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column

from ...db.base import Base


def _uuid_str() -> str:
    return str(uuid.uuid4())


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Zone(Base):
    """One bounded area on a floor."""

    __tablename__ = "zones"

    zone_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    site_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    floor_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(2048))
    zone_type: Mapped[str] = mapped_column(
        String(64), nullable=False, server_default=text("'other'")
    )
    threat_level: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=text("'normal'")
    )
    color: Mapped[str | None] = mapped_column(String(32))  # hex for floor-plan render
    alert_on_entry: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    alert_on_exit: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    max_occupancy: Mapped[int | None] = mapped_column(Integer)

    polygon: Mapped[list | None] = mapped_column(JSON)  # floor-plan local coords
    geo_polygon: Mapped[dict | None] = mapped_column(JSON)  # GeoJSON real-world geofence

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
