"""reporting: carry the DEVICE classification on `points` (contract §11)

Revision ID: 0003_points_device_class
Revises: 0002_reporting_rollups
Create Date: 2026-08-30

Building Intelligence is a set of category views — HVAC & Assets, Energy &
Metering, IAQ & Environment — and they filter on what a device IS. The gateway
already classifies (28 of the 30 aeon devices carry a category), but nothing in
the §3 message body said so, and `points.category` was set on 0 of 314 rows.

Two changes, and the second is the one worth explaining:

* `device_type` is a NEW column. `points.type` already exists and holds the
  reading KIND — "num" or "text", i.e. which of readings.num/readings.txt this
  point fills. The device's equipment kind ("meter", "chiller") is a different
  fact about a different thing, and overloading one column with both would make
  every query ambiguous and the first BI filter wrong.

* `ix_points_tenant_category` supports the actual BI query — "every point in
  this tenant's Energy & Metering view".

Nothing is backfilled. There is no source on the platform for a device's
category: the gateway is the only thing that knows, and it starts sending it
with this change. Existing rows are filled by their next reading.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003_points_device_class"
down_revision = "0002_reporting_rollups"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("points", sa.Column("device_type", sa.String(64), nullable=True))
    op.create_index("ix_points_tenant_category", "points", ["tenant_id", "category"])


def downgrade() -> None:
    op.drop_index("ix_points_tenant_category", table_name="points")
    op.drop_column("points", "device_type")
