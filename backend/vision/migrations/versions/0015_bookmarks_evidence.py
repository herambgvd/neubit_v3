"""bookmarks + evidence_locks tables — Bookmarks + Evidence Lock / Legal Hold (G3)

Revision ID: 0015_bookmarks_evidence
Revises: 0014_ptz
Create Date: 2026-07-10

Adds ``bookmarks`` (operator-marked moments/ranges in recorded footage: point or
range, title, note, tags, tenant-scoped, per camera) and ``evidence_locks`` (a
legal-hold on a camera + time-range that the retention worker MUST skip — a locked
recording is never auto-deleted; soft-release keeps the row as an audit trail).

Created off the live model metadata (checkfirst=True) — the v3 baseline pattern
(matches 0001-0014). Idempotent: a fresh deploy gets the tables from the 0001
baseline sweep (which now lists them); this migration lands them on already-deployed
DBs.
"""

from alembic import op

revision = "0015_bookmarks_evidence"
down_revision = "0014_ptz"
branch_labels = None
depends_on = None


def _tables():
    from app.vms.models import Bookmark, EvidenceLock

    return [Bookmark.__table__, EvidenceLock.__table__]


def upgrade() -> None:
    bind = op.get_bind()
    for table in _tables():
        table.create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(_tables()):
        table.drop(bind, checkfirst=True)
