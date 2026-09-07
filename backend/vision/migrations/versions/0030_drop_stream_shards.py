"""drop stream_shards — a P1 placeholder P2 never used

Revision ID: 0030_drop_stream_shards
Revises: 0029_drop_onvif_server_config
Create Date: 2026-09-07

``stream_shards`` was created by the 0001 baseline to hold a (camera, profile) →
media-node placement, with its own docstring promising that "the sharding/assignment
logic … lands in P2 when live streaming comes online". P2 came, and solved placement
a different way: ``cameras.media_node_id`` plus ``app.vms.common.node_routing``. The
table was never written and never read — no service, router, worker, schema or
frontend caller ever referenced the ``StreamShard`` model, and it is empty in the
live deployment. This drops it, along with the model.

Guarded/idempotent both ways — safe to re-run, and safe on a fresh DB where the
baseline sweep no longer creates it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0030_drop_stream_shards"
down_revision = "0029_drop_onvif_server_config"
branch_labels = None
depends_on = None


def _has_table() -> bool:
    return sa.inspect(op.get_bind()).has_table("stream_shards")


def upgrade() -> None:
    if _has_table():
        op.drop_table("stream_shards")


def downgrade() -> None:
    # Recreates the table as the 0001 baseline left it. The model is gone, so this is
    # literal DDL — a downgrade gets the schema back, not the code that used it.
    if _has_table():
        return
    op.create_table(
        "stream_shards",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=True),
        sa.Column(
            "camera_id",
            sa.String(length=36),
            sa.ForeignKey("cameras.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "node_id",
            sa.String(length=36),
            sa.ForeignKey("media_nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("profile", sa.String(length=16), nullable=False, server_default=sa.text("'main'")),
        sa.Column("assigned_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_stream_shards_tenant_id", "stream_shards", ["tenant_id"])
    op.create_index("ix_stream_shards_camera_id", "stream_shards", ["camera_id"])
    op.create_index("ix_stream_shards_node_id", "stream_shards", ["node_id"])
    op.create_index("ix_stream_shards_tenant_node", "stream_shards", ["tenant_id", "node_id"])
    op.create_index("ix_stream_shards_camera", "stream_shards", ["camera_id"])
