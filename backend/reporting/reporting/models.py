"""ORM models for the reporting store.

Two tables, and the split between them is the whole design:

``readings``  — the fact table. One row per reading, deliberately NARROW.
                What decides whether this stays fast is CARDINALITY (distinct
                series), not rows/sec, and every extra column multiplies the
                cost of every one of those rows. So: timestamp, tenant, point,
                value, quality. Nothing else.

``points``    — the dimension table, keyed by ``point_id``. Device, tags, unit,
                category, type, gateway connection. Renaming a device rewrites
                ONE row here instead of a hundred million rows over there.

Why ``num`` and ``txt`` are separate columns (contract §3/§5 — do not collapse
this): a text reading (a mode, a status string) carries no measurement. The
gateway's envelope deliberately omits ``v`` when ``kind == "text"``, because
publishing ``"v": 0`` for a status is a number nobody measured. The schema
mirrors that: a text reading has ``num IS NULL`` and ``txt`` set; a numeric
reading has ``num`` set and ``txt IS NULL``. Coercing a text reading to 0 would
put a fake zero into every min/avg on the dashboard.

``ts`` is the reading's OWN timestamp — when it was measured, not when it was
published or written. Replay from the gateway's outbox can deliver a reading
minutes late and the row must still say when it happened.

``PRIMARY KEY (point_id, ts)`` is not decoration. Replays from the outbox are
expected and normal, so the writer inserts with ``ON CONFLICT DO NOTHING`` and
lets the database make a redelivery a no-op.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    Index,
    Integer,
    PrimaryKeyConstraint,
    SmallInteger,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from reporting.db import Base


class Point(Base):
    """Dimension row for one measurement point. Keyed by the gateway's point_id.

    Everything that is not a measurement lives here. The writer upserts this row
    from the message when it sees an unknown ``point_id`` (contract §6) — dropping
    a reading because its dimension row has not arrived yet is the wrong trade.
    """

    __tablename__ = "points"

    point_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)

    # Tenant that owns the point. Every query filters on this.
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    # The gateway connection (conflux conn_id) this point arrives on.
    conn_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)

    # Owning device.
    device_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    device_tag: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # The point's own tag, e.g. "PF_pf". Unique only within a device.
    point_tag: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Engineering unit ("kW", "degC", ""). Free text.
    #
    # NULL means NOBODY HAS SAID — which is the state of all 314 points on this
    # deployment, because the source payloads carry no `env.u` (contract
    # §11/§12). It is never filled by inference: `KWH_kwh` and `Freq_Hz` look
    # like they carry their unit, and Building Intelligence offers exactly that
    # reading as a SUGGESTION for an operator to confirm — but a naming
    # convention is a convention, not evidence (`4F-3F AC DB` names two floors),
    # so nothing writes it without a human saying so.
    unit: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # WHO said it (migration 0012). NULL = unconfirmed; "reading" = it arrived in
    # `env.u`; "operator" = a human asserted it through /bi/units/confirm.
    #
    # This is load-bearing, not metadata. The writer's upsert refuses to change a
    # unit marked "operator" AT ALL — plain COALESCE would only stop a message
    # that says NOTHING from blanking it, and an operator's assertion being
    # erased by a message that says something DIFFERENT is the worst outcome this
    # feature can have.
    unit_source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    unit_confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    unit_confirmed_by: Mapped[str | None] = mapped_column(String(320), nullable=True)

    # What the DEVICE is (contract §11), as the gateway classifies it. These are
    # what Building Intelligence filters its category views on — HVAC & Assets,
    # Energy & Metering, IAQ & Environment — and the gateway is their only
    # source: nothing on the platform can derive them.
    #
    # `category` is the BI domain and comes from a closed-ish vocabulary the
    # gateway seeds ("energy", "hvac", "water", "fire", ...). `device_type` is
    # the equipment kind ("meter", "chiller", "ups") and is open text.
    #
    # The writer treats a MISSING value as "unknown" and never overwrites a
    # stored one with NULL (see reading-writer's store.py): an operator can
    # correct a classification, and the next reading must not wipe it. A CHANGED
    # value does follow — a reclassified meter shows up here.
    category: Mapped[str | None] = mapped_column(String(128), nullable=True)
    device_type: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # The READING KIND — "num" or "text" — i.e. which of readings.num/readings.txt
    # this point fills. NOT the device type; those are two different things and
    # this column is deliberately not overloaded with the other one.
    type: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # ── WHERE the point is ───────────────────────────────────────────────
    #
    # The spatial anchor: which site, floor and zone (in `neubit_control`) this
    # point's device sits in. Every serious building surface — a site selector, a
    # floor-wise breakdown — is built on this axis, and without it none of it is
    # expressible.
    #
    # NULL means UNPLACED, and it is the honest default. Nothing on the gateway
    # wire carries a placement: conflux knows a device's connection, tag,
    # category and equipment kind and has no field in which to say which floor it
    # is on. Inferring one from a tag (`4F Khem Chiller01`) would place most of an
    # estate correctly and the rest silently wrongly, and a floor-wise chart that
    # is wrong for one floor in five is worse than one that says "unplaced".
    #
    # THE WRITER NEVER AUTHORS THESE. `reading-writer`'s points upsert names its
    # columns explicitly and these six are not among them, so a reading cannot
    # blank a placement — the same failure the `category` COALESCE prevents,
    # avoided here by construction. A placement is an operator's statement about
    # the building, not something the gateway reports.
    #
    # They are a DERIVATION of `device_locations` (migration 0010), which is
    # where an operator's statement actually lands. The writer runs
    # `reporting.placement.reconcile_placement()` over the points it upserted so
    # that a NEW point inherits the placement its device already has — the only
    # way a placement travels to a point that did not exist when it was made.
    # That is not authorship: the statement's only source is `device_locations`,
    # and a message can neither carry a placement nor move one.
    #
    # The `_name` copies exist because this store may not look them up: sites and
    # floors live in `neubit_control` and the platform bans cross-service reads.
    # Same rule as the access projection's `door_name` — whoever writes a
    # placement writes the label with it, or every floor legend reads `a7f3…`.
    # The copy can go stale on a rename; grouping is on the id, the name is only
    # ever displayed.
    site_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    site_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    floor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    floor_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    zone_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    zone_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # How the six columns above got their values, and therefore whether they may
    # be recomputed:
    #
    #   NULL      derived from this point's device (or unplaced, which is the
    #             same statement made about nothing)
    #   'device'  derived from `device_locations`
    #   'point'   an operator placed THIS POINT explicitly — an override for the
    #             sub-meter that is genuinely not where its panel is. The
    #             reconcile never touches a row marked this way.
    placement_source: Mapped[str | None] = mapped_column(String(16), nullable=True)

    # Anything else the gateway knows that is not worth a column yet. Kept out of
    # the fact table on purpose.
    meta: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    # When an operator RETIRED this point. NULL = live and counted in every
    # Building Intelligence figure; non-NULL = excluded from those counts while
    # every reading it ever produced stays exactly where it is.
    #
    # This is only the EXPLICIT half of retirement. The other half is a horizon:
    # a point whose `last_seen_at` is older than VE_READINGS_RETIRE_AFTER_DAYS is
    # treated as retired at query time without writing anything here, so a
    # building full of decommissioned meters does not need an operator to walk
    # it. Both halves self-heal — the writer clears `retired_at` the moment a
    # reading arrives, because a point that is reporting is not retired,
    # whatever anyone said about it last month.
    retired_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        Index("ix_points_tenant", "tenant_id"),
        Index("ix_points_conn", "conn_id"),
        Index("ix_points_device", "device_id"),
        # "show me the points on this device, by tag" — the browse path.
        Index("ix_points_tenant_device_tag", "tenant_id", "device_tag", "point_tag"),
        # "every point in this tenant's Energy & Metering view" — the BI filter.
        Index("ix_points_tenant_category", "tenant_id", "category"),
        # "every point on this site / on this floor" — the two scopes a building
        # console filters on. Zone is deliberately unindexed: it is only ever
        # reached through a floor, and an index nothing uses is a write cost.
        Index("ix_points_tenant_site", "tenant_id", "site_id"),
        Index("ix_points_tenant_floor", "tenant_id", "floor_id"),
        # The live set, which is what every BI count actually reads. Partial:
        # almost every point is live, so the retired tail costs nothing to carry.
        Index(
            "ix_points_tenant_live",
            "tenant_id",
            "last_seen_at",
            postgresql_where=text("retired_at IS NULL"),
        ),
    )


class Reading(Base):
    """One reading. Hypertable, partitioned on ``ts``, 1-day chunks.

    NOTE: the hypertable conversion, the continuous aggregates and the
    compression/retention policies are NOT expressible in SQLAlchemy metadata —
    they live in the Alembic revisions (0001 / 0002). This class defines the
    columns and the primary key only.
    """

    __tablename__ = "readings"

    # Measurement time (contract §3). Partition key, and the trailing half of the
    # primary key. Declared first because that is the column order in the contract.
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    # Denormalised so a tenant-scoped query never has to join the dimension table.
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    # Point this reading belongs to. Deliberately NOT a foreign key to `points`:
    # a FK check on every insert would serialise the batch write path against the
    # dimension table, and the writer upserts the dimension row itself.
    point_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    # Numeric reading. NULL for a text reading — never 0. See the module docstring.
    num: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Text reading (mode / status). NULL for a numeric reading.
    txt: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Envelope quality flag (`q`). 0 = good.
    quality: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")

    __table_args__ = (
        # PRIMARY KEY (point_id, ts), in that order — the contract's key. Declared
        # explicitly rather than via two primary_key=True columns because SQLAlchemy
        # would otherwise order the key by column-definition order (ts, point_id),
        # which is the wrong index for "one point over a time range".
        PrimaryKeyConstraint("point_id", "ts", name="readings_pkey"),
        # Tenant-wide scans over a window, without touching `points`.
        Index("ix_readings_tenant_ts", "tenant_id", "ts"),
    )


class DeviceLocation(Base):
    """WHERE a device is — the join between the gateway's id and the building.

    This is the TRUTH about placement (migration 0010). ``points.site_id`` /
    ``floor_id`` / ``zone_id`` are a derivation of it, recomputed by
    ``reporting.placement.reconcile_placement``.

    **Device-level, not point-level, and that is the design.** A placement is a
    fact about a box, not about each of the box's measurements: this estate is 29
    devices and 314 points, and ``4F_Solar_Panel01``'s 21 points are all in the
    same room. Point-level precision is still reachable — a point row marked
    ``placement_source='point'`` is an explicit override the reconcile never
    touches — but it is the exception, not the unit of work.

    **The two halves come from two systems.** ``device_id`` is conflux's; the
    site / floor / zone ids are ``neubit_control``'s. Neither database can
    validate the other's id, which is why the row carries ``placed_by`` and
    ``placed_at``: this is an operator's assertion joining two namespaces, and an
    assertion has an author. The names are COPIES taken from core at write time
    (see ``reading-writer``'s ``app/api/placement.py``), because this store may
    not read ``neubit_control`` — the same "put the LABELS on the wire" rule the
    access projection follows. A copy goes stale on a rename; group on the id.

    Not to be confused with ``neubit_control.device_placements``, which pins a
    camera to an ``{x, y}`` on a floor-plan image. That answers "where on the
    drawing"; this answers "which room", and it comes first.
    """

    __tablename__ = "device_locations"

    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)

    # A placement that names no site is not a placement, so site is required.
    # Floor and zone are optional and INDEPENDENT: "on the site, on no particular
    # storey" is a true statement about a rooftop meter or a plant room, not a
    # half-finished one, and forcing a floor would make somebody invent one.
    site_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    site_name: Mapped[str] = mapped_column(String(255), nullable=False)
    floor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    floor_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    zone_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    zone_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # The label the device carried when it was placed, so a placement list stays
    # readable for a device that has since been renamed or stopped reporting.
    device_tag: Mapped[str | None] = mapped_column(String(255), nullable=True)

    placed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    # How the placement was made. NOT a confidence score — nothing here is ever
    # written by a guess. It exists so a bulk action is distinguishable from a
    # device placed one at a time, and a future import from either.
    source: Mapped[str] = mapped_column(String(32), nullable=False, server_default="operator")
    placed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("ix_device_locations_floor", "tenant_id", "floor_id"),
        Index("ix_device_locations_site", "tenant_id", "site_id"),
    )


class SiteFact(Base):
    """The reporting store's read-model of a SITE — the facts a rating divides by.

    `neubit_control.sites` is the source of truth and core is its only writer.
    This table is fed by `reading-writer`'s `app/site_facts_sync.py`, a durable
    consumer of `tenant.*.sites.site.>` on the EVENTS stream, exactly as
    `DeviceLocation` is fed from `tenant.*.sites.device_placement.>` (pipeline
    contract §18). It exists so Building Intelligence can join a reading to an
    area without reading a database it is banned from reading (contract §1).

    NOTHING HERE IS EVER INFERRED. Every value arrived on an event, having been
    typed by an operator into Configurations → Sites. A NULL is NOT RECORDED and
    every consumer must render it as absence: `/bi/rating` produces no rating for
    a site with no `gross_floor_area_sqm`, rather than a default, an estimate or
    a national average.
    """

    __tablename__ = "site_facts"

    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    site_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    # Core publishes the NAME beside the id it minted — the authority states the
    # label rather than being asked to confirm one, and no browser is in the path.
    site_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))

    gross_floor_area_sqm: Mapped[float | None] = mapped_column(Float, nullable=True)
    energy_tariff_per_kwh: Mapped[float | None] = mapped_column(Float, nullable=True)
    tariff_currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    occupancy: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # When the OPERATOR asserted the facts (core's timestamp, carried on the
    # event) vs when this mirror last wrote. Provenance and lag are different
    # questions and a screen that shows a stale area should be able to tell.
    facts_updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    mirrored_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
