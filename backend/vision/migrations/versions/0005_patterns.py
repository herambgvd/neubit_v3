"""video-wall patterns + camera-group layout (P3-C)

Revision ID: 0005_patterns
Revises: 0004_storage
Create Date: 2026-07-09

Two deltas for the video-wall Patterns feature:
  * ``camera_patterns``       — rotating sequences of camera groups (dwell ``seconds``),
    tenant-scoped, name unique per tenant. Ported from neubit_v2 ``PatternDocument``.
  * ``camera_groups.layout``  — video-wall grid layout key (1x1..8x8, default ``2x2``)
    on the existing group row (ported from v2 ``CameraGroupDocument.pattern``).

Idempotent: the table is created via ``Table.create(checkfirst=True)`` off the live
model metadata (the v3 baseline pattern, matches ``0001``–``0004``). The ADD COLUMN is
guarded by an inspector check so it's safe to re-run and skips DBs that already have it.

A fresh deploy gets the table from the 0001 baseline sweep (which now lists it) and the
column from the group model metadata; this migration lands both on already-deployed DBs.
"""

from alembic import op
from sqlalchemy import inspect


def _table():
    # Import here so the model registers on Base.metadata at migration time.
    from app.vms.models import CameraPattern

    return CameraPattern.__table__


def _has_column(bind, table: str, column: str) -> bool:
    insp = inspect(bind)
    return column in {c["name"] for c in insp.get_columns(table)}


revision = "0005_patterns"
down_revision = "0004_storage"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    _table().create(bind, checkfirst=True)
    if not _has_column(bind, "camera_groups", "layout"):
        op.add_column(
            "camera_groups",
            _group_layout_column(),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "camera_groups", "layout"):
        op.drop_column("camera_groups", "layout")
    _table().drop(bind, checkfirst=True)


def _group_layout_column():
    import sqlalchemy as sa

    return sa.Column(
        "layout",
        sa.String(length=8),
        nullable=False,
        server_default="2x2",
    )
