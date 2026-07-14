"""video-decoder table — hardware decoder push (VW-B)

Revision ID: 0013_video_decoder
Revises: 0012_video_wall
Create Date: 2026-07-09

Adds ``video_decoders`` — the tenant-scoped catalog of hardware video-decoder appliances
(Hik ISAPI dynamic-decoding / Dahua-CP-Plus CGI). When a ``wall_monitor.kind == 'decoder'``,
the wall service pushes the pushed camera's RTSP to this decoder's output channel/cell over
the brand SDK (VW-B). ``enc_password`` is REVERSIBLY encrypted at rest (common.crypto).

Created off the live model metadata (checkfirst=True) — the v3 baseline pattern (matches
0001-0012). Idempotent: a fresh deploy gets the table from the 0001 baseline sweep (which
now lists it); this migration lands it on already-deployed DBs.
"""

from alembic import op

revision = "0013_video_decoder"
down_revision = "0012_video_wall"
branch_labels = None
depends_on = None


def _tables():
    from app.vms.models import VideoDecoder

    return [VideoDecoder.__table__]


def upgrade() -> None:
    bind = op.get_bind()
    for table in _tables():
        table.create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(_tables()):
        table.drop(bind, checkfirst=True)
