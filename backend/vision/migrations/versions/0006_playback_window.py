"""recorded-playback window columns on playback_sessions (P4-A)

Revision ID: 0006_playback_window
Revises: 0005_patterns
Create Date: 2026-07-09

Adds ``window_from`` / ``window_to`` (timestamptz, nullable) to
``playback_sessions``: the [from, to] time-range a ``kind="recorded"`` session
plays back (NULL for live sessions). Stored so a recorded session's window can be
re-resolved / re-minted and audited.

Idempotent: each ADD COLUMN is guarded by an inspector check so the migration is
safe to re-run and skips DBs that already have the columns. A fresh deploy gets the
columns from the ``PlaybackSession`` model metadata via the 0001/0002 baseline
sweep; this migration lands them on already-deployed DBs.
"""

from alembic import op
from sqlalchemy import inspect

revision = "0006_playback_window"
down_revision = "0005_patterns"
branch_labels = None
depends_on = None


def _has_column(bind, table: str, column: str) -> bool:
    insp = inspect(bind)
    return column in {c["name"] for c in insp.get_columns(table)}


def _col(name: str):
    import sqlalchemy as sa

    return sa.Column(name, sa.DateTime(timezone=True), nullable=True)


def upgrade() -> None:
    bind = op.get_bind()
    for name in ("window_from", "window_to"):
        if not _has_column(bind, "playback_sessions", name):
            op.add_column("playback_sessions", _col(name))


def downgrade() -> None:
    bind = op.get_bind()
    for name in ("window_to", "window_from"):
        if _has_column(bind, "playback_sessions", name):
            op.drop_column("playback_sessions", name)
