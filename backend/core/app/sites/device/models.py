"""DevicePlacement ORM — a device plotted onto a floor plan.

This is a placement / position registry — *not* the master device row. The master
device identity + ownership lives in the domain service that owns it (access / vms /
fire); this table records WHERE that device sits on a floor plan and its
visualisation parameters (position, FoV, coverage).

Tenant-scoped: a nullable ``tenant_id`` isolates placements per-tenant even on a
direct by-id fetch, matching the site/floor/zone pattern. Ported from neubit_v2's
``module/sites/device`` (which split a Mongo document + a Postgres ORM) and adapted
to neubit_v3's single async ORM on the shared ``Base`` (portable generic types run
on Postgres and SQLite).

Notes vs v2:
  * ``device_id`` is NOT the primary key here — a device from another service could
    collide across tenants, so the PK is a generated ``placement_id`` and
    ``(tenant_id, device_id)`` is unique. The frontend addresses placements by
    ``device_id`` (its ``/{device_id}`` routes), which is unambiguous within a tenant.
  * The v2 ``metadata`` column keeps its stored name ``metadata`` (SQLAlchemy reserves
    the ``metadata`` attribute, so the python attribute is ``placement_metadata``).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, String, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column

from ...db.base import Base


def _uuid_str() -> str:
    return str(uuid.uuid4())


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class DevicePlacement(Base):
    """One device plotted on a floor plan."""

    __tablename__ = "device_placements"

    placement_id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=_uuid_str
    )
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    device_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    device_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    service: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    site_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    floor_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    zone_id: Mapped[str | None] = mapped_column(String(36), index=True)

    floor_position: Mapped[dict] = mapped_column(JSON, nullable=False)  # {x, y, rotation}
    placement_metadata: Mapped[dict | None] = mapped_column("metadata", JSON)

    status: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=text("'unknown'")
    )
    status_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    created_by: Mapped[str | None] = mapped_column(String(36))
    updated_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
