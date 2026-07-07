"""ingest baseline — categories + webhooks

Revision ID: 0001_ingest
Revises:
Create Date: 2026-07-07

Creates the ingest service's own tables in its own DB (neubit_ingest):
``ingest_categories`` and ``ingest_webhooks``. Idempotent — uses
``Table.create(checkfirst=True)`` off the live model metadata so it is safe to
re-run and always matches the ORM (the v3 baseline pattern).
"""

from alembic import op

revision = "0001_ingest"
down_revision = None
branch_labels = None
depends_on = None


def _tables():
    # Import here so the models register on Base.metadata at migration time.
    from app.ingest.models import IngestCategory, Webhook

    # Order matters for FK: categories before webhooks.
    return [IngestCategory.__table__, Webhook.__table__]


def upgrade() -> None:
    bind = op.get_bind()
    for table in _tables():
        table.create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(_tables()):
        table.drop(bind, checkfirst=True)
