"""sites — site + floor + zone tables (site hierarchy)

Revision ID: 0009_sites
Revises: 0008_catalog
Create Date: 2026-07-07

Ports the neubit_v2 sites capability (site → floor → zone; device-placement is
deferred). Each table is TENANT-SCOPED: it carries a nullable ``tenant_id`` (the
owning tenant; NULL = a platform/super-admin/system row) matching the row-scoping
pattern used by 0007 for audit_log / report_jobs / roles / api_keys.

Created idempotently: a table is only created if missing, so re-running on a DB
already built from the baseline metadata ``create_all`` is a no-op.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0009_sites"
down_revision = "0008_catalog"
branch_labels = None
depends_on = None


def _has_table(bind, name: str) -> bool:
    return sa.inspect(bind).has_table(name)


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "sites"):
        op.create_table(
            "sites",
            sa.Column("site_id", sa.String(length=36), nullable=False),
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("location_code", sa.String(length=64), nullable=True),
            sa.Column("description", sa.String(length=2048), nullable=True),
            sa.Column(
                "site_type", sa.String(length=64), nullable=False,
                server_default=sa.text("'building'"),
            ),
            sa.Column("parent_id", sa.String(length=36), nullable=True),
            sa.Column(
                "threat_level", sa.String(length=32), nullable=False,
                server_default=sa.text("'normal'"),
            ),
            sa.Column("threat_level_updated_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("address", sa.JSON(), nullable=True),
            sa.Column("coordinates", sa.JSON(), nullable=True),
            sa.Column("geo_location", sa.JSON(), nullable=True),
            sa.Column("contact_person", sa.String(length=255), nullable=True),
            sa.Column("contact_phone", sa.String(length=64), nullable=True),
            sa.Column("email_address", sa.String(length=320), nullable=True),
            sa.Column("image_url", sa.String(length=1024), nullable=True),
            sa.Column(
                "is_active", sa.Boolean(), nullable=False, server_default=sa.text("true"),
            ),
            sa.Column("created_by", sa.String(length=36), nullable=True),
            sa.Column("updated_by", sa.String(length=36), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("site_id", name="pk_sites"),
        )
        op.create_index("ix_sites_tenant_id", "sites", ["tenant_id"])
        op.create_index("ix_sites_name", "sites", ["name"])
        op.create_index("ix_sites_parent_id", "sites", ["parent_id"])
        op.create_index("ix_sites_threat_level", "sites", ["threat_level"])
        op.create_index("ix_sites_is_active", "sites", ["is_active"])

    if not _has_table(bind, "floors"):
        op.create_table(
            "floors",
            sa.Column("floor_id", sa.String(length=36), nullable=False),
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column("site_id", sa.String(length=36), nullable=False),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("floor_number", sa.Integer(), nullable=True),
            sa.Column("description", sa.String(length=2048), nullable=True),
            sa.Column("floorplan_url", sa.String(length=1024), nullable=True),
            sa.Column("total_area", sa.Float(), nullable=True),
            sa.Column(
                "is_active", sa.Boolean(), nullable=False, server_default=sa.text("true"),
            ),
            sa.Column("created_by", sa.String(length=36), nullable=True),
            sa.Column("updated_by", sa.String(length=36), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("floor_id", name="pk_floors"),
        )
        op.create_index("ix_floors_tenant_id", "floors", ["tenant_id"])
        op.create_index("ix_floors_site_id", "floors", ["site_id"])
        op.create_index("ix_floors_is_active", "floors", ["is_active"])

    if not _has_table(bind, "zones"):
        op.create_table(
            "zones",
            sa.Column("zone_id", sa.String(length=36), nullable=False),
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column("site_id", sa.String(length=36), nullable=False),
            sa.Column("floor_id", sa.String(length=36), nullable=False),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("description", sa.String(length=2048), nullable=True),
            sa.Column(
                "zone_type", sa.String(length=64), nullable=False,
                server_default=sa.text("'other'"),
            ),
            sa.Column(
                "threat_level", sa.String(length=32), nullable=False,
                server_default=sa.text("'normal'"),
            ),
            sa.Column("color", sa.String(length=32), nullable=True),
            sa.Column(
                "alert_on_entry", sa.Boolean(), nullable=False,
                server_default=sa.text("false"),
            ),
            sa.Column(
                "alert_on_exit", sa.Boolean(), nullable=False,
                server_default=sa.text("false"),
            ),
            sa.Column("max_occupancy", sa.Integer(), nullable=True),
            sa.Column("polygon", sa.JSON(), nullable=True),
            sa.Column("geo_polygon", sa.JSON(), nullable=True),
            sa.Column(
                "is_active", sa.Boolean(), nullable=False, server_default=sa.text("true"),
            ),
            sa.Column("created_by", sa.String(length=36), nullable=True),
            sa.Column("updated_by", sa.String(length=36), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("zone_id", name="pk_zones"),
        )
        op.create_index("ix_zones_tenant_id", "zones", ["tenant_id"])
        op.create_index("ix_zones_site_id", "zones", ["site_id"])
        op.create_index("ix_zones_floor_id", "zones", ["floor_id"])
        op.create_index("ix_zones_is_active", "zones", ["is_active"])


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "zones"):
        op.drop_index("ix_zones_is_active", table_name="zones")
        op.drop_index("ix_zones_floor_id", table_name="zones")
        op.drop_index("ix_zones_site_id", table_name="zones")
        op.drop_index("ix_zones_tenant_id", table_name="zones")
        op.drop_table("zones")
    if _has_table(bind, "floors"):
        op.drop_index("ix_floors_is_active", table_name="floors")
        op.drop_index("ix_floors_site_id", table_name="floors")
        op.drop_index("ix_floors_tenant_id", table_name="floors")
        op.drop_table("floors")
    if _has_table(bind, "sites"):
        op.drop_index("ix_sites_is_active", table_name="sites")
        op.drop_index("ix_sites_threat_level", table_name="sites")
        op.drop_index("ix_sites_parent_id", table_name="sites")
        op.drop_index("ix_sites_name", table_name="sites")
        op.drop_index("ix_sites_tenant_id", table_name="sites")
        op.drop_table("sites")
