"""HMAC webhooks can require a timestamp, so a captured request expires

Revision ID: 0006_hmac_replay_window
Revises: 0005_ingest_webhook_slug
Create Date: 2026-09-06

The HMAC signature covered the request body and nothing else — no timestamp, no
nonce — so a captured request replayed forever, each replay producing a fresh
accepted event.

`hmac_max_age_seconds` opts a webhook into a signed timestamp: the sender sends
X-Timestamp and signs "<timestamp>.<body>", and anything outside the window is
refused. NULL keeps the body-only signature, which is what GitHub-style senders
produce and which cannot be protected this way.

Nullable with no backfill: an existing webhook keeps working exactly as it did,
and an operator opts it in when the sender can be updated. There are no webhook
rows in this deployment, so new ones start protected via the schema default in the
API layer.

Guarded like 0003-0005: on a FRESH database 0001 creates ingest_webhooks from
the live model, which already has this column, so an unguarded add fails the
whole chain with DuplicateColumnError and ingest never starts.
"""

import sqlalchemy as sa
from alembic import op

revision = "0006_hmac_replay_window"
down_revision = "0005_ingest_webhook_slug"
branch_labels = None
depends_on = None


def _has_column(bind, table: str, column: str) -> bool:
    insp = sa.inspect(bind)
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    if not _has_column(op.get_bind(), "ingest_webhooks", "hmac_max_age_seconds"):
        op.add_column(
            "ingest_webhooks",
            sa.Column("hmac_max_age_seconds", sa.Integer(), nullable=True),
        )


def downgrade() -> None:
    if _has_column(op.get_bind(), "ingest_webhooks", "hmac_max_age_seconds"):
        op.drop_column("ingest_webhooks", "hmac_max_age_seconds")
