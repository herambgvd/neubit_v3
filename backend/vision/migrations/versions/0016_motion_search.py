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

from alembic import op

revision = "0016_motion_search"
down_revision = "0015_bookmarks_evidence"
branch_labels = None
depends_on = None


def _tables():
    from app.vms.models import MotionSearchJob

    return [MotionSearchJob.__table__]


def upgrade() -> None:
    bind = op.get_bind()
    for table in _tables():
        table.create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(_tables()):
        table.drop(bind, checkfirst=True)
