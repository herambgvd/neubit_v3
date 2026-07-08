"""workflow — notification_templates.provider_template_ref column

Revision ID: 0004_template_provider_ref
Revises: 0003_alert_formats
Create Date: 2026-07-08

Adds ``notification_templates.provider_template_ref`` — the provider-side template
id (e.g. a WhatsApp / Meta Cloud API pre-approved template name/id). Nullable
String(255); v2-parity so a template can reference the connector's registered
template rather than sending a free-form body.

Plain String column (no PG enum), so no asyncpg enum footgun.

Idempotent: only adds the column if absent, so re-running on a DB already built
from the current metadata ``create_all`` is a no-op.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0004_template_provider_ref"
down_revision = "0003_alert_formats"
branch_labels = None
depends_on = None


def _has_column(bind, table: str, column: str) -> bool:
    insp = sa.inspect(bind)
    if not insp.has_table(table):
        return False
    return any(c["name"] == column for c in insp.get_columns(table))


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "notification_templates", "provider_template_ref"):
        op.add_column(
            "notification_templates",
            sa.Column("provider_template_ref", sa.String(length=255), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "notification_templates", "provider_template_ref"):
        op.drop_column("notification_templates", "provider_template_ref")
