"""merge divergent heads: camera_group_active + drop_camera_dewarp_pos

Revision ID: 0027_merge_camera_heads
Revises: 0026_drop_camera_dewarp_pos, 0025_camera_group_active
Create Date: 2026-08-04

Two migrations branched off 0024_recording_media_node in parallel:
  * 0025_media_node_credential -> 0026_drop_camera_dewarp_pos  (this line)
  * 0025_camera_group_active                                   (the Core branch)
leaving alembic with TWO heads, so `upgrade head` errored. This is an empty merge
that joins them back into a single head — no schema change of its own.
"""

# No-op merge point.
revision = "0027_merge_camera_heads"
down_revision = ("0026_drop_camera_dewarp_pos", "0025_camera_group_active")
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
