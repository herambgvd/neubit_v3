"""ingest: webhook token -> operator-chosen slug (v2 parity)

Revision ID: 0005_ingest_webhook_slug
Revises: 0004_ingest_v2_parity
Create Date: 2026-07-17

The public URL's last segment goes back to being an operator-chosen, readable
slug — v2's model — instead of a server-minted random token:

    before:  /ingest/hooks/HQx0KxLKEYIKYpzUTP8sDjIrInO_Arc0
    after:   /ingest/hooks/face-detection

The column is RENAMED, not recreated, so existing webhooks keep working: their
random token simply becomes their slug and every integrator's configured URL
stays valid. Those legacy values don't match the new slug format, but the format
is validated in the pydantic schema (create-time only), not by a DB constraint —
so old rows are readable and editable, and only NEW slugs must be well-formed.
An operator who wants a pretty URL for a legacy webhook recreates it.

The uniqueness + index carry over with the rename (Postgres keeps the underlying
index through ALTER ... RENAME COLUMN); only the index NAME still says "token",
so it's renamed too for legibility.
"""

import sqlalchemy as sa
from alembic import op

revision = "0005_ingest_webhook_slug"
down_revision = "0004_ingest_v2_parity"
branch_labels = None
depends_on = None


def _has_column(bind, table: str, column: str) -> bool:
    insp = sa.inspect(bind)
    return column in {c["name"] for c in insp.get_columns(table)}


def _index_names(bind, table: str) -> set[str]:
    insp = sa.inspect(bind)
    return {i["name"] for i in insp.get_indexes(table)} | {
        c["name"] for c in insp.get_unique_constraints(table)
    }


def upgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "ingest_webhooks", "token") and not _has_column(
        bind, "ingest_webhooks", "slug"
    ):
        op.alter_column("ingest_webhooks", "token", new_column_name="slug")
    if "ix_ingest_webhooks_token" in _index_names(bind, "ingest_webhooks"):
        op.execute("ALTER INDEX ix_ingest_webhooks_token RENAME TO ix_ingest_webhooks_slug")


def downgrade() -> None:
    bind = op.get_bind()
    if "ix_ingest_webhooks_slug" in _index_names(bind, "ingest_webhooks"):
        op.execute("ALTER INDEX ix_ingest_webhooks_slug RENAME TO ix_ingest_webhooks_token")
    if _has_column(bind, "ingest_webhooks", "slug") and not _has_column(
        bind, "ingest_webhooks", "token"
    ):
        op.alter_column("ingest_webhooks", "slug", new_column_name="token")
