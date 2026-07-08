"""vision baseline — VMS control-plane placeholder schema (P1-A)

Revision ID: 0001_vision_baseline
Revises:
Create Date: 2026-07-08

Creates the vision service's own tables in its own DB (neubit_vision). P1-A ships
a single placeholder table (``vms_meta``); the real camera domain (Camera / NVR /
MediaProfile / CameraGroup / CameraACL / CameraHealth / MediaNode / StreamShard)
lands next module — at which point each new model is added to ``_tables()`` here
AND imported in ``migrations/env.py`` (both, or the table is silently dropped).

Idempotent — uses ``Table.create(checkfirst=True)`` off the live model metadata so
it is safe to re-run and always matches the ORM (the v3 baseline pattern, same as
``0001_access_baseline`` / ``0001_ingest``). No PG enum columns → no asyncpg enum
footgun.
"""

from alembic import op

revision = "0001_vision_baseline"
down_revision = None
branch_labels = None
depends_on = None


def _tables():
    # Import here so the models register on Base.metadata at migration time.
    from app.vms.models import VmsMeta

    return [VmsMeta.__table__]


def upgrade() -> None:
    bind = op.get_bind()
    for table in _tables():
        table.create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(_tables()):
        table.drop(bind, checkfirst=True)
