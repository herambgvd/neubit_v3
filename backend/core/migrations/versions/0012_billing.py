"""billing — plans, subscriptions, invoices (Phase 4.1)

Revision ID: 0012_billing
Revises: 0011_device_placements
Create Date: 2026-07-09

Internal commercial records for the super-admin console: a Plan catalog, a
per-tenant Subscription (one active row per tenant), and Invoices tracked through
their lifecycle. No external payment provider — these are self-contained records.

Created idempotently: only created if missing, so re-running on a DB already built
from the baseline metadata ``create_all`` is a no-op.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0012_billing"
down_revision = "0011_device_placements"
branch_labels = None
depends_on = None


def _has_table(bind, name: str) -> bool:
    return sa.inspect(bind).has_table(name)


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "billing_plans"):
        op.create_table(
            "billing_plans",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("key", sa.String(), nullable=False),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("description", sa.String(), nullable=False, server_default=sa.text("''")),
            sa.Column("price_cents", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("currency", sa.String(), nullable=False, server_default=sa.text("'USD'")),
            sa.Column("interval", sa.String(), nullable=False, server_default=sa.text("'monthly'")),
            sa.Column("features", sa.JSON(), nullable=False),
            sa.Column("limits", sa.JSON(), nullable=False),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.PrimaryKeyConstraint("id", name="pk_billing_plans"),
            sa.UniqueConstraint("key", name="uq_billing_plans_key"),
        )
        op.create_index("ix_billing_plans_key", "billing_plans", ["key"], unique=True)

    if not _has_table(bind, "billing_subscriptions"):
        op.create_table(
            "billing_subscriptions",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("tenant_id", sa.Uuid(), nullable=False),
            sa.Column("plan_key", sa.String(), nullable=False),
            sa.Column("status", sa.String(), nullable=False, server_default=sa.text("'active'")),
            sa.Column("current_period_start", sa.DateTime(timezone=True), nullable=True),
            sa.Column("current_period_end", sa.DateTime(timezone=True), nullable=True),
            sa.Column("canceled_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.PrimaryKeyConstraint("id", name="pk_billing_subscriptions"),
            sa.ForeignKeyConstraint(
                ["tenant_id"], ["tenants.id"], ondelete="CASCADE",
                name="fk_billing_subscriptions_tenant_id",
            ),
            sa.UniqueConstraint("tenant_id", name="uq_billing_subscriptions_tenant_id"),
        )
        op.create_index(
            "ix_billing_subscriptions_tenant_id", "billing_subscriptions", ["tenant_id"], unique=True
        )

    if not _has_table(bind, "billing_invoices"):
        op.create_table(
            "billing_invoices",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("tenant_id", sa.Uuid(), nullable=False),
            sa.Column("number", sa.String(), nullable=False),
            sa.Column("amount_cents", sa.Integer(), nullable=False),
            sa.Column("currency", sa.String(), nullable=False, server_default=sa.text("'USD'")),
            sa.Column("status", sa.String(), nullable=False, server_default=sa.text("'issued'")),
            sa.Column("period_start", sa.DateTime(timezone=True), nullable=True),
            sa.Column("period_end", sa.DateTime(timezone=True), nullable=True),
            sa.Column("issued_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("due_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("notes", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.PrimaryKeyConstraint("id", name="pk_billing_invoices"),
            sa.ForeignKeyConstraint(
                ["tenant_id"], ["tenants.id"], ondelete="CASCADE",
                name="fk_billing_invoices_tenant_id",
            ),
        )
        op.create_index("ix_billing_invoices_tenant_id", "billing_invoices", ["tenant_id"])
        op.create_index("ix_billing_invoices_number", "billing_invoices", ["number"])
        op.create_index("ix_billing_invoices_status", "billing_invoices", ["status"])


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "billing_invoices"):
        op.drop_index("ix_billing_invoices_status", table_name="billing_invoices")
        op.drop_index("ix_billing_invoices_number", table_name="billing_invoices")
        op.drop_index("ix_billing_invoices_tenant_id", table_name="billing_invoices")
        op.drop_table("billing_invoices")
    if _has_table(bind, "billing_subscriptions"):
        op.drop_index("ix_billing_subscriptions_tenant_id", table_name="billing_subscriptions")
        op.drop_table("billing_subscriptions")
    if _has_table(bind, "billing_plans"):
        op.drop_index("ix_billing_plans_key", table_name="billing_plans")
        op.drop_table("billing_plans")
