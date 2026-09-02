"""media_nodes routing columns — recorder-machine api_url + MediaMTX bases + label

Revision ID: 0023_media_node_routing
Revises: 0022_report_runs
Create Date: 2026-07-16

MN-1a node registry: promotes ``media_nodes`` from a bare MediaMTX-worker stub into an
onboardable INDEPENDENT recorder machine. Each recorder runs its OWN Go ``nvr`` (data
plane) with its own base URL + MediaMTX media bases; the control-plane (vision) heartbeats
+ (later) routes per node. Adds:

  * ``api_url``     (String(512), nullable) — the recorder's Go-nvr base URL, the KEY
    routing/heartbeat target (REQUIRED on create at the API layer; nullable in the DB so
    already-deployed rows predate it).
  * ``hls_base`` / ``webrtc_base`` / ``rtsp_base`` (String(512), nullable) — the machine's
    MediaMTX media bases.
  * ``label``       (String(255), nullable) — human location/region tag.

Idempotent add-columns (guarded by an inspector check, matching 0021_nvr_channels). A
fresh deploy gets these columns from the ``MediaNode`` model metadata via the 0001
baseline sweep (``MediaNode.__table__``, already listed) — the model + env.py imports are
unchanged (media_node was already registered), so only the ALREADY-DEPLOYED DB path needs
this migration. No PG enum columns → no asyncpg add-column footgun.
"""

from alembic import op
from sqlalchemy import inspect

revision = "0023_media_node_routing"
down_revision = "0022_report_runs"
branch_labels = None
depends_on = None

_COLUMNS = ("api_url", "hls_base", "webrtc_base", "rtsp_base", "label")


def _has_column(bind, table: str, column: str) -> bool:
    insp = inspect(bind)
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    import sqlalchemy as sa

    lengths = {"label": 255}
    for name in _COLUMNS:
        if not _has_column(bind, "media_nodes", name):
            op.add_column(
                "media_nodes",
                sa.Column(name, sa.String(length=lengths.get(name, 512)), nullable=True),
            )


def downgrade() -> None:
    bind = op.get_bind()
    for name in reversed(_COLUMNS):
        if _has_column(bind, "media_nodes", name):
            op.drop_column("media_nodes", name)
