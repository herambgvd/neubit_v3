"""RAID monitoring — raid_arrays table + storage_pools RAID link (RAID compliance)

Revision ID: 0020_raid
Revises: 0019_stream_codec
Create Date: 2026-07-12

Enterprise-VMS RAID parity (Genetec/Milestone class): the VMS monitors software-RAID
(mdadm) arrays and alerts on degrade. Adds:

  * ``raid_arrays`` — one row per md device (``/dev/md0``), the live health snapshot the
    ``RaidMonitor`` worker upserts every poll (derived health, working/failed/total
    devices, rebuild %). NOT tenant-scoped (physical node hardware). A fresh deploy gets
    it from the ``RaidArray`` model via the 0001 baseline sweep; this migration creates
    it on already-deployed DBs.
  * ``storage_pools.raid_level`` + ``storage_pools.raid_device`` — optional documentary
    link from a local pool to its RAID array (UI cross-link to health).

Idempotent: guarded by inspector checks so it is safe to re-run and skips DBs that
already have the table / columns.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "0020_raid"
down_revision = "0019_stream_codec"
branch_labels = None
depends_on = None


def _has_table(bind, table: str) -> bool:
    return inspect(bind).has_table(table)


def _has_column(bind, table: str, column: str) -> bool:
    insp = inspect(bind)
    if not insp.has_table(table):
        return False
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_column(bind, "storage_pools", "raid_level"):
        op.add_column("storage_pools", sa.Column("raid_level", sa.String(length=16), nullable=True))
    if not _has_column(bind, "storage_pools", "raid_device"):
        op.add_column("storage_pools", sa.Column("raid_device", sa.String(length=64), nullable=True))

    if not _has_table(bind, "raid_arrays"):
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


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "raid_arrays"):
        op.drop_index("ix_raid_arrays_health", table_name="raid_arrays")
        op.drop_table("raid_arrays")
    if _has_column(bind, "storage_pools", "raid_device"):
        op.drop_column("storage_pools", "raid_device")
    if _has_column(bind, "storage_pools", "raid_level"):
        op.drop_column("storage_pools", "raid_level")
