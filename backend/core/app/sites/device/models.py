"""DevicePlacement ORM — a device plotted onto a floor plan.

This is a placement / position registry — *not* the master device row. The master
device identity + ownership lives in the domain service that owns it (access / vms /
fire); this table records WHERE that device sits on a floor plan and its
visualisation parameters (position, FoV, coverage).

Tenant-scoped: a nullable ``tenant_id`` isolates placements per-tenant even on a
direct by-id fetch, matching the site/floor/zone pattern.

THREE STATEMENTS OF INCREASING PRECISION, NOT ONE STATEMENT WITH THREE PARTS
-----------------------------------------------------------------------------
``floor_id`` and ``floor_position`` were both NOT NULL, which made a placement and
a PIN the same thing: a device could not be recorded as belonging to a building
until somebody had drawn that building's floor plan and dragged the device onto
it at ``{x, y, rotation}``. Building Intelligence needs the SITE — EPI is kWh per
square metre of a BUILDING — and the drawing answers a rarer question.

Since migration 0031 the row holds whichever of these an operator can honestly
make, and each is a complete answer rather than an unfinished version of the next:

  * **a site** — "this meter is in Aeon Tower". Enough for EPI, for every rating
    and for every portfolio row.
  * **a site and a floor** — "…on Level 4". Enough for every floor-wise question
    Building Intelligence asks. It needs NO drawing: requiring ``{x, y}`` to say
    which storey something is on forces an operator to invent a coordinate or
    stay silent, which is the same failure as requiring a drawing to say which
    building it is in, one level down.
  * **a site, a floor and a position** — the pin. What the floor-plan editor
    writes, and the only one of the three that needs an uploaded plan.

The single thing that is refused is a ``floor_position`` with no ``floor_id``:
coordinates on nothing. That is not a weaker statement, it is a meaningless one —
an x/y is only an x/y ON some image. It is a CHECK constraint rather than a rule
in ``service.py`` because the API is not the only writer a database sees over its
life; a migration, a psql session and a future importer are others.

A ``zone_id`` needs a floor for the same reason it always did — ``zones.floor_id``
is itself NOT NULL, so a zone with no floor names a room in no storey.

Two more things to know:
  * ``device_id`` is not the primary key — a device from another service could
    collide across tenants, so the PK is a generated ``placement_id`` and
    ``(tenant_id, device_id)`` is unique. The frontend addresses placements by
    ``device_id``, which is unambiguous within a tenant.
  * the column is stored as ``metadata``, but SQLAlchemy reserves that attribute
    name, so the python attribute is ``placement_metadata``.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, CheckConstraint, DateTime, String, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column

from ...db.base import Base


def _uuid_str() -> str:
    return str(uuid.uuid4())


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class DevicePlacement(Base):
    """Where a device is: a site, optionally a floor, optionally a pin on it."""

    __tablename__ = "device_placements"

    __table_args__ = (
        # A position is a position ON a floor. Without one it is coordinates on
        # nothing — meaningless rather than imprecise, which is why this is the
        # one combination refused. The reverse (a floor with no position) is a
        # real and common statement: "on Level 4, not on any drawing".
        CheckConstraint(
            "floor_position IS NULL OR floor_id IS NOT NULL",
            name="ck_device_placements_pin_is_whole",
        ),
        # `zones.floor_id` is NOT NULL, so a zone that names no floor names a
        # room in no storey.
        CheckConstraint(
            "zone_id IS NULL OR floor_id IS NOT NULL",
            name="ck_device_placements_zone_needs_floor",
        ),
    )

    placement_id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=_uuid_str
    )
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    # 128, not 36: a recorder-owned camera's estate id is the composite
    # `fed:<node>:<camera>` — two UUIDs and a prefix — and that is the id the floor
    # builder offers and `useCameraSites` joins on. See migration 0029.
    device_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    device_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    service: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    # The site is the placement. Everything below it is optional detail about
    # WHERE IN the site, and each level is a strictly stronger statement than the
    # one above it — never a prerequisite for it.
    site_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    floor_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    zone_id: Mapped[str | None] = mapped_column(String(36), index=True)

    # {x, y, rotation} on the floor image. Present only when somebody actually
    # dragged this device onto a drawing; NULL on a site-only placement AND on a
    # floor-only one.
    #
    # `none_as_null=True` IS LOAD-BEARING, not tidiness. SQLAlchemy's JSON type
    # persists a python ``None`` as the JSON scalar ``null`` by default — a value,
    # not an absence — which is indistinguishable from a real position to every
    # ``IS NULL`` ever written against this column. Two things break without it,
    # and both break in Postgres rather than here: the check constraint above
    # reads a floor-less row as carrying coordinates and rejects it, and every
    # "is this device pinned?" question answers yes for every unpinned device in
    # the estate.
    floor_position: Mapped[dict | None] = mapped_column(
        JSON(none_as_null=True), nullable=True
    )
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
