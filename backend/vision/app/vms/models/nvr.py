"""NVR (network video recorder) master record — tenant-scoped.

A registered multi-brand NVR/DVR appliance. Cameras onboarded as NVR channels
reference it via ``Camera.nvr_id`` + ``Camera.nvr_channel_number``. Credentials
(ONVIF/ISAPI/brand REST) are stored REVERSIBLY encrypted (``enc:...``) exactly like
the access service's controller secrets — decrypted only to build a connector.
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


class NVR(Base):
    """A registered NVR/DVR appliance (tenant-scoped)."""

    __tablename__ = "nvrs"
    __table_args__ = (
        Index("ix_nvrs_tenant_status", "tenant_id", "status"),
        Index("ix_nvrs_tenant_name", "tenant_id", "name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    is_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )

    # Brand selects the driver: hikvision | cpplus | lumina | dahua | onvif | ...
    brand: Mapped[str] = mapped_column(
        String(64), nullable=False, server_default=text("'onvif'"), index=True
    )
    # Concrete driver key resolved by the driver factory (defaults to brand).
    driver: Mapped[str | None] = mapped_column(String(64))

    host: Mapped[str] = mapped_column(String(255), nullable=False)
    port: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("80"))
    username: Mapped[str] = mapped_column(String(255), nullable=False, server_default=text("''"))
    # Reversibly-encrypted credentials (enc:...); decrypted only to build a connector.
    enc_creds: Mapped[str | None] = mapped_column(String(1024))

    # Declared/detected channel count of the appliance.
    channel_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))

    # online | offline | connecting | error | unknown (plain string, no PG enum).
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'unknown'"), index=True
    )

    # Storage estate (disks/RAID/capacity) + detected capability matrix (JSON blobs).
    storage_info: Mapped[dict] = mapped_column(JSON, nullable=False, server_default=text("'{}'"))
    capabilities: Mapped[dict] = mapped_column(JSON, nullable=False, server_default=text("'{}'"))
    version_info: Mapped[dict] = mapped_column(JSON, nullable=False, server_default=text("'{}'"))

    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(String(2048))

    created_by: Mapped[str | None] = mapped_column(String(64))
    updated_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
