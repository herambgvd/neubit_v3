"""access baseline — instances + mirror + doors + events + sync jobs

Revision ID: 0001_access_baseline
Revises:
Create Date: 2026-07-08

Creates the access-control service's own tables in its own DB (neubit_access):
``access_instances``, ``access_mirror``, ``access_doors``, ``access_events`` and
``access_sync_jobs``. Every table is TENANT-SCOPED (nullable ``tenant_id``).

Idempotent — uses ``Table.create(checkfirst=True)`` off the live model metadata so
it is safe to re-run and always matches the ORM (the v3 baseline pattern, same as
``0001_ingest``). No PG enum columns → no asyncpg enum footgun.
"""

from alembic import op

revision = "0001_access_baseline"
down_revision = None
branch_labels = None
depends_on = None


def _tables():
    # Import here so the models register on Base.metadata at migration time.
    from app.access.models import (
        AccessEvent,
        AccessMirror,
        Door,
        Instance,
        SyncJob,
    )

    # Order matters for FKs: instances first, then the tables that reference it.
    return [
        Instance.__table__,
        AccessMirror.__table__,
        Door.__table__,
        AccessEvent.__table__,
        SyncJob.__table__,
    ]


def upgrade() -> None:
    bind = op.get_bind()
    for table in _tables():
        table.create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(_tables()):
        table.drop(bind, checkfirst=True)
