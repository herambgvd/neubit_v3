"""Branding ORM model — white-label identity (name, logo, brand colours).

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
    # Brand colours as CSS hex strings — the frontend maps these to theme tokens.
    primary_color: Mapped[str] = mapped_column(String, nullable=False, default="#4f46e5")
    accent_color: Mapped[str] = mapped_column(String, nullable=False, default="#0ea5e9")
    # When true, the app name is shown as the header wordmark; otherwise the header
    # keeps the default brand mark. A custom uploaded logo overrides both.
    name_in_header: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # Bumped every time branding changes — handy for cache-busting on the client.
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
