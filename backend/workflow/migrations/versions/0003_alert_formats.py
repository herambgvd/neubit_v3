"""workflow — alert_formats table (alert_code → SOP mapping)

Revision ID: 0003_alert_formats
Revises: 0002_notification_backoff
Create Date: 2026-07-08

Adds ``alert_formats``: maps an alert code (e.g. "TEST_ALERT", "unknown_card")
to a SOP, carrying category / severity / priority / icon / alert_sound / color +
a sop_mode (automatic → new incident ACTIVE, manual → PENDING). When an incoming
event carries a matching alert code, the correlation engine (and the simulate
endpoint) spin up an incident from the mapped SOP.

Tenant-scoped (nullable ``tenant_id``; NULL = platform/system). ``alert_code`` is
unique PER TENANT — enforced by a composite unique index. Simple String columns
for category/severity/priority (no PG enums) — matches v2 and dodges the asyncpg
enum footgun.

Idempotent: only creates the table + indexes if absent, so re-running on a DB
already built from metadata ``create_all`` is a no-op.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003_alert_formats"
down_revision = "0002_notification_backoff"
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

    if not _has_table(bind, "alert_formats"):
        op.create_table(
            "alert_formats",
            sa.Column("format_id", sa.String(length=36), nullable=False),
            sa.Column("alert_code", sa.String(length=128), nullable=False),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("description", sa.String(length=2048), nullable=True),
            sa.Column("category", sa.String(length=32), nullable=False, server_default=sa.text("'custom'")),
            sa.Column("severity", sa.String(length=16), nullable=False, server_default=sa.text("'medium'")),
            sa.Column("priority", sa.String(length=16), nullable=False, server_default=sa.text("'medium'")),
            sa.Column("color_code", sa.String(length=16), server_default=sa.text("'#6B7280'")),
            sa.Column("icon", sa.String(length=64), nullable=True),
            sa.Column("alert_sound", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("sop_id", sa.String(length=36), nullable=True),
            sa.Column("sop_mode", sa.String(length=16), nullable=False, server_default=sa.text("'manual'")),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column("created_by", sa.String(length=64), nullable=True),
            sa.Column("updated_by", sa.String(length=64), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("format_id", name="pk_alert_formats"),
        )

    if not _has_index(bind, "alert_formats", "ix_alert_formats_tenant_id"):
        op.create_index("ix_alert_formats_tenant_id", "alert_formats", ["tenant_id"])
    if not _has_index(bind, "alert_formats", "ix_alert_formats_alert_code"):
        op.create_index("ix_alert_formats_alert_code", "alert_formats", ["alert_code"])
    if not _has_index(bind, "alert_formats", "ix_alert_formats_name"):
        op.create_index("ix_alert_formats_name", "alert_formats", ["name"])
    if not _has_index(bind, "alert_formats", "ix_alert_formats_sop_id"):
        op.create_index("ix_alert_formats_sop_id", "alert_formats", ["sop_id"])
    if not _has_index(bind, "alert_formats", "ix_alert_formats_is_active"):
        op.create_index("ix_alert_formats_is_active", "alert_formats", ["is_active"])
    # alert_code unique PER TENANT.
    if not _has_index(bind, "alert_formats", "uq_alert_formats_tenant_code"):
        op.create_index(
            "uq_alert_formats_tenant_code", "alert_formats",
            ["tenant_id", "alert_code"], unique=True,
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "alert_formats"):
        op.drop_table("alert_formats")
