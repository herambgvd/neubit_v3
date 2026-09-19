"""sites: what feeds a piece of equipment — the power chain as a tree

Revision ID: 0033_equipment_fed_by
Revises: 0032_site_infrastructure
Create Date: 2026-09-20

A building's meters were a flat list. The estate has a main incomer, incomers
under it, sub-incomers under those and distribution boards at the bottom — and
nothing in the registry could say which hangs off which, so the plant view
could not draw a single-line and a board's load could not be read against the
feeder it sits on.

`site_equipment.fed_by_id` names the ONE piece of equipment upstream of this
one, on the same site. Nullable (most equipment is fed by nothing the registry
knows about), SET NULL on delete (removing a sub-incomer unhooks its boards,
it does not delete them), indexed (the tree is read top-down).

Same-site, not-itself and no-loop are refused by the service; the database
holds only the reference. Nothing here imports `app.*`.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0033_equipment_fed_by"
down_revision = "0032_site_infrastructure"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "site_equipment",
        sa.Column("fed_by_id", sa.String(length=36), nullable=True),
    )
    op.create_foreign_key(
        "fk_site_equipment_fed_by",
        "site_equipment",
        "site_equipment",
        ["fed_by_id"],
        ["equipment_id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_site_equipment_fed_by_id", "site_equipment", ["fed_by_id"])


def downgrade() -> None:
    op.drop_index("ix_site_equipment_fed_by_id", table_name="site_equipment")
    op.drop_constraint("fk_site_equipment_fed_by", "site_equipment", type_="foreignkey")
    op.drop_column("site_equipment", "fed_by_id")
