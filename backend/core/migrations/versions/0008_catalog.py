"""catalog — module_catalog + device_brands tables

Revision ID: 0008_catalog
Revises: 0007_tenant_scoping
Create Date: 2026-07-07

Adds the two platform-global catalogs the super-admin manages:

  * modules        — the toggleable feature/module registry (keys become the keys
                     of every tenant's ``features`` dict).
  * device_brands  — the supported device-brand / SDK registry (prep for devices).

Both are platform-global (NOT tenant-scoped). Created idempotently: we only create
a table if it's missing, so re-running on a DB that already has them (e.g. one built
from the baseline metadata create_all) is a no-op.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0008_catalog"
down_revision = "0007_tenant_scoping"
branch_labels = None
depends_on = None


def _has_table(bind, name: str) -> bool:
    return sa.inspect(bind).has_table(name)


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "modules"):
        op.create_table(
            "modules",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("key", sa.String(), nullable=False),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("description", sa.String(), nullable=False),
            sa.Column("category", sa.String(), nullable=False),
            sa.Column(
                "default_enabled", sa.Boolean(), nullable=False,
                server_default=sa.text("false"),
            ),
            sa.Column(
                "is_system", sa.Boolean(), nullable=False,
                server_default=sa.text("false"),
            ),
            sa.Column("created_at", sa.DateTime(timezone=True),
                      server_default=sa.func.now(), nullable=False),
            sa.PrimaryKeyConstraint("id", name="pk_modules"),
            sa.UniqueConstraint("key", name="uq_modules_key"),
        )
        op.create_index("ix_modules_key", "modules", ["key"])

    if not _has_table(bind, "device_brands"):
        op.create_table(
            "device_brands",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("brand_id", sa.String(), nullable=False),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("sdk_type", sa.String(), nullable=False),
            sa.Column("protocols", sa.JSON(), nullable=False),
            sa.Column("capabilities", sa.JSON(), nullable=False),
            sa.Column(
                "onvif", sa.Boolean(), nullable=False, server_default=sa.text("false"),
            ),
            sa.Column(
                "is_installed", sa.Boolean(), nullable=False,
                server_default=sa.text("false"),
            ),
            sa.Column("created_at", sa.DateTime(timezone=True),
                      server_default=sa.func.now(), nullable=False),
            sa.PrimaryKeyConstraint("id", name="pk_device_brands"),
            sa.UniqueConstraint("brand_id", name="uq_device_brands_brand_id"),
        )
        op.create_index("ix_device_brands_brand_id", "device_brands", ["brand_id"])


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "device_brands"):
        op.drop_index("ix_device_brands_brand_id", table_name="device_brands")
        op.drop_table("device_brands")
    if _has_table(bind, "modules"):
        op.drop_index("ix_modules_key", table_name="modules")
        op.drop_table("modules")
