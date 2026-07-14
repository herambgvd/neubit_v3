"""workflow — device_tokens table (mobile push registration)

Revision ID: 0005_device_tokens
Revises: 0004_template_provider_ref
Create Date: 2026-07-09

Creates ``device_tokens`` — per-user mobile push tokens (FCM/APNs) the push
connector (``connectors/push.py``) fans a notification out to. TENANT-SCOPED
(nullable ``tenant_id``; a push only ever reaches the target tenant's users) with
the standard tenant + audit columns. ``(tenant_id, platform, token)`` is unique so
a device re-registering upserts rather than duplicating.

Idempotent: only creates the table + indexes if absent, so re-running on a DB
already built from the metadata ``create_all`` (env.py imports the model) is a
no-op.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0005_device_tokens"
down_revision = "0004_template_provider_ref"
branch_labels = None
depends_on = None


def _has_table(bind, name: str) -> bool:
    return sa.inspect(bind).has_table(name)


def _has_index(bind, table: str, index: str) -> bool:
    insp = sa.inspect(bind)
    if not insp.has_table(table):
        return False
    return any(ix["name"] == index for ix in insp.get_indexes(table))


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "device_tokens"):
        op.create_table(
            "device_tokens",
            sa.Column("device_token_id", sa.String(length=36), nullable=False),
            sa.Column("user_id", sa.String(length=64), nullable=False),
            sa.Column("platform", sa.String(length=16), nullable=False),
            sa.Column("token", sa.String(length=512), nullable=False),
            sa.Column("label", sa.String(length=255), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
            # shared tenant + audit columns (mirrors _TenantTimestamped)
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column("created_by", sa.String(length=64), nullable=True),
            sa.Column("updated_by", sa.String(length=64), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("device_token_id"),
        )
    # Indexes (created separately so they're also idempotent on a create_all DB).
    for name, cols, unique in (
        ("ix_device_tokens_tenant_id", ["tenant_id"], False),
        ("ix_device_tokens_user_id", ["user_id"], False),
        ("ix_device_tokens_platform", ["platform"], False),
        ("ix_device_tokens_is_active", ["is_active"], False),
        ("uq_device_tokens_tenant_platform_token", ["tenant_id", "platform", "token"], True),
    ):
        if not _has_index(bind, "device_tokens", name):
            op.create_index(name, "device_tokens", cols, unique=unique)


def downgrade() -> None:
    bind = op.get_bind()
    for name in (
        "uq_device_tokens_tenant_platform_token",
        "ix_device_tokens_is_active",
        "ix_device_tokens_platform",
        "ix_device_tokens_user_id",
        "ix_device_tokens_tenant_id",
    ):
        if _has_index(bind, "device_tokens", name):
            op.drop_index(name, table_name="device_tokens")
    if _has_table(bind, "device_tokens"):
        op.drop_table("device_tokens")
