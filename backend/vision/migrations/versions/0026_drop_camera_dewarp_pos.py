"""drop cameras.dewarp + cameras.pos_overlay — feature moved to the standalone NVR

Revision ID: 0026_drop_camera_dewarp_pos
Revises: 0025_media_node_credential
Create Date: 2026-08-04

The camera Dewarp + POS-overlay feature is owned by the standalone NVR (the
camera owner), not the VMS control plane. This drops the two JSON columns that
backed it from the ``cameras`` table. Guarded/idempotent — only drops a column
that actually exists, so it is safe on fresh DBs (where the model no longer
declares the columns) and on older DBs that still carry them.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0026_drop_camera_dewarp_pos"
down_revision = "0025_media_node_credential"
branch_labels = None
depends_on = None

_COLUMNS = ("dewarp", "pos_overlay")


def _existing_columns() -> set[str]:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "cameras" not in insp.get_table_names():
        return set()
    return {c["name"] for c in insp.get_columns("cameras")}


def upgrade() -> None:
    existing = _existing_columns()
    for col in _COLUMNS:
        if col in existing:
            op.drop_column("cameras", col)


def downgrade() -> None:
    existing = _existing_columns()
    for col in _COLUMNS:
        if col not in existing:
            op.add_column(
                "cameras",
                sa.Column(col, sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
            )
