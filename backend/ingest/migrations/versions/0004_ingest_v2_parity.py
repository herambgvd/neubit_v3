"""ingest v2 parity: device lookup, event-log status, secret width, indexes

Revision ID: 0004_ingest_v2_parity
Revises: 0003_ingest_event_rules
Create Date: 2026-07-16

Closes the remaining neubit_v2 gaps in the ingest config module, plus one live
bug:

* ``ingest_webhooks.auth_secret_hash`` String(128) → String(2048). This is a
  BUG FIX, not a parity item: ``security.encrypt_secret`` (the hmac path) emits
  ``4 + 32 + 1 + 2*len(plain)`` chars while the schema admits a 1024-char
  secret, so any HMAC secret over ~45 chars overflowed the column on write.
* ``ingest_webhooks.device_lookup_expr`` — the JMESPath naming the sending
  device in the raw payload. v2 resolved it against its devices table; v3 has no
  device registry yet, so the extracted value is published for a downstream
  consumer (see Webhook.device_lookup_expr).
* ``ingest_event_logs.status`` — v2's single-value verdict, restored alongside
  the per-stage outcome columns. Backfilled from the existing columns so old
  rows are filterable in the UI. ``no_rule_match`` / ``rejected_method`` cannot
  be recovered for historical rows (the stage columns never distinguished
  them) — those backfill as the nearest stage-derived value.
* ``ingest_event_logs.device_lookup_value`` / ``resolved_device_id`` — the
  extracted identifier and (once a registry exists) what it resolved to.
* ``uq_ingest_categories_tenant_name`` — v2 held a global unique index on
  category name; the tenant-scoped equivalent is unique per owning tenant.
  SKIPPED with a warning if existing data already violates it, so an upgrade
  never fails on a populated DB — dedupe, then re-run.
* Two composite indexes matching the hot queries: rules by
  (webhook_id, priority, created_at) and logs by (webhook_id, received_at).

All adds are idempotent (guarded by inspection) and use plain String columns —
no PG enum, so the asyncpg add-column-enum footgun does not apply.
"""

import logging

import sqlalchemy as sa
from alembic import op

revision = "0004_ingest_v2_parity"
down_revision = "0003_ingest_event_rules"
branch_labels = None
depends_on = None

logger = logging.getLogger("alembic.runtime.migration")


def _has_column(bind, table: str, column: str) -> bool:
    insp = sa.inspect(bind)
    return column in {c["name"] for c in insp.get_columns(table)}


def _has_index(bind, table: str, index: str) -> bool:
    insp = sa.inspect(bind)
    names = {i["name"] for i in insp.get_indexes(table)}
    names |= {c["name"] for c in insp.get_unique_constraints(table)}
    return index in names


def upgrade() -> None:
    bind = op.get_bind()

    # 1. Widen auth_secret_hash so a long HMAC secret stops overflowing.
    op.alter_column(
        "ingest_webhooks",
        "auth_secret_hash",
        existing_type=sa.String(length=128),
        type_=sa.String(length=2048),
        existing_nullable=True,
    )

    # 2. webhooks.device_lookup_expr.
    if not _has_column(bind, "ingest_webhooks", "device_lookup_expr"):
        op.add_column(
            "ingest_webhooks",
            sa.Column("device_lookup_expr", sa.String(length=512), nullable=True),
        )

    # 3. event_logs.status + the device-identity columns.
    if not _has_column(bind, "ingest_event_logs", "status"):
        op.add_column(
            "ingest_event_logs",
            sa.Column(
                "status",
                sa.String(length=32),
                nullable=False,
                server_default="accepted",
            ),
        )
        # Backfill from the per-stage columns, most-specific first. Rows that
        # published are accepted; the rest name the stage that stopped them.
        op.execute(
            """
            UPDATE ingest_event_logs SET status = CASE
                WHEN published THEN 'accepted'
                WHEN auth_outcome = 'failed' THEN 'rejected_auth'
                WHEN schema_outcome = 'failed' THEN 'rejected_schema'
                WHEN transform_outcome = 'failed' THEN 'transform_failed'
                ELSE 'publish_failed'
            END
            """
        )
        op.create_index("ix_ingest_event_logs_status", "ingest_event_logs", ["status"])

    if not _has_column(bind, "ingest_event_logs", "device_lookup_value"):
        op.add_column(
            "ingest_event_logs",
            sa.Column("device_lookup_value", sa.String(length=256), nullable=True),
        )
    if not _has_column(bind, "ingest_event_logs", "resolved_device_id"):
        op.add_column(
            "ingest_event_logs",
            sa.Column("resolved_device_id", sa.String(length=36), nullable=True),
        )

    # 4. Category name unique per tenant. A populated DB may already hold
    #    duplicates (v3 never enforced this), and failing the whole upgrade over
    #    it would be worse than running without the constraint — warn instead.
    if not _has_index(bind, "ingest_categories", "uq_ingest_categories_tenant_name"):
        dupes = bind.execute(
            sa.text(
                """
                SELECT count(*) FROM (
                    SELECT 1 FROM ingest_categories
                    GROUP BY tenant_id, name HAVING count(*) > 1
                ) d
                """
            )
        ).scalar()
        if dupes:
            logger.warning(
                "ingest: %s duplicate (tenant_id, name) category group(s) — skipping "
                "uq_ingest_categories_tenant_name. Dedupe and re-run this migration "
                "to enforce it.",
                dupes,
            )
        else:
            op.create_index(
                "uq_ingest_categories_tenant_name",
                "ingest_categories",
                ["tenant_id", "name"],
                unique=True,
            )

    # 5. Composite indexes for the two hot queries.
    if not _has_index(bind, "ingest_event_rules", "ix_ingest_event_rules_webhook_priority"):
        op.create_index(
            "ix_ingest_event_rules_webhook_priority",
            "ingest_event_rules",
            ["webhook_id", "priority", "created_at"],
        )
    if not _has_index(bind, "ingest_event_logs", "ix_ingest_event_logs_webhook_received"):
        op.create_index(
            "ix_ingest_event_logs_webhook_received",
            "ingest_event_logs",
            ["webhook_id", "received_at"],
        )


def downgrade() -> None:
    bind = op.get_bind()

    if _has_index(bind, "ingest_event_logs", "ix_ingest_event_logs_webhook_received"):
        op.drop_index("ix_ingest_event_logs_webhook_received", "ingest_event_logs")
    if _has_index(bind, "ingest_event_rules", "ix_ingest_event_rules_webhook_priority"):
        op.drop_index("ix_ingest_event_rules_webhook_priority", "ingest_event_rules")
    if _has_index(bind, "ingest_categories", "uq_ingest_categories_tenant_name"):
        op.drop_index("uq_ingest_categories_tenant_name", "ingest_categories")

    for col in ("resolved_device_id", "device_lookup_value"):
        if _has_column(bind, "ingest_event_logs", col):
            op.drop_column("ingest_event_logs", col)
    if _has_column(bind, "ingest_event_logs", "status"):
        if _has_index(bind, "ingest_event_logs", "ix_ingest_event_logs_status"):
            op.drop_index("ix_ingest_event_logs_status", "ingest_event_logs")
        op.drop_column("ingest_event_logs", "status")

    if _has_column(bind, "ingest_webhooks", "device_lookup_expr"):
        op.drop_column("ingest_webhooks", "device_lookup_expr")

    # Truncates any secret longer than 128 chars — irreversible for those rows.
    op.alter_column(
        "ingest_webhooks",
        "auth_secret_hash",
        existing_type=sa.String(length=2048),
        type_=sa.String(length=128),
        existing_nullable=True,
    )
