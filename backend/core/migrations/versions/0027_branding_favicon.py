"""branding.favicon_key — a tenant's browser-tab icon

Revision ID: 0027_branding_favicon
Revises: 0026_drop_redundant_prefix_index
Create Date: 2026-09-08

The favicon is a SEPARATE image from the logo, not a resize of it: it is read at
16px in a browser tab, where a wordmark that works in a header is a grey smudge.

Nullable, no backfill — a deployment with no favicon uploaded keeps the app's own
icon, which is what it did before this column existed.

`primary_color`, `accent_color` and `name_in_header` are deliberately NOT dropped
here even though the API and the UI have stopped carrying them. They hold data a
deployment may have set, dropping a column is not reversible, and leaving them
costs three columns nothing reads. See branding/models.py.
"""

import sqlalchemy as sa
from alembic import op

revision = "0027_branding_favicon"
down_revision = "0026_drop_redundant_prefix_index"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("branding", sa.Column("favicon_key", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("branding", "favicon_key")
