"""media_nodes.credential_error — why a node's credential is not working

Revision ID: 0032_media_node_credential_error
Revises: 0031_drop_vms_device_job_tables
Create Date: 2026-09-07

A federation credential freezes the grant list it was minted with, so widening the
recorder's grant set leaves every existing credential short — while the node stays
REACHABLE and keeps reporting online. The failure only shows up on whichever screen
happens to use the missing grant, and nothing connects the two.

This column carries the reason, set by the heartbeat and cleared the moment a call
succeeds, so the node list can say "credential stale, re-enrol" instead of "online".

Guarded, like every column add in this chain: ``0001_vision_baseline`` builds its
tables from LIVE model metadata, so a FRESH database already has this column by the
time this revision runs.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0032_media_node_credential_error"
down_revision = "0031_drop_vms_device_job_tables"
branch_labels = None
depends_on = None

_TABLE = "media_nodes"
_COLUMN = "credential_error"


def _has_column(bind, table: str, column: str) -> bool:
    return column in {c["name"] for c in sa.inspect(bind).get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, _TABLE, _COLUMN):
        op.add_column(_TABLE, sa.Column(_COLUMN, sa.String(length=512), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, _TABLE, _COLUMN):
        op.drop_column(_TABLE, _COLUMN)
