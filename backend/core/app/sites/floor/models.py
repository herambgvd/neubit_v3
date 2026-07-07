"""Floor ORM — a level within a site (holds a floor-plan + zones).

Tenant-scoped: a nullable ``tenant_id`` mirrors the owning site's tenant so floors
are isolated per-tenant even on a direct by-id fetch. Portable generic types keep
the model runnable on Postgres and SQLite.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column

from ...db.base import Base


def _uuid_str() -> str:
    return str(uuid.uuid4())


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Floor(Base):
    """One level within a site."""

    __tablename__ = "floors"

    floor_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    site_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    floor_number: Mapped[int | None] = mapped_column(Integer)
    description: Mapped[str | None] = mapped_column(String(2048))
    floorplan_url: Mapped[str | None] = mapped_column(String(1024))
    total_area: Mapped[float | None] = mapped_column(Float)  # square meters

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
