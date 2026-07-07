"""tags — tags + tag_links tables (cross-cutting labels)

Revision ID: 0010_tags
Revises: 0009_sites
Create Date: 2026-07-07

Adds the Tags control-plane primitive ported from neubit_v2: a reusable, color-coded
``Tag`` and a GENERIC ``TagLink`` association so ANY entity — a site or zone today, a
device or incident tomorrow — can be tagged without a schema change.

Both tables are TENANT-SCOPED: each carries a nullable ``tenant_id`` (the owning
tenant; NULL = a platform/super-admin/system row) matching the row-scoping pattern
used by 0007/0009. ``tags`` is unique per tenant on ``(tenant_id, name)``;
``tag_links`` is unique per tenant on ``(tenant_id, tag_id, entity_type, entity_id)``
and indexed on ``(tenant_id, entity_type, entity_id)`` for the reverse lookup.

Created idempotently: a table is only created if missing, so re-running on a DB
already built from the baseline metadata ``create_all`` is a no-op.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0010_tags"
down_revision = "0009_sites"
branch_labels = None
depends_on = None


def _has_table(bind, name: str) -> bool:
    return sa.inspect(bind).has_table(name)


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "tags"):
        op.create_table(
            "tags",
            sa.Column("tag_id", sa.String(length=36), nullable=False),
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column("name", sa.String(length=100), nullable=False),
            sa.Column(
                "color", sa.String(length=32), nullable=False,
                server_default=sa.text("'#3B82F6'"),
            ),
            sa.Column("description", sa.String(length=500), nullable=True),
            sa.Column(
                "is_active", sa.Boolean(), nullable=False, server_default=sa.text("true"),
            ),
            sa.Column("created_by", sa.String(length=36), nullable=True),
            sa.Column("updated_by", sa.String(length=36), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("tag_id", name="pk_tags"),
            sa.UniqueConstraint("tenant_id", "name", name="uq_tags_tenant_name"),
        )
        op.create_index("ix_tags_tenant_id", "tags", ["tenant_id"])
        op.create_index("ix_tags_name", "tags", ["name"])
        op.create_index("ix_tags_is_active", "tags", ["is_active"])

    if not _has_table(bind, "tag_links"):
        op.create_table(
            "tag_links",
            sa.Column("link_id", sa.String(length=36), nullable=False),
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column("tag_id", sa.String(length=36), nullable=False),
            sa.Column("entity_type", sa.String(length=64), nullable=False),
            sa.Column("entity_id", sa.String(length=64), nullable=False),
            sa.Column("created_by", sa.String(length=36), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("link_id", name="pk_tag_links"),
            sa.ForeignKeyConstraint(
                ["tag_id"], ["tags.tag_id"],
                name="fk_tag_links_tag_id", ondelete="CASCADE",
            ),
            sa.UniqueConstraint(
                "tenant_id", "tag_id", "entity_type", "entity_id",
                name="uq_tag_links_unique",
            ),
        )
        op.create_index("ix_tag_links_tenant_id", "tag_links", ["tenant_id"])
        op.create_index("ix_tag_links_tag_id", "tag_links", ["tag_id"])
        op.create_index(
            "ix_tag_links_entity", "tag_links", ["tenant_id", "entity_type", "entity_id"]
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "tag_links"):
        op.drop_index("ix_tag_links_entity", table_name="tag_links")
        op.drop_index("ix_tag_links_tag_id", table_name="tag_links")
        op.drop_index("ix_tag_links_tenant_id", table_name="tag_links")
        op.drop_table("tag_links")
    if _has_table(bind, "tags"):
        op.drop_index("ix_tags_is_active", table_name="tags")
        op.drop_index("ix_tags_name", table_name="tags")
        op.drop_index("ix_tags_tenant_id", table_name="tags")
        op.drop_table("tags")
