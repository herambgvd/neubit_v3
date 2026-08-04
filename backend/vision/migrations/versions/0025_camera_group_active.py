"""camera_groups.is_active — mark a group active/inactive

Revision ID: 0025_camera_group_active
Revises: 0024_recording_media_node
Create Date: 2026-07-21

The camera-group form has always carried an "Active" toggle, but the backend had no
column to hold it — so create/update rejected the ``is_active`` field (extra_forbidden,
422). Adds:

  * ``is_active`` (Boolean, NOT NULL, server_default true) — whether the group is active
    (e.g. eligible for the video wall). Existing rows default to active → byte-identical
    back-compat.

Idempotent add-column (guarded by an inspector check, matching 0024). A fresh deploy gets
this column from the ``CameraGroup`` model metadata via the 0001 baseline sweep, so only
the ALREADY-DEPLOYED DB path needs this migration.
"""

from alembic import op
from sqlalchemy import inspect

revision = "0025_camera_group_active"
down_revision = "0024_recording_media_node"
branch_labels = None
depends_on = None

_TABLE = "camera_groups"
_COLUMN = "is_active"


def _has_column(bind, table: str, column: str) -> bool:
    insp = inspect(bind)
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    import sqlalchemy as sa

    if not _has_column(bind, _TABLE, _COLUMN):
        op.add_column(
            _TABLE,
            sa.Column(
                _COLUMN,
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("true"),
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, _TABLE, _COLUMN):
        op.drop_column(_TABLE, _COLUMN)
