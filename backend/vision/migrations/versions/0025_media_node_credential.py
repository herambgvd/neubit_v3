"""media_nodes.credential — per-node federation credential (Phase-2 trust)

Revision ID: 0025_media_node_credential
Revises: 0024_recording_media_node
Create Date: 2026-07-29

Stores the scoped credential each recorder node issues to this VMS at enrolment,
presented as X-Node-Credential on estate calls instead of the ambient shared
secret. NULL falls back to the service JWT (backward compatible).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0025_media_node_credential"
down_revision = "0024_recording_media_node"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("media_nodes", sa.Column("credential", sa.String(length=128), nullable=True))


def downgrade() -> None:
    op.drop_column("media_nodes", "credential")
