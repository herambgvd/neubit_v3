"""motion_search_jobs table — Smart / Forensic Motion Search (non-AI), G4

Revision ID: 0016_motion_search
Revises: 0015_bookmarks_evidence
Create Date: 2026-07-10

Adds ``motion_search_jobs`` (one forensic VMD search request: camera + time-window +
drawn region rects → hit intervals with motion scores). Pure ffmpeg scene/motion
analysis over the covering recorded fmp4 segments — NO AI. Async job (like exports):
the ``MotionSearchWorker`` picks queued rows, crops each region + runs the ffmpeg
scdet/scene filter, thresholds the scores into hit intervals, and stores them.

Created off the live model metadata (checkfirst=True) — the v3 baseline pattern
(matches 0001-0015). Idempotent: a fresh deploy gets the table from the 0001 baseline
sweep (which now lists it); this migration lands it on already-deployed DBs.
"""

import sqlalchemy as sa
from alembic import op

revision = "0016_motion_search"
down_revision = "0015_bookmarks_evidence"
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
    for table in ['motion_search_jobs']:
        if inspector.has_table(table):
            op.drop_table(table)
