"""access local catalog — access_groups + access_schedules

Revision ID: 0002_access_local_catalog
Revises: 0001_access_baseline
Create Date: 2026-07-08

Creates the two LOCAL, instance-scoped catalog tables ported faithfully from
``neubit_v2/backend/gates/app/module/access_groups``:

  * ``access_groups``    — v2 ``AccessGroupDocument`` (name / description /
                           access_group_type / api_key / door_ids / schedule_id).
  * ``access_schedules`` — v2 ``ScheduleDocument`` (name / description / timezone /
                           windows[TimeWindow] / holidays).

These are LOCAL repository catalogs (NOT DDS write-through). Every row is
TENANT-scoped (nullable ``tenant_id``) AND INSTANCE-scoped (FK → access_instances,
ondelete CASCADE).

Idempotent — uses ``Table.create(checkfirst=True)`` off the live model metadata so
it always matches the ORM (the v3 baseline pattern). No PG enum columns → no
asyncpg enum footgun.
"""

from alembic import op

revision = "0002_access_local_catalog"
down_revision = "0001_access_baseline"
branch_labels = None
depends_on = None


def _tables():
    # Import here so the models register on Base.metadata at migration time.
    from app.access.models import AccessGroup, Schedule

    return [AccessGroup.__table__, Schedule.__table__]


def upgrade() -> None:
    bind = op.get_bind()
    for table in _tables():
        table.create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(_tables()):
        table.drop(bind, checkfirst=True)
