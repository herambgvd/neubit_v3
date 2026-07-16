"""Broadcast ORM model — scheduled, targeted platform announcements."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from ..db.base import Base

BROADCAST_SEVERITIES = ("info", "warning", "critical")
BROADCAST_TARGETS = ("all", "tenants")


class Broadcast(Base):
    """One announcement pushed from the platform to tenant consoles."""

    __tablename__ = "broadcasts"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String, nullable=False)
    body: Mapped[str] = mapped_column(String, nullable=False, default="")
    # "info" | "warning" | "critical".
    severity: Mapped[str] = mapped_column(
        String, nullable=False, default="info", server_default=text("'info'")
    )
    # "all" (every tenant) | "tenants" (only target_tenant_ids).
    target_type: Mapped[str] = mapped_column(
        String, nullable=False, default="all", server_default=text("'all'")
    )
    # List of tenant id strings when target_type == "tenants".
    target_tenant_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # Optional schedule window (NULL = open-ended on that side).
    starts_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
