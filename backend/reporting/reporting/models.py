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
    DateTime,
    Float,
    Index,
    PrimaryKeyConstraint,
    SmallInteger,
    String,
    Text,
    func,
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

    # Engineering unit ("kW", "degC", ""). Free text: it comes from the device.
    unit: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Operator-facing grouping ("energy", "hvac", ...) and the point's data type
    # ("num" / "text" / ...) as the gateway classifies it.
    category: Mapped[str | None] = mapped_column(String(128), nullable=True)
    type: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Anything else the gateway knows that is not worth a column yet. Kept out of
    # the fact table on purpose.
    meta: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("ix_points_tenant", "tenant_id"),
        Index("ix_points_conn", "conn_id"),
        Index("ix_points_device", "device_id"),
        # "show me the points on this device, by tag" — the browse path.
        Index("ix_points_tenant_device_tag", "tenant_id", "device_tag", "point_tag"),
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
