"""recordings — finalized recording-segment metadata (P3-A)

Revision ID: 0003_recordings
Revises: 0002_playback_sessions
Create Date: 2026-07-09

Adds the ``recordings`` table: one row per finalized fmp4 segment the Go ``nvr``
data-plane reports over ``tenant.<id>.vms.recording.segment``. vision's NATS
consumer persists it (deduped by ``path``); the browse/playback-index reads off it.
Tenant-scoped; plain-string ``trigger_type`` / ``integrity_status`` (no PG enum).
Pool/checksum/integrity columns are nullable + unfilled until P3-B.

Idempotent — ``Table.create(checkfirst=True)`` off the live model metadata (the v3
baseline pattern, matches ``0001``/``0002``). A fresh deploy gets this table from
the baseline sweep too (both list it); this migration lands it on already-deployed
DBs.
"""

from alembic import op

revision = "0003_recordings"
down_revision = "0002_playback_sessions"
branch_labels = None
depends_on = None


def _table():
    # Import here so the model registers on Base.metadata at migration time.
    from app.vms.models import Recording

    return Recording.__table__


def upgrade() -> None:
    _table().create(op.get_bind(), checkfirst=True)


def downgrade() -> None:
    _table().drop(op.get_bind(), checkfirst=True)
