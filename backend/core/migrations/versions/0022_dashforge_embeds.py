"""dashforge_embeds — the embed registry, folded in from the retired satellite

Revision ID: 0022_dashforge_embeds
Revises: 0021_drop_dashboards_permissions
Create Date: 2026-09-05

``backend/dashforge`` owned this table in its own database, ``neubit_dashforge``,
from 2026-09-03 to 2026-09-05. The satellite is gone (see app/dashforge/__init__
for why the shape was wrong); the table it held is not, so it lands here.

NO DATA MOVES WITH IT. ``neubit_dashforge.dashforge_embeds`` held 0 rows on the
live stack when this was written, checked before anything was changed, so there
was nothing to carry and this migration does not attempt a cross-database copy.
The old database is deliberately NOT dropped — it is left inert, because a code
change is one revert and a dropped database is not. If a deployment somewhere DID
accumulate registrations, they are still sitting in ``neubit_dashforge`` and can
be inserted here by hand: the columns are identical apart from the constraint
below, and a registration is a pointer plus a name — cheap to re-enter, and worth
re-entering deliberately rather than having a migration guess at a database it
may not be able to reach.

WHAT IS DIFFERENT FROM THE SATELLITE'S 0001, AND WHY
-----------------------------------------------------
``tenant_id`` is now a real FK to ``tenants`` with ON DELETE CASCADE. It could
not be one before — ``tenants`` was in another database — so the satellite got
its DPDP right-to-erase from a NATS subscription
(``kernel.lifecycle.subscribe_tenant_offboard``) that wiped every table with a
``tenant_id`` column when core announced an offboard. Core publishes that event;
it does not consume its own. Folding the module in without replacing the erase
would have left a deleted tenant's registrations sitting here for good, which is
the erase failing silently — the worst way for it to fail. One database means the
constraint can just say it, with no bus to be down at the wrong moment.

Written as explicit ``op.create_table`` rather than the satellite's
``Table.create(checkfirst=True)`` off live ORM metadata: core's chain is a
sequence of deltas after the 0001 baseline, and a metadata-driven step in the
middle of it would silently change shape whenever the model does, which is the
thing a migration exists to stop.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0022_dashforge_embeds"
down_revision = "0021_drop_dashboards_permissions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "dashforge_embeds",
        # String(36) and not Uuid: carried over from the satellite unchanged, so
        # any id already handed to a browser or written into a bookmark keeps
        # meaning the same row.
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Uuid(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("description", sa.String(length=1024), nullable=True),
        # DashForge's own workspace/dashboard ids, as strings — this platform does
        # not encode another product's key type.
        sa.Column("workspace_ref", sa.String(length=64), nullable=False),
        sa.Column("dashboard_ref", sa.String(length=64), nullable=False),
        # The filter bindings locked into the embed token's signature. Never null:
        # the service passes `scope or None` at mint, and a NULL here would make
        # "no lock" and "not set" indistinguishable.
        sa.Column("scope", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_dashforge_embeds_tenant_id", "dashforge_embeds", ["tenant_id"])
    # Unique WITHIN a tenant and only within one: registering the same DashForge
    # dashboard twice in one tenant gives two names for one thing and a viewer no
    # way to tell which is current, while two tenants embedding the same shared
    # dashboard is normal and must not collide.
    op.create_index(
        "uq_dashforge_embeds_tenant_ref",
        "dashforge_embeds",
        ["tenant_id", "workspace_ref", "dashboard_ref"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_dashforge_embeds_tenant_ref", table_name="dashforge_embeds")
    op.drop_index("ix_dashforge_embeds_tenant_id", table_name="dashforge_embeds")
    op.drop_table("dashforge_embeds")
