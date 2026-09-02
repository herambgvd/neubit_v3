"""export_jobs — clip-export job metadata (P4-B)

Revision ID: 0007_export_jobs
Revises: 0006_playback_window
Create Date: 2026-07-09

Adds the ``export_jobs`` table: one row per clip-export request (concat recorded
fmp4 segments → a single downloadable mp4). The export router creates a QUEUED row;
the lifespan export worker ffmpeg-concats the covered segments into the downloads
area and flips the row to ``done`` (+ file_path/file_size) or ``failed`` (+ error).
Tenant-scoped; plain-string ``status`` / ``format`` (no PG enum).

Idempotent — ``Table.create(checkfirst=True)`` off the live model metadata (the v3
baseline pattern, matches ``0003``). A fresh deploy gets this table from the baseline
sweep too (both list it); this migration lands it on already-deployed DBs.
"""

from alembic import op

revision = "0007_export_jobs"
down_revision = "0006_playback_window"
branch_labels = None
depends_on = None


def _table():
    # Import here so the model registers on Base.metadata at migration time.
    from app.vms.models import ExportJob

    return ExportJob.__table__


def upgrade() -> None:
    _table().create(op.get_bind(), checkfirst=True)


def downgrade() -> None:
    _table().drop(op.get_bind(), checkfirst=True)
