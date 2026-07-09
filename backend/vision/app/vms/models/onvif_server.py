"""OnvifServerConfig — per-tenant config for OUR VMS acting as an ONVIF device (P6-C).

When ``enabled``, this tenant's cameras are exposed over the ONVIF SOAP server
(``/onvif/*``) so an external VMS/recorder (Milestone / Genetec / a third-party NVR)
can discover us via WS-Discovery, ``GetProfiles`` our exposed cameras, ``GetStreamUri``
→ OUR MediaMTX RTSP URL, and pull recordings via Profile-G (``GetRecordings`` /
``GetReplayUri``).

The row is the SERVER identity for a tenant: the ONVIF client authenticates with a
WS-Security UsernameToken against ``service_username`` + the reversibly-encrypted
``service_enc_password`` (``vms.common.crypto``, same construction as camera creds).
The username→tenant map is what makes the SOAP server multi-tenant: the "device" a
client sees is exactly the tenant that owns the matching service credentials.

``exposed_camera_ids`` is either the literal ``["*"]`` (expose every enabled camera in
the tenant) or an explicit allow-list of camera ids. Advertised host/ports drive the
RTSP StreamUri + the WS-Discovery XAddr when the container's request host isn't the
externally-reachable one.

Tenant-scoped (nullable ``tenant_id``); plain-string columns, NO PG enum (asyncpg
add-column enum footgun, project memory). One row per tenant (unique ``tenant_id``).

⭐ Migration gotcha: this module MUST be imported in ``app.vms.models.__init__`` (so it
registers on ``Base.metadata``), which is imported by BOTH ``migrations/env.py`` AND
``0001_vision_baseline._tables()`` — a table whose module is not imported in both is
silently dropped on a fresh deploy. ``0011_onvif_server`` lands it on deployed DBs.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Index,
    Integer,
    String,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from ._common import _utcnow, _uuid_str


class OnvifServerConfig(Base):
    """Per-tenant ONVIF-server config (one row per tenant)."""

    __tablename__ = "onvif_server_config"
    __table_args__ = (
        # The SOAP auth path resolves a tenant by service_username → unique index.
        Index("ix_onvif_server_username", "service_username", unique=True),
        # One config row per tenant.
        Index("ix_onvif_server_tenant", "tenant_id", unique=True),
        Index("ix_onvif_server_enabled", "enabled"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )

    # Which cameras this tenant exposes over ONVIF. ``["*"]`` = every enabled camera
    # in the tenant; else an explicit list of camera ids.
    exposed_camera_ids: Mapped[list] = mapped_column(
        JSON, nullable=False, server_default=text("'[\"*\"]'")
    )

    # WS-Security UsernameToken creds the ONVIF client authenticates with. The
    # password is stored REVERSIBLY encrypted (``enc:...``, vms.common.crypto) — it
    # must be recoverable to validate a PasswordDigest / PasswordText token.
    service_username: Mapped[str] = mapped_column(String(255), nullable=False)
    service_enc_password: Mapped[str | None] = mapped_column(String(1024))

    # Advertised device identity (surfaced in GetDeviceInformation).
    device_name: Mapped[str] = mapped_column(
        String(255), nullable=False, server_default=text("'Neubit VMS'")
    )

    # Externally-reachable host/ports for the RTSP StreamUri + WS-Discovery XAddr.
    # NULL → derive from the SOAP request host (behind the gateway).
    advertised_host: Mapped[str | None] = mapped_column(String(255))
    # HTTP port the ONVIF SOAP services are reachable on (the gateway :80 by default).
    advertised_http_port: Mapped[int | None] = mapped_column(Integer)
    # RTSP port the MediaMTX StreamUri points at (default 8554; VE_MEDIAMTX_RTSP_BASE).
    advertised_rtsp_port: Mapped[int | None] = mapped_column(Integer)

    created_by: Mapped[str | None] = mapped_column(String(64))
    updated_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
