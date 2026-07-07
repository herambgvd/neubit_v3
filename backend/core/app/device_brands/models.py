"""DeviceBrand — the platform catalog of supported device brands / SDKs.

A read-mostly registry (prep for the devices phase): each row describes a camera /
device brand the platform can integrate with — its SDK type, the protocols and
capabilities it supports, whether it speaks ONVIF, and whether its SDK is installed
on this deployment. The super-admin curates it; other roles read it.

Platform-global (NOT tenant-scoped) — one brand catalog for the whole deployment.
Portable generic types (Uuid/String/Boolean/JSON) keep the same model on Postgres
and SQLite (tests). ``protocols`` and ``capabilities`` are JSON string lists.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, String, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column

from ..db.base import Base


class DeviceBrand(Base):
    """One supported device brand in the platform catalog."""

    __tablename__ = "device_brands"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # Stable machine key for the brand (e.g. "hikvision", "dahua", "onvif").
    brand_id: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    # Which integration SDK/driver drives this brand (e.g. "hikvision", "onvif",
    # "rtsp", "generic"). Free-form label consumed by the (future) devices phase.
    sdk_type: Mapped[str] = mapped_column(String, nullable=False, default="onvif")
    # Supported wire protocols, e.g. ["onvif", "rtsp", "http"].
    protocols: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # Supported capabilities, e.g. ["ptz", "events", "audio", "io"].
    capabilities: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # Whether the brand speaks the ONVIF standard (fast path for generic support).
    onvif: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # Whether this brand's SDK/driver is installed & available on this deployment.
    is_installed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
