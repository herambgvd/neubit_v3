"""core: permissions a SATELLITE registers at runtime, so a role can grant them

Revision ID: 0017_permission_registrations
Revises: 0016_audit_actor_name
Create Date: 2026-08-30

The permission catalog (`app/auth/permissions.py`) is a python constant, and that
was fine while every permission was known at build time. The dashboard builder's
dataset registry breaks that assumption on purpose: a dataset is registered with
an INSERT into `neubit_reporting.dashboard_datasets`, and it names the permission
required to read it. If that key is not in core's catalog, `PERMISSIONS.unknown()`
refuses it on role create and no role can ever grant it.

That is not hypothetical — it is exactly the bug the builder contract calls out:
`ingest.read` / `ingest.manage` were enforced by the backend and never registered,
so only a wildcard admin could reach Ingest.

So this table is the DYNAMIC half of the catalog. A satellite service posts its
keys to `POST /auth/permissions/registrations` (gated by `permission.register`,
which a service token holds) and they show up in the role editor beside the
static ones. Static keys always win a collision: the code's own catalog is the
authority on anything the code itself enforces.

`source` records which service registered a key, so a stale one is diagnosable
rather than mysterious.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0017_permission_registrations"
down_revision = "0016_audit_actor_name"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "permission_registrations",
        sa.Column("key", sa.String(128), primary_key=True),
        sa.Column("label", sa.String(200), nullable=False),
        sa.Column("group_name", sa.String(80), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("source", sa.String(64), nullable=False, server_default=""),
        sa.Column(
            "registered_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_table("permission_registrations")
