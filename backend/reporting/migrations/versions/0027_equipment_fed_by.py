"""reporting: mirror what feeds a piece of equipment

Revision ID: 0027_equipment_fed_by
Revises: 0026_equipment_registry
Create Date: 2026-09-20

Core 0033 gave `site_equipment` a `fed_by_id` — the one piece of equipment
upstream of it, which is what turns a flat list of meters into a power chain.
The mirror carries it so the plant view can draw a single-line without reading
core. No foreign key, for the same reason `system_id` has none here: the
parent's event can land after the child's.

Nothing here imports `reporting.*`.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0027_equipment_fed_by"
down_revision = "0026_equipment_registry"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "site_equipment",
        sa.Column("fed_by_id", postgresql.UUID(as_uuid=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("site_equipment", "fed_by_id")
