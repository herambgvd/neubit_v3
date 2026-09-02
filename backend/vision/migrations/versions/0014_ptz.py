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

from alembic import op

revision = "0014_ptz"
down_revision = "0013_video_decoder"
branch_labels = None
depends_on = None


def _tables():
    from app.vms.models import PtzPatrol, PtzPreset

    return [PtzPreset.__table__, PtzPatrol.__table__]


def upgrade() -> None:
    bind = op.get_bind()
    for table in _tables():
        table.create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(_tables()):
        table.drop(bind, checkfirst=True)
