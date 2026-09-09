"""vms_events.camera_id — drop the foreign key to this service's own cameras

Revision ID: 0034_vms_events_drop_camera_fk
Revises: 0033_media_node_events_synced_at
Create Date: 2026-09-09

The column pointed at ``cameras.id`` — the cameras THIS service owns rows for. It
owns none: the recorder owns every camera, and an event mirrored from a recorder's
ONVIF ledger names a camera on THAT box. So every mirrored event violated the
constraint and was discarded, silently — the ingest path's except-clause was
written for a racing duplicate and logged whatever it caught at DEBUG as a "dedup
race". The console showed an empty camera-event feed while the recorder held 56
events, and the supervisor advanced its watermark past them because the POLL had
succeeded.

The column keeps its index and stays the thing the console filters on. What it no
longer claims is that the camera has a row here.

Guarded by name lookup: a fresh database builds from live model metadata (see
``0001_vision_baseline``) and therefore has no such constraint to drop.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0034_vms_events_drop_camera_fk"
down_revision = "0033_media_node_events_synced_at"
branch_labels = None
depends_on = None

_TABLE = "vms_events"


def _fk_names(bind) -> list[str]:
    return [
        fk["name"]
        for fk in sa.inspect(bind).get_foreign_keys(_TABLE)
        if fk.get("referred_table") == "cameras" and "camera_id" in (fk.get("constrained_columns") or [])
    ]


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        return  # SQLite never enforced it; rebuilding the table to drop it is not worth it
    for name in _fk_names(bind):
        op.drop_constraint(name, _TABLE, type_="foreignkey")


def downgrade() -> None:
    # Deliberately NOT re-created: restoring it would start discarding every event
    # that comes from a recorder, which is all of them.
    pass
