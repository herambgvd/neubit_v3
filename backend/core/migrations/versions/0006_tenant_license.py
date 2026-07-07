"""tenant license fields — expiry + grace window

Adds per-tenant license expiry to the tenants table so the super-admin can set a
license term. `plan` (tier), `features`, and `limits` already exist on the model;
this adds the temporal side (expiry + grace) that drives the effective license
state and the login gate.
"""

import sqlalchemy as sa
from alembic import op

revision = "0006_tenant_license"
down_revision = "0005_app_settings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tenants",
        sa.Column("license_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "tenants",
        sa.Column("grace_days", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("tenants", "grace_days")
    op.drop_column("tenants", "license_expires_at")
