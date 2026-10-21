"""node_cameras — each recorder's cameras as this VMS last saw them

Revision ID: 0035_node_cameras
Revises: 0034_vms_events_drop_camera_fk
Create Date: 2026-10-21

The VMS kept no copy of a recorder's cameras. Every list was a live fan-out, and a
recorder the heartbeat marked offline was skipped, so closing one recorder emptied
the wall, the camera list and its own detail pane: its cameras read as never having
existed (SCRUM-334). The heartbeat now mirrors each recorder's list here, and a read
while the recorder is down is served from it, marked offline.

Guarded, like every change in this chain: ``0001_vision_baseline`` builds its tables
from LIVE model metadata, so a FRESH database already has this table by the time
this revision runs.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0035_node_cameras"
down_revision = "0034_vms_events_drop_camera_fk"
branch_labels = None
depends_on = None

_TABLE = "node_cameras"


def _has_table(bind) -> bool:
    return sa.inspect(bind).has_table(_TABLE)


def upgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind):
        return
    op.create_table(
        _TABLE,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=True),
        sa.Column(
            "node_id",
            sa.String(36),
            sa.ForeignKey("media_nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("remote_id", sa.String(64), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("data", sa.JSON(), nullable=False),
        sa.Column("synced_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("node_id", "remote_id", name="uq_node_cameras_node_remote"),
    )
    op.create_index("ix_node_cameras_tenant_id", _TABLE, ["tenant_id"])
    op.create_index("ix_node_cameras_node_id", _TABLE, ["node_id"])


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind):
        op.drop_table(_TABLE)
