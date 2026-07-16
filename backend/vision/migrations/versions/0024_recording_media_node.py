"""recordings.media_node_id — stamp each segment with the recorder node that produced it

Revision ID: 0024_recording_media_node
Revises: 0023_media_node_routing
Create Date: 2026-07-16

Footage-locality fix: a segment physically lives on the recorder machine (Go ``nvr``
node) that recorded it. When a camera is later reassigned from node A to node B, its OLD
recordings still live on node A — but playback previously routed by the camera's CURRENT
``media_node_id`` (→ node B), leaving the old footage unreachable. We now STAMP each
``Recording`` with the node that produced it (``media_node_id``) and route playback by the
RECORDING's node, not the camera's current node.

Adds:
  * ``media_node_id`` (String(36), nullable, indexed) — the MediaNode that recorded this
    segment. NULL for single-node deployments / pre-existing rows → playback falls back to
    the camera's current node / global ``VE_NVR_URL`` (byte-identical back-compat).

Idempotent add-column (guarded by an inspector check, matching 0023_media_node_routing).
A fresh deploy gets this column from the ``Recording`` model metadata via the 0001 baseline
sweep (``Recording.__table__`` is already listed there), so the model + env.py imports are
unchanged — only the ALREADY-DEPLOYED DB path needs this migration. No PG enum column → no
asyncpg add-column footgun.
"""

from alembic import op
from sqlalchemy import inspect

revision = "0024_recording_media_node"
down_revision = "0023_media_node_routing"
branch_labels = None
depends_on = None

_TABLE = "recordings"
_COLUMN = "media_node_id"
_INDEX = "ix_recordings_media_node_id"


def _has_column(bind, table: str, column: str) -> bool:
    insp = inspect(bind)
    return column in {c["name"] for c in insp.get_columns(table)}


def _has_index(bind, table: str, index: str) -> bool:
    insp = inspect(bind)
    return index in {ix["name"] for ix in insp.get_indexes(table)}


def upgrade() -> None:
    bind = op.get_bind()
    import sqlalchemy as sa

    if not _has_column(bind, _TABLE, _COLUMN):
        op.add_column(
            _TABLE, sa.Column(_COLUMN, sa.String(length=36), nullable=True)
        )
    if not _has_index(bind, _TABLE, _INDEX):
        op.create_index(_INDEX, _TABLE, [_COLUMN])


def downgrade() -> None:
    bind = op.get_bind()
    if _has_index(bind, _TABLE, _INDEX):
        op.drop_index(_INDEX, table_name=_TABLE)
    if _has_column(bind, _TABLE, _COLUMN):
        op.drop_column(_TABLE, _COLUMN)
