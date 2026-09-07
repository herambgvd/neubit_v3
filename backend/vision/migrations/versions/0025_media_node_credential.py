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
from sqlalchemy import inspect

revision = "0025_media_node_credential"
down_revision = "0024_recording_media_node"
branch_labels = None
depends_on = None

_TABLE = "media_nodes"
_COLUMN = "credential"


# GUARDED, and it has to be. ``0001_vision_baseline`` creates its tables from the
# LIVE model metadata, so the baseline moves forward with the models: now that
# ``MediaNode`` declares ``credential``, a fresh database already has the column
# by the time this revision runs, and an unguarded ``add_column`` aborted
# ``alembic upgrade head`` with "duplicate column name: credential". Existing
# deployments never saw it — they ran this revision back when the model had no
# such column. Same shape as 0024, which guards for the same reason.
def _has_column(bind, table: str, column: str) -> bool:
    return column in {c["name"] for c in inspect(bind).get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, _TABLE, _COLUMN):
        op.add_column(_TABLE, sa.Column(_COLUMN, sa.String(length=128), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, _TABLE, _COLUMN):
        op.drop_column(_TABLE, _COLUMN)
