"""users.site_ids — per-user site access scope (data-visibility RBAC)

Revision ID: 0015_user_site_scope
Revises: 0014_merge_security_alerts
Create Date: 2026-07-28

Adds a ``site_ids`` JSON list to ``users``. EMPTY = unrestricted (every site in
the tenant); non-empty = the user is confined to exactly these sites. Enforced at
camera/site read time (core sites list + vision camera list, via the access
token's ``site_ids`` claim). Coarse, additive-safe — it only ever narrows what a
user can see.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0015_user_site_scope"
down_revision = "0014_merge_security_alerts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "site_ids",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'"),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "site_ids")
