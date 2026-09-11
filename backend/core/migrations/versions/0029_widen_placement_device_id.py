"""Widen device_placements.device_id — a federated camera id does not fit 36 chars

Revision ID: 0029_widen_placement_device_id
Revises: 0028_dashforge_category
Create Date: 2026-09-11

``device_id`` was sized for a UUID, because every device the table was ported with
had one. A camera owned by a federated RECORDER does not: the estate knows it by
the composite ``fed:<node>:<camera>`` — two UUIDs and a prefix, 77 characters —
and that composite is the id the floor builder offers, the video wall persists,
and ``useCameraSites`` joins on.

So the floor builder listed every recorder channel as placeable and the INSERT
died on ``value too long for type character varying(36)``. No camera could be
placed on a floor plan at all, which is why the alarm map had no pins, "Nearby
cameras" said *unplaced*, and the hub's neighbour cells were blank — three
symptoms, one column.

128 rather than 77: a second federation hop (``fed:<node>:fed:<node>:<cam>``)
would be 118, and nothing here should have to be migrated again to hold an id
the estate already mints.

``(tenant_id, device_id)`` is UNIQUE; widening a varchar rewrites no index and
takes no table rewrite in Postgres, so this is safe on a live table.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0029_widen_placement_device_id"
down_revision = "0028_dashforge_category"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "device_placements",
        "device_id",
        existing_type=sa.String(36),
        type_=sa.String(128),
        existing_nullable=False,
    )


def downgrade() -> None:
    # Narrowing truncates nothing only while no federated camera is placed; any
    # such row must be removed first, and Postgres will refuse rather than cut.
    op.alter_column(
        "device_placements",
        "device_id",
        existing_type=sa.String(128),
        type_=sa.String(36),
        existing_nullable=False,
    )
