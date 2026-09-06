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
"""

import sqlalchemy as sa
from alembic import op

revision = "0006_hmac_replay_window"
down_revision = "0005_ingest_webhook_slug"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ingest_webhooks",
        sa.Column("hmac_max_age_seconds", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("ingest_webhooks", "hmac_max_age_seconds")
