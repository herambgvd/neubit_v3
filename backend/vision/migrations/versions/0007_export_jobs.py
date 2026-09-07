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

import sqlalchemy as sa
from alembic import op

revision = "0007_export_jobs"
down_revision = "0006_playback_window"
branch_labels = None
depends_on = None

# The model this revision built from is GONE (0031 drops the table; the work moved to
# the recorder that owns the footage). It used to call ``Table.create`` off live model
# metadata, which is what makes a baseline drift forward with the models — and an
# import of a deleted model here breaks ``alembic upgrade head`` on a FRESH database,
# where every revision runs. So the upgrade is a documented no-op: on an existing
# deployment the table is already there and 0031 removes it; on a new one it is never
# created. The downgrade still drops it, so walking back down the chain past this
# point leaves the schema as this revision found it.


def upgrade() -> None:
    pass


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table in ['export_jobs']:
        if inspector.has_table(table):
            op.drop_table(table)
