"""ingest event logs — inbound delivery audit trail

Revision ID: 0002_ingest_event_logs
Revises: 0001_ingest
Create Date: 2026-07-08

Creates ``ingest_event_logs`` (one row per inbound ``POST /ingest/hooks/{token}``
request, plus replay rows). Idempotent — uses ``Table.create(checkfirst=True)``
off the live model metadata so it always matches the ORM and is safe to re-run
(the v3 baseline pattern). No DB enums: the per-stage outcome columns are short
plain strings, so the asyncpg add-column-enum footgun does not apply.
"""

from alembic import op

revision = "0002_ingest_event_logs"
down_revision = "0001_ingest"
branch_labels = None
depends_on = None


def _table():
    # Import here so the model registers on Base.metadata at migration time.
    from app.ingest.models import IngestEventLog

    return IngestEventLog.__table__


def upgrade() -> None:
    bind = op.get_bind()
    _table().create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    _table().drop(bind, checkfirst=True)
