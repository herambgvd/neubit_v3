"""motion_zones JSON column on cameras — motion-zone drawing (G5)

Revision ID: 0017_motion_zones
Revises: 0016_motion_search
Create Date: 2026-07-10

Adds ``motion_zones`` (JSON, default ``[]``) to ``cameras`` — the sibling of
``privacy_masks``. Both hold a list of NORMALIZED (0..1) shapes drawn over the
camera image by the G5 draw tool (rects ``{x,y,w,h}`` and/or polygons
``{points:[[x,y],...]}``). Motion zones are pushed to the brand's motion-detection
region config where the driver supports it (graceful store-only otherwise).

Idempotent: the ADD COLUMN is guarded by an inspector check so the migration is safe
to re-run and skips DBs that already have the column. A fresh deploy gets the column
from the ``Camera`` model metadata via the 0001 baseline sweep (``Camera.__table__``);
this migration lands it on already-deployed DBs.
"""

from alembic import op
from sqlalchemy import inspect, text

revision = "0017_motion_zones"
down_revision = "0016_motion_search"
branch_labels = None
depends_on = None


def _has_column(bind, table: str, column: str) -> bool:
    insp = inspect(bind)
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "cameras", "motion_zones"):
        import sqlalchemy as sa

        op.add_column(
            "cameras",
            sa.Column(
                "motion_zones",
                sa.JSON(),
                nullable=False,
                server_default=text("'[]'"),
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "cameras", "motion_zones"):
        op.drop_column("cameras", "motion_zones")
