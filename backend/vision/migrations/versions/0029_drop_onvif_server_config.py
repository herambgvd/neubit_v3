"""drop onvif_server_config — answering as an ONVIF device belongs to the NVR

Revision ID: 0029_drop_onvif_server_config
Revises: 0028_drop_raid_tier
Create Date: 2026-09-07

``onvif_server_config`` (0011) held one row per tenant describing how THIS VMS would
present itself as an ONVIF device to a third-party client: exposed cameras,
WS-Security service credentials, advertised host/ports. The whole VMS-side module
(``app/vms/onvif_server/`` — SOAP, WS-Discovery advertiser, auth, config CRUD) has
been removed with it.

The reason is ownership, not tidiness: an ONVIF client that finds us will
``GetStreamUri`` and expect media. The VMS aggregates and commands; it does not hold
the streams. The standalone NVR does, and already implements the server side
(``internal/onvifserver/`` — server.go, soap.go, discovery.go). A third-party
recorder should point at the NVR.

The table is empty in the live deployment. Guarded/idempotent both ways.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0029_drop_onvif_server_config"
down_revision = "0028_drop_raid_tier"
branch_labels = None
depends_on = None


def _has_table() -> bool:
    return sa.inspect(op.get_bind()).has_table("onvif_server_config")


def upgrade() -> None:
    if _has_table():
        op.drop_table("onvif_server_config")


def downgrade() -> None:
    # Recreates the table as 0011 left it. The model is gone, so this is literal DDL —
    # a downgrade gets the schema back, not the code that used it.
    if _has_table():
        return
    op.create_table(
        "onvif_server_config",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "exposed_camera_ids",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[\"*\"]'"),
        ),
        sa.Column("service_username", sa.String(length=255), nullable=False),
        sa.Column("service_enc_password", sa.String(length=1024), nullable=True),
        sa.Column(
            "device_name",
            sa.String(length=255),
            nullable=False,
            server_default=sa.text("'Neubit VMS'"),
        ),
        sa.Column("advertised_host", sa.String(length=255), nullable=True),
        sa.Column("advertised_http_port", sa.Integer(), nullable=True),
        sa.Column("advertised_rtsp_port", sa.Integer(), nullable=True),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("updated_by", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_onvif_server_username", "onvif_server_config", ["service_username"], unique=True
    )
    op.create_index("ix_onvif_server_tenant", "onvif_server_config", ["tenant_id"], unique=True)
    op.create_index("ix_onvif_server_enabled", "onvif_server_config", ["enabled"])
