"""dashforge_embeds.category — which console shows a registered dashboard

Revision ID: 0028_dashforge_category
Revises: 0027_branding_favicon
Create Date: 2026-09-09

Every registration used to land in one undifferentiated strip, so the building
dashboards, the surveillance ones and the access ones were a single list an
operator read top to bottom. The category is what segregates them.

NOT NULL, and existing rows are backfilled to 'building' rather than to the column
default. That is not a guess: until this column existed the ONLY viewer was
Building Intelligence, so every registration already in the table is a Building
Intelligence dashboard and belongs on the console that has been showing it.
Backfilling to 'general' would have emptied that console on the deploy.

The server default stays 'general' for rows written LATER by something that has
not learned the field — visible under "General" rather than filed nowhere.

Indexed because every console list is a `WHERE category = ?`: the filter is the
point of the column, not an occasional report.
"""

import sqlalchemy as sa
from alembic import op

revision = "0028_dashforge_category"
down_revision = "0027_branding_favicon"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dashforge_embeds",
        sa.Column("category", sa.String(32), nullable=False, server_default="general"),
    )
    # Pre-existing rows only: the column was added a statement ago, so every row
    # this touches predates it.
    op.execute("UPDATE dashforge_embeds SET category = 'building'")
    op.create_index("ix_dashforge_embeds_category", "dashforge_embeds", ["category"])


def downgrade() -> None:
    op.drop_index("ix_dashforge_embeds_category", table_name="dashforge_embeds")
    op.drop_column("dashforge_embeds", "category")
