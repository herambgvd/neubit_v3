"""playback sessions — live/recorded viewer session issuer (P2-B)

Revision ID: 0002_playback_sessions
Revises: 0001_vision_baseline
Create Date: 2026-07-09

Adds the ``playback_sessions`` table: the control-plane record vision writes per
``POST /cameras/{id}/live`` (camera → nvr ensure → mint media token → persist the
session + URLs). Tenant-scoped; plain-string ``kind`` (live|recorded) so P4
recorded-playback reuses the same table. The token itself is a stateless JWT; only
its SHA-256 hash is stored.

Idempotent — ``Table.create(checkfirst=True)`` off the live model metadata (the v3
baseline pattern, matches ``0001``). A fresh deploy gets this table from the
baseline sweep too (both list it); this migration lands it on already-deployed DBs.
"""

from alembic import op

revision = "0002_playback_sessions"
down_revision = "0001_vision_baseline"
branch_labels = None
depends_on = None


def _table():
    # Import here so the model registers on Base.metadata at migration time.
    from app.vms.models import PlaybackSession

    return PlaybackSession.__table__


def upgrade() -> None:
    _table().create(op.get_bind(), checkfirst=True)


def downgrade() -> None:
    _table().drop(op.get_bind(), checkfirst=True)
