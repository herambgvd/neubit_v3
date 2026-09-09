"""media_nodes.events_synced_at — how far a recorder's event ledger is mirrored

Revision ID: 0033_media_node_events_synced_at
Revises: 0032_media_node_credential_error
Create Date: 2026-09-09

The event supervisor asks each recorder for events `since` a watermark it kept IN
MEMORY, falling back to a 15-minute window on a cold start. Every restart of this
service therefore asked for the last quarter of an hour and nothing else, and on a
live estate that produced an event feed that was permanently empty while the
recorder held 56 events — the newest ninety minutes old. The poll succeeded every
time and returned nothing, so nothing looked broken.

The column persists the watermark per node, written only after a batch is actually
ingested: an unreachable recorder keeps whatever it was holding for the next
successful poll. Re-asking across an overlap is free — the ingest path dedupes on
(camera, type, time-bucket) behind a UNIQUE constraint.

Guarded, like every column add in this chain: ``0001_vision_baseline`` builds its
tables from LIVE model metadata, so a FRESH database already has this column by the
time this revision runs.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0033_media_node_events_synced_at"
down_revision = "0032_media_node_credential_error"
branch_labels = None
depends_on = None

_TABLE = "media_nodes"
_COLUMN = "events_synced_at"


def _has_column(bind, table: str, column: str) -> bool:
    return column in {c["name"] for c in sa.inspect(bind).get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, _TABLE, _COLUMN):
        op.add_column(_TABLE, sa.Column(_COLUMN, sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, _TABLE, _COLUMN):
        op.drop_column(_TABLE, _COLUMN)
