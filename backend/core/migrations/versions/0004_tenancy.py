"""multi-tenancy — tenants table + user tenant_id/is_superadmin columns

Revision ID: 0004_tenancy
Revises: 0003_email_templates
Create Date: 2026-07-07

Adds the ``tenants`` table (control plane for multi-tenancy) and two columns on
``users``:
  - ``tenant_id``     : nullable FK → tenants.id (NULL only for super-admins)
  - ``is_superadmin`` : bool, default false (platform super-admin flag)

The table is created from the ORM metadata (create/checkfirst) like the other
migrations; the columns are added via batch_alter_table so this also runs on SQLite
(tests) where ALTER-ADD-COLUMN is limited.
"""

import sqlalchemy as sa
from alembic import op

revision = "0004_tenancy"
down_revision = "0003_email_templates"
branch_labels = None
depends_on = None


def _tenants_table():
    # Import inside the function so the model registers on Base.metadata at run time.
    from edge.tenancy.models import Tenant

    return Tenant.__table__


def upgrade() -> None:
    bind = op.get_bind()
    # 1. Create the tenants table (leaves it alone if it already exists).
    _tenants_table().create(bind, checkfirst=True)

    # 2. Add the two multi-tenancy columns to users. server_default keeps existing
    #    rows valid; is_superadmin defaults to false for all current users.
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("tenant_id", sa.Uuid(), nullable=True))
        batch.add_column(
            sa.Column(
                "is_superadmin",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            )
        )
        batch.create_index("ix_users_tenant_id", ["tenant_id"])
        batch.create_foreign_key(
            "fk_users_tenant_id_tenants",
            "tenants",
            ["tenant_id"],
            ["id"],
            ondelete="CASCADE",
        )


def downgrade() -> None:
    bind = op.get_bind()
    with op.batch_alter_table("users") as batch:
        batch.drop_constraint("fk_users_tenant_id_tenants", type_="foreignkey")
        batch.drop_index("ix_users_tenant_id")
        batch.drop_column("is_superadmin")
        batch.drop_column("tenant_id")
    _tenants_table().drop(bind, checkfirst=True)
