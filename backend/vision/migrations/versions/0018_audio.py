"""audio_enabled column on cameras — record-audio flag + two-way audio (G6)

Revision ID: 0018_audio
Revises: 0017_motion_zones
Create Date: 2026-07-10

Adds ``audio_enabled`` (Boolean, default ``false``) to ``cameras`` — G6 audio
recording. When true, the audio track (if the RTSP source carries one) is retained
in the recording; false = record video only. The flag travels to the Go ``nvr`` via
the existing recording-config contract (an ``audio`` field on the start-recording
call); MediaMTX records ALL tracks the source publishes, so the honest mechanism is:
audio is recorded when the source has an audio track AND ``audio_enabled`` is on (the
nvr can drop audio for a video-only source variant where the brand supports it —
# LIVE-VALIDATE).

Two-way audio (talk-to-camera) uses the already-detected ``backchannel`` capability
(``Camera.onvif_capabilities.backchannel``) + a talk-session issuer — NO new column
is needed for talk (the capability is stored in the existing ``onvif_capabilities``
JSON blob).

Idempotent: the ADD COLUMN is guarded by an inspector check so the migration is safe
to re-run and skips DBs that already have the column. A fresh deploy gets the column
from the ``Camera`` model metadata via the 0001 baseline sweep (``Camera.__table__``);
this migration lands it on already-deployed DBs.
"""

from alembic import op
from sqlalchemy import inspect, text

revision = "0018_audio"
down_revision = "0017_motion_zones"
branch_labels = None
depends_on = None


def _has_column(bind, table: str, column: str) -> bool:
    insp = inspect(bind)
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "cameras", "audio_enabled"):
        import sqlalchemy as sa

        op.add_column(
            "cameras",
            sa.Column(
                "audio_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=text("false"),
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "cameras", "audio_enabled"):
        op.drop_column("cameras", "audio_enabled")
