"""onvif_server_config table — OUR VMS as an ONVIF device (P6-C)

Revision ID: 0011_onvif_server
Revises: 0010_signed_export_reports
Create Date: 2026-07-09

Adds the per-tenant ``onvif_server_config`` table backing the ONVIF SOAP server
(``/onvif/*``): enable flag, exposed-camera allow-list, WS-Security service creds
(password reversibly encrypted), and advertised host/ports for the RTSP StreamUri +
WS-Discovery XAddr.

Created off the live model metadata (checkfirst=True) — the v3 baseline pattern
(matches 0001-0010). Idempotent: a fresh deploy gets the table from the 0001 baseline
sweep (which now lists it); this migration lands it on already-deployed DBs.
"""

from alembic import op

revision = "0011_onvif_server"
down_revision = "0010_signed_export_reports"
branch_labels = None
depends_on = None


def _table():
    from app.vms.models import OnvifServerConfig

    return OnvifServerConfig.__table__


def upgrade() -> None:
    bind = op.get_bind()
    _table().create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    _table().drop(bind, checkfirst=True)
