"""nvrs.channels — persist the enumerated channel map on the NVR row (v2 parity)

Revision ID: 0021_nvr_channels
Revises: 0020_raid
Create Date: 2026-07-15

Promotes the NVR channel map from a transient ``capabilities['channels_cache']`` blob
to a first-class ``nvrs.channels`` JSON column — the authoritative, one-time enumerated
channel list (neubit_v2 stored the same on ``nvr.channels``). Structured storage that
the UI reads directly and that future channel↔camera/relationship joins can key off,
rather than a cache tucked inside capabilities.

  * ``channels`` (JSON, NOT NULL, default ``[]``) — list of channel dicts
    {channel, channel_number, source_token, name, main{...}, sub{...}, ...}.

Idempotent add-column (guarded by an inspector check). A fresh deploy gets the column
from the ``NVR`` model metadata via the 0001 baseline sweep (``NVR.__table__``); this
migration lands it on already-deployed DBs. A follow-on data step in the service layer
migrates any existing ``capabilities['channels_cache']`` into the new column on first
enumeration.
"""

from alembic import op
from sqlalchemy import inspect

revision = "0021_nvr_channels"
down_revision = "0020_raid"
branch_labels = None
depends_on = None


def _has_column(bind, table: str, column: str) -> bool:
    insp = inspect(bind)
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    import sqlalchemy as sa

    if not _has_column(bind, "nvrs", "channels"):
        op.add_column(
            "nvrs",
            sa.Column("channels", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "nvrs", "channels"):
        op.drop_column("nvrs", "channels")
