"""vision baseline — VMS control-plane schema (P1-B)

Revision ID: 0001_vision_baseline
Revises:
Create Date: 2026-07-08

Creates the vision service's own tables in its own DB (neubit_vision): the full VMS
camera domain — ``cameras``, ``media_profiles``, ``nvrs``, ``camera_groups``,
``camera_acl``, ``camera_health``, ``media_nodes`` and ``stream_shards``. Every
table is TENANT-SCOPED (nullable ``tenant_id``).

⭐ Migration gotcha: each model module MUST be imported in BOTH ``migrations/env.py``
AND the ``_tables()`` sweep below (via ``app.vms.models``), or its table is silently
dropped on a fresh deploy. Add new models to both.

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
    from app.vms.models import (
        NVR,
        Camera,
        CameraACL,
        CameraGroup,
        CameraHealth,
        MediaNode,
        MediaProfile,
        StreamShard,
    )

    # Order matters for FKs: parents (nvrs, media_nodes, cameras) before children.
    return [
        NVR.__table__,
        MediaNode.__table__,
        Camera.__table__,
        MediaProfile.__table__,
        CameraGroup.__table__,
        CameraACL.__table__,
        CameraHealth.__table__,
        StreamShard.__table__,
    ]


def upgrade() -> None:
    bind = op.get_bind()
    for table in _tables():
        table.create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(_tables()):
        table.drop(bind, checkfirst=True)
