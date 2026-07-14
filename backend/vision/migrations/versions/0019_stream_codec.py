"""sub_stream_codec + web_codec_enforced_at on cameras — stream codec policy (G8)

Revision ID: 0019_stream_codec
Revises: 0018_audio
Create Date: 2026-07-11

Adds two columns to ``cameras`` for the zero-transcode-live-view policy (force the web
/ sub stream to H.264 at the device so Chrome WebRTC plays live directly, main stays
H.265 for storage-efficient recording):

  * ``sub_stream_codec`` (String(16), nullable) — last-known SUB stream codec from a
    device probe (``H264`` | ``H265`` | ``MJPEG`` | ...). Surfaced on the camera read so
    the frontend badges "H.264 web ✓" vs "H.265 (transcoded)". NULL = not yet probed.
  * ``web_codec_enforced_at`` (DateTime(tz), nullable) — when the force-H.264-web policy
    last successfully applied to this camera (NULL = never / n/a).

Idempotent: each ADD COLUMN is guarded by an inspector check so the migration is safe to
re-run and skips DBs that already have the column. A fresh deploy gets both columns from
the ``Camera`` model metadata via the 0001 baseline sweep (``Camera.__table__``); this
migration lands them on already-deployed DBs.
"""

from alembic import op
from sqlalchemy import inspect

revision = "0019_stream_codec"
down_revision = "0018_audio"
branch_labels = None
depends_on = None


def _has_column(bind, table: str, column: str) -> bool:
    insp = inspect(bind)
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    import sqlalchemy as sa

    if not _has_column(bind, "cameras", "sub_stream_codec"):
        op.add_column("cameras", sa.Column("sub_stream_codec", sa.String(length=16), nullable=True))
    if not _has_column(bind, "cameras", "web_codec_enforced_at"):
        op.add_column(
            "cameras",
            sa.Column("web_codec_enforced_at", sa.DateTime(timezone=True), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "cameras", "web_codec_enforced_at"):
        op.drop_column("cameras", "web_codec_enforced_at")
    if _has_column(bind, "cameras", "sub_stream_codec"):
        op.drop_column("cameras", "sub_stream_codec")
