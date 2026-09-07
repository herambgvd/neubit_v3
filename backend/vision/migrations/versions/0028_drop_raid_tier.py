"""drop raid_arrays + storage_tier_rules — RAID and tiering moved to the standalone NVR

Revision ID: 0028_drop_raid_tier
Revises: 0027_merge_camera_heads
Create Date: 2026-09-07

The storage DATA-PLANE was retired from this VMS a while ago: the standalone NVR is
the recorder that writes segments and sits on the disks, so it owns retention,
hot→cold tiering and RAID health. Two movers on the same ``/recordings`` volume is a
data-loss race. What lingered was the schema — ``raid_arrays`` (0020) and
``storage_tier_rules`` (0004) stayed behind after the code that used them went, with
no service, router, worker or frontend caller left reading either. Both tables are
empty in the live deployment. This drops them, along with the ``RaidArray`` and
``TierRule`` models.

``storage_pools`` is NOT touched — a finalized recording still gets a
``storage_pool_id`` stamped on it. Its ``raid_level`` / ``raid_device`` columns stay
too, but are now purely documentary labels with nothing to cross-link to.

Guarded/idempotent both ways — safe to re-run, and safe on a fresh DB where the
baseline sweep never created either table.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0028_drop_raid_tier"
down_revision = "0027_merge_camera_heads"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(name)


def upgrade() -> None:
    if _has_table("storage_tier_rules"):
        op.drop_table("storage_tier_rules")
    if _has_table("raid_arrays"):
        op.drop_table("raid_arrays")


def downgrade() -> None:
    # Recreates both tables as 0004 / 0020 left them. The models are gone, so this is
    # literal DDL — a downgrade gets the schema back, not the code that used it.
    if not _has_table("raid_arrays"):
        op.create_table(
            "raid_arrays",
            sa.Column("device", sa.String(length=64), primary_key=True),
            sa.Column("level", sa.String(length=16), nullable=False, server_default="unknown"),
            sa.Column("state", sa.String(length=128), nullable=True),
            sa.Column("health", sa.String(length=16), nullable=False, server_default="unknown"),
            sa.Column("working_devices", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("failed_devices", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("total_devices", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("rebuild_status", sa.String(length=255), nullable=True),
            sa.Column("rebuild_percent", sa.Integer(), nullable=True),
            sa.Column("first_degraded_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_raid_arrays_health", "raid_arrays", ["health"])

    if not _has_table("storage_tier_rules"):
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
