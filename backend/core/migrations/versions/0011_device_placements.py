"""device_placements — devices plotted onto floor plans

Revision ID: 0011_device_placements
Revises: 0010_tags
Create Date: 2026-07-08

Ports the neubit_v2 device-placement capability (``module/sites/device``) into
core's sites domain. A device_placement records WHERE a device (from any domain
service — vms / access_control / fire) sits on a floor plan, plus its position.

TENANT-SCOPED: a nullable ``tenant_id`` (NULL = platform/system row) matching the
site/floor/zone row-scoping pattern. ``(tenant_id, device_id)`` is unique so the
same device id can exist in different tenants; the frontend addresses placements by
``device_id`` which is unambiguous within a tenant.

Created idempotently: only created if missing, so re-running on a DB already built
from the baseline metadata ``create_all`` is a no-op.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0011_device_placements"
down_revision = "0010_tags"
branch_labels = None
depends_on = None


def _has_table(bind, name: str) -> bool:
    return sa.inspect(bind).has_table(name)


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "device_placements"):
        op.create_table(
            "device_placements",
            sa.Column("placement_id", sa.String(length=36), nullable=False),
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column("device_id", sa.String(length=36), nullable=False),
            sa.Column("device_type", sa.String(length=64), nullable=False),
            sa.Column("service", sa.String(length=64), nullable=False),
            sa.Column("site_id", sa.String(length=36), nullable=False),
            sa.Column("floor_id", sa.String(length=36), nullable=False),
            sa.Column("zone_id", sa.String(length=36), nullable=True),
            sa.Column("floor_position", sa.JSON(), nullable=False),
            sa.Column("metadata", sa.JSON(), nullable=True),
            sa.Column(
                "status", sa.String(length=32), nullable=False,
                server_default=sa.text("'unknown'"),
            ),
            sa.Column("status_updated_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_by", sa.String(length=36), nullable=True),
            sa.Column("updated_by", sa.String(length=36), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("placement_id", name="pk_device_placements"),
            sa.UniqueConstraint(
                "tenant_id", "device_id", name="uq_device_placements_tenant_device"
            ),
        )
        op.create_index(
            "ix_device_placements_tenant_id", "device_placements", ["tenant_id"]
        )
        op.create_index(
            "ix_device_placements_device_id", "device_placements", ["device_id"]
        )
        op.create_index(
            "ix_device_placements_device_type", "device_placements", ["device_type"]
        )
        op.create_index(
            "ix_device_placements_service", "device_placements", ["service"]
        )
        op.create_index(
            "ix_device_placements_site_id", "device_placements", ["site_id"]
        )
        op.create_index(
            "ix_device_placements_floor_id", "device_placements", ["floor_id"]
        )
        op.create_index(
            "ix_device_placements_zone_id", "device_placements", ["zone_id"]
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "device_placements"):
        op.drop_index("ix_device_placements_zone_id", table_name="device_placements")
        op.drop_index("ix_device_placements_floor_id", table_name="device_placements")
        op.drop_index("ix_device_placements_site_id", table_name="device_placements")
        op.drop_index("ix_device_placements_service", table_name="device_placements")
        op.drop_index(
            "ix_device_placements_device_type", table_name="device_placements"
        )
        op.drop_index(
            "ix_device_placements_device_id", table_name="device_placements"
        )
        op.drop_index(
            "ix_device_placements_tenant_id", table_name="device_placements"
        )
        op.drop_table("device_placements")
