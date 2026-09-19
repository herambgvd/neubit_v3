"""Infrastructure ORM — the equipment registry of a site.

Three tables, each a strictly narrower statement than the one above it:

  * ``site_systems``       — a SYSTEM on a site: one chilled-water loop, the air
    handling, the power chain. Its ``kind`` decides which equipment may sit in it.
  * ``site_equipment``     — a piece of EQUIPMENT in a system: chiller CH-01, with
    a closed ``equipment_class`` and a ``design`` object of nameplate facts.
  * ``equipment_point_slots`` — a named SLOT on that equipment (``chws``, ``kw``…),
    optionally BOUND to a point by the gateway's ``device_tag`` + ``point_tag``.

WHY A SLOT BINDS BY TAG AND NOT BY POINT ID
-------------------------------------------
``neubit_reporting.points.point_id`` is not stable. This estate's gateway re-keys
every point when it rebuilds its connection, and on 11 Sept that orphaned every
metric-role binding held by uuid: the rows still pointed at ids nothing published
any more, and nothing said so. The tags are what the gateway is CONFIGURED with —
the name an integrator typed — and they survive a rebuild because the rebuild
reads them back from the same configuration. So the tag pair is the durable name
of a point, and the uuid is a cache of it that a consumer resolves at read time
(``WHERE retired_at IS NULL``). Core cannot hold a point uuid anyway without
reading ``neubit_reporting``, which the cross-service read ban forbids.

The price of binding by tag is that a tag pair is not guaranteed unique in the
reporting store. That is the resolver's problem to report, and it is stated in the
event contract; what core guarantees is that ONE tag pair feeds at most ONE slot
per tenant (``uq_equipment_point_slots_binding``), because a kW point bound to two
chillers is counted twice in plant kW and nothing downstream could tell.

No ForeignKey to ``sites``: no sites table carries one (see erasure.py), and a
site is soft-deleted, never removed. The three tables DO reference each other,
ON DELETE CASCADE, so a psql ``DELETE`` of a system cannot leave equipment that
names a system nobody can see. The service still deletes children explicitly,
because SQLite — the test database — does not enforce foreign keys.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    ForeignKey,
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


class SiteSystem(Base):
    """A system on a site — one loop, one fleet, one chain."""

    __tablename__ = "site_systems"
    __table_args__ = (
        # The name is how an operator and an imported schedule refer to a system,
        # so two with one name on one site would make "Plant A" mean either.
        UniqueConstraint("site_id", "name", name="uq_site_systems_site_name"),
    )

    system_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    site_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500))

    created_by: Mapped[str | None] = mapped_column(String(36))
    updated_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class SiteEquipment(Base):
    """One piece of equipment, in one system."""

    __tablename__ = "site_equipment"
    __table_args__ = (
        # The tag is the equipment's name on the drawings (CH-01) and the key an
        # I/O schedule groups its rows by. Unique per SITE, not per system: two
        # CH-01s in one building are one mislabelled drawing, not two chillers.
        UniqueConstraint("site_id", "tag", name="uq_site_equipment_site_tag"),
    )

    equipment_id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=_uuid_str
    )
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    # Denormalised from the system so a site's whole registry is one indexed read
    # and a tenant/site check never needs a join.
    site_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    system_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("site_systems.system_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    tag: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str | None] = mapped_column(String(100))
    equipment_class: Mapped[str] = mapped_column(String(32), nullable=False)

    # WHAT FEEDS IT — the one piece of equipment upstream of this one on the
    # same site: the sub-incomer a distribution board hangs off, the incomer a
    # sub-incomer hangs off. It is what turns a list of meters into a power
    # chain a person can read, and what lets the plant view draw a single-line.
    #
    # ONE parent, not many: a board is fed from one breaker. Where a thing
    # genuinely has several upstream sources (chillers into a header) the
    # relation is the SYSTEM, not this column. Nothing here is inferred: a name
    # like "4F-3F Light DB" can SUGGEST its sub-incomer, and a person says so.
    # SET NULL on delete — a parent that is removed leaves its children
    # unattached rather than taking them with it.
    fed_by_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("site_equipment.equipment_id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    # Nameplate facts, validated against vocabulary.DESIGN_FACTS before insert.
    # NOT NULL with `{}` for "nothing recorded" — one spelling of "no facts" where
    # a nullable column would offer three (SQL NULL, JSON null, `{}`).
    #
    # `none_as_null=True` ON A NOT NULL COLUMN IS STILL LOAD-BEARING. It is the
    # trap migration 0031 documents from the other side: without it SQLAlchemy
    # writes a python None as the JSON scalar `null`, which is a VALUE, so NOT
    # NULL lets it through and the row holds a design that is neither an object
    # nor absent. With the flag a None means "no value": on INSERT the ORM leaves
    # the column out and the server default `{}` is written; on UPDATE it is SQL
    # NULL and the constraint refuses it.
    design: Mapped[dict] = mapped_column(
        JSON(none_as_null=True), nullable=False, server_default=text("'{}'")
    )

    created_by: Mapped[str | None] = mapped_column(String(36))
    updated_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class EquipmentPointSlot(Base):
    """A named slot on a piece of equipment, bound to a point or not yet."""

    __tablename__ = "equipment_point_slots"
    __table_args__ = (
        UniqueConstraint("equipment_id", "slot", name="uq_equipment_point_slots_slot"),
        # One point, one slot, per tenant. NULLs are distinct in a unique index on
        # both Postgres and SQLite, so any number of unbound slots coexist.
        UniqueConstraint(
            "tenant_id", "device_tag", "point_tag", name="uq_equipment_point_slots_binding"
        ),
        # Half a binding names no point: a device tag alone matches every point
        # on the device, a point tag alone may match one on every device.
        CheckConstraint(
            "(device_tag IS NULL) = (point_tag IS NULL)",
            name="ck_equipment_point_slots_binding_whole",
        ),
    )

    slot_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    site_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    equipment_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("site_equipment.equipment_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    slot: Mapped[str] = mapped_column(String(32), nullable=False)
    # 255 to match `neubit_reporting.points.device_tag/point_tag`, the columns a
    # binding is resolved against. Case and inner spaces are kept exactly — the
    # gateway's tags are spelled `1FYC1 EM - Total kW`, and a normalised copy would
    # match nothing. Only OUTER whitespace is trimmed (schemas.py), which no live
    # tag carries (0 of 851 on 2026-09-19) and a spreadsheet cell often does.
    device_tag: Mapped[str | None] = mapped_column(String(255))
    point_tag: Mapped[str | None] = mapped_column(String(255))

    created_by: Mapped[str | None] = mapped_column(String(36))
    updated_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
