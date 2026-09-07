"""ptz preset + patrol tables — PTZ operator control (G1)

Revision ID: 0014_ptz
Revises: 0013_video_decoder
Create Date: 2026-07-10

Adds ``ptz_presets`` (named saved viewpoints, tenant-scoped, per camera) and
``ptz_patrols`` (ordered guard-tours: stops + per-stop dwell, cycled by the server-side
patrol cycler). Both back the PTZ operator surface (continuous move / zoom / preset CRUD /
patrols) on top of the transient driver PTZ commands.

Created off the live model metadata (checkfirst=True) — the v3 baseline pattern (matches
0001-0013). Idempotent: a fresh deploy gets the tables from the 0001 baseline sweep (which
now lists them); this migration lands them on already-deployed DBs.
"""

import sqlalchemy as sa
from alembic import op

revision = "0014_ptz"
down_revision = "0013_video_decoder"
branch_labels = None
depends_on = None

# The model this revision built from is GONE (0031 drops the table; the work moved to
# the recorder that owns the footage). It used to call ``Table.create`` off live model
# metadata, which is what makes a baseline drift forward with the models — and an
# import of a deleted model here breaks ``alembic upgrade head`` on a FRESH database,
# where every revision runs. So the upgrade is a documented no-op: on an existing
# deployment the table is already there and 0031 removes it; on a new one it is never
# created. The downgrade still drops it, so walking back down the chain past this
# point leaves the schema as this revision found it.


def upgrade() -> None:
    pass


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table in ['ptz_patrols', 'ptz_presets']:
        if inspector.has_table(table):
            op.drop_table(table)
