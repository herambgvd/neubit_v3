"""ingest event rules + webhook request_method + event-log matched_rule_id

Revision ID: 0003_ingest_event_rules
Revises: 0002_ingest_event_logs
Create Date: 2026-07-08

Brings the ingest service to neubit_v2 parity for VMS-independent features:

* Creates ``ingest_event_rules`` — per-webhook payload-driven routing rules
  (name/description/priority/match_conditions/field_map/event_type/target_domain/
  enabled), tenant-scoped, FK to ``ingest_webhooks`` (ON DELETE CASCADE). Made
  off the live model metadata with ``Table.create(checkfirst=True)`` so it always
  matches the ORM and is safe to re-run (the v3 baseline pattern).
* Adds ``ingest_webhooks.request_method`` (``'post'`` default) so a webhook can
  read its payload from query params (``get``) or body (``post``).
* Adds ``ingest_event_logs.matched_rule_id`` recording which rule (if any)
  determined the emitted event_type.

All columns are plain String/JSON/Integer/Boolean — NO PG enum, so the asyncpg
add-column-enum footgun does not apply. The column adds are idempotent (guarded
against re-run by inspecting existing columns).
"""

import sqlalchemy as sa
from alembic import op

revision = "0003_ingest_event_rules"
down_revision = "0002_ingest_event_logs"
branch_labels = None
depends_on = None


def _rules_table():
    # Import here so the model registers on Base.metadata at migration time.
    from app.ingest.models import IngestEventRule

    return IngestEventRule.__table__


def _has_column(bind, table: str, column: str) -> bool:
    insp = sa.inspect(bind)
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()

    # 1. New rules table (idempotent, off live metadata).
    _rules_table().create(bind, checkfirst=True)

    # 2. webhooks.request_method (idempotent add).
    if not _has_column(bind, "ingest_webhooks", "request_method"):
        op.add_column(
            "ingest_webhooks",
            sa.Column(
                "request_method",
                sa.String(length=8),
                nullable=False,
                server_default="post",
            ),
        )

    # 3. event_logs.matched_rule_id (idempotent add, nullable).
    if not _has_column(bind, "ingest_event_logs", "matched_rule_id"):
        op.add_column(
            "ingest_event_logs",
            sa.Column("matched_rule_id", sa.String(length=36), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "ingest_event_logs", "matched_rule_id"):
        op.drop_column("ingest_event_logs", "matched_rule_id")
    if _has_column(bind, "ingest_webhooks", "request_method"):
        op.drop_column("ingest_webhooks", "request_method")
    _rules_table().drop(bind, checkfirst=True)
