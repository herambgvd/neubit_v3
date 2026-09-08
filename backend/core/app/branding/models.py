"""Branding ORM model — white-label identity (name, logo, favicon).

One row per tenant, plus one platform-default row with ``tenant_id`` NULL that
tenants fall back to. Portable generic types keep the same model on Postgres and
SQLite (tests).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column

from ..db.base import Base


class Branding(Base):
    """One scope's white-label configuration (a tenant's, or the platform default)."""

    __tablename__ = "branding"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # --- multi-tenancy -----------------------------------------------------
    # The tenant whose branding this is. NULL = the platform default a tenant falls
    # back to, and what the login page / unauthenticated screens show.
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True, index=True,
    )
    # Product name shown in the UI (title bar, login page, emails, …).
    app_name: Mapped[str] = mapped_column(String, nullable=False, default="Neubit")
    # Storage key of the uploaded logo (not a URL) — resolved to a URL on read.
    # None => no custom logo, so the frontend falls back to a default.
    logo_key: Mapped[str | None] = mapped_column(String, nullable=True)
    # Storage key of the uploaded favicon — the browser-tab icon, which is a
    # different image from the logo: it is read at 16px, so a wordmark that works
    # in a header is illegible here.
    favicon_key: Mapped[str | None] = mapped_column(String, nullable=True)
    # RETIRED, and the columns are kept rather than dropped so no deployment loses
    # data it may still want back. `primary_color` / `accent_color` never coloured
    # anything but the swatch beside their own pickers, and `name_in_header` is
    # gone with them: the identity a tenant sets is the name, the logo and the
    # favicon. Nothing reads these three — do not re-expose one without a consumer.
    primary_color: Mapped[str] = mapped_column(String, nullable=False, default="#4f46e5")
    accent_color: Mapped[str] = mapped_column(String, nullable=False, default="#0ea5e9")
    name_in_header: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # Bumped every time branding changes — handy for cache-busting on the client.
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
