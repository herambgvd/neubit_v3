"""Video-wall Patterns — tenant-scoped rotating camera-group sequences.

A ``CameraPattern`` is a rotating sequence shown on a video wall / display: it
cycles through its ``camera_group_ids`` every ``seconds`` seconds (the dwell). Ported
from neubit_v2's ``PatternDocument`` (auxiliary module). ``name`` is unique per tenant;
membership is a flat JSON id-list of camera-group ids (mirrors ``CameraGroup.camera_ids``
— no association table). Plain-string / portable-type columns (no PG enum), present
from day 1 like the rest of the VMS control plane.
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
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from ._common import _utcnow, _uuid_str


class CameraPattern(Base):
    """A rotating video-wall sequence of camera groups (name unique per tenant)."""

    __tablename__ = "camera_patterns"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_camera_patterns_tenant_name"),
        Index("ix_camera_patterns_tenant", "tenant_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024))
    # The ordered camera-group ids this pattern cycles through (flat JSON id-list).
    camera_group_ids: Mapped[list[str]] = mapped_column(
        JSON, nullable=False, server_default=text("'[]'")
    )
    # Dwell time per group in seconds (1..3600); validated at the schema layer.
    seconds: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("10"))
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )

    created_by: Mapped[str | None] = mapped_column(String(64))
    updated_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
