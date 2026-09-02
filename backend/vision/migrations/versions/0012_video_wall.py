"""video-wall tables — shared control-room display wall (VW-A)

Revision ID: 0012_video_wall
Revises: 0011_onvif_server
Create Date: 2026-07-09

Adds the video-wall domain: ``video_walls`` (named rows×cols display surface + a single
JSON ``state`` blob = the live shared state), ``wall_monitors`` (screens, browser|decoder,
mini-grid layout, decoder_* nullable for VW-B), ``wall_presets`` (saved state snapshots)
and ``wall_tours`` (ordered preset sequences cycled on a dwell). All tenant-scoped.

Created off the live model metadata (checkfirst=True) — the v3 baseline pattern (matches
0001-0011). Idempotent: a fresh deploy gets the tables from the 0001 baseline sweep (which
now lists them); this migration lands them on already-deployed DBs.
"""

from alembic import op

revision = "0012_video_wall"
down_revision = "0011_onvif_server"
branch_labels = None
depends_on = None


def _tables():
    from app.vms.models import VideoWall, WallMonitor, WallPreset, WallTour

    # Parent (video_walls) first so children can be created after (no hard FKs, but
    # keeps a sensible creation order).
    return [
        VideoWall.__table__,
        WallMonitor.__table__,
        WallPreset.__table__,
        WallTour.__table__,
    ]


def upgrade() -> None:
    bind = op.get_bind()
    for table in _tables():
        table.create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(_tables()):
        table.drop(bind, checkfirst=True)
