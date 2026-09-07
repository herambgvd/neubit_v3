"""storage pools + tier rules (P3-B)

Revision ID: 0004_storage
Revises: 0003_recordings
Create Date: 2026-07-09

Adds the two P3-B tables:
  * ``storage_pools``     — where recorded segments live (local / nfs / smb / s3);
    secrets (SMB password, S3 secret key) stored REVERSIBLY ENCRYPTED.
  * ``storage_tier_rules`` — move recordings older than N hours source→target pool.

Tenant-scoped; plain-string ``pool_type`` / ``mount_state`` (no PG enum). The
``recordings`` table already carries ``storage_pool_id`` / ``checksum`` /
``integrity_status`` (P3-A) — P3-B just FILLS them.

``storage_pools`` is still created off the live ``StoragePool`` metadata
(``Table.create(checkfirst=True)`` — the v3 baseline pattern, matches
``0001``/``0002``/``0003``); a fresh deploy gets it from the baseline sweep too.

``storage_tier_rules`` is spelled out as literal DDL here because the ``TierRule``
model NO LONGER EXISTS: tiering is the standalone NVR's job and the model was
deleted. This revision still creates the table so that stepping the history forward
one revision at a time reproduces the schema of the day; ``0028_drop_raid_tier``
drops it again a few revisions later, and a fresh ``upgrade head`` therefore ends
with no such table.
"""

from alembic import op
import sqlalchemy as sa

revision = "0004_storage"
down_revision = "0003_recordings"
branch_labels = None
depends_on = None


def _pool_table():
    # Import here so the model registers on Base.metadata at migration time.
    from app.vms.models import StoragePool

    return StoragePool.__table__


def upgrade() -> None:
    bind = op.get_bind()
    _pool_table().create(bind, checkfirst=True)

    if not sa.inspect(bind).has_table("storage_tier_rules"):
        op.create_table(
            "storage_tier_rules",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column("name", sa.String(length=100), nullable=False),
            sa.Column("source_pool_id", sa.String(length=36), nullable=False),
            sa.Column("target_pool_id", sa.String(length=36), nullable=False),
            sa.Column("after_age_hours", sa.Integer(), nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_by", sa.String(length=64), nullable=True),
            sa.Column("updated_by", sa.String(length=64), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("tenant_id", "name", name="uq_storage_tier_rules_tenant_name"),
        )
        op.create_index("ix_storage_tier_rules_tenant", "storage_tier_rules", ["tenant_id"])
        op.create_index("ix_storage_tier_rules_enabled", "storage_tier_rules", ["enabled"])


def downgrade() -> None:
    bind = op.get_bind()
    if sa.inspect(bind).has_table("storage_tier_rules"):
        op.drop_index("ix_storage_tier_rules_enabled", table_name="storage_tier_rules")
        op.drop_index("ix_storage_tier_rules_tenant", table_name="storage_tier_rules")
        op.drop_table("storage_tier_rules")
    _pool_table().drop(bind, checkfirst=True)
