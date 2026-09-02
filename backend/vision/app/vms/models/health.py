"""Camera health samples — tenant-scoped, time-series (retention-purged later).

One row per health sample per camera. P1 fills ``status`` + reachability from the
``vision`` sampler; richer stream metrics (bitrate/fps/packet-loss/latency) come
from the Go ``nvr`` + MediaMTX in P2. Indexed on (camera_id, captured_at) for the
history query; a retention purge (drop rows older than N days) lands with the
sampler.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from ._common import _utcnow, _uuid_str


class CameraHealth(Base):
    """A single camera health sample (time-series, retention-purged)."""

    __tablename__ = "camera_health"
    __table_args__ = (
        Index("ix_camera_health_camera_captured", "camera_id", "captured_at"),
        Index("ix_camera_health_tenant_captured", "tenant_id", "captured_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: mirrors the owning camera's tenant. ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    camera_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("cameras.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # online | offline | connecting | error (plain string, no PG enum).
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'unknown'")
    )
    bitrate_kbps: Mapped[int | None] = mapped_column(Integer)
    fps_actual: Mapped[float | None] = mapped_column(Float)
    packet_loss: Mapped[float | None] = mapped_column(Float)  # 0.0..1.0 fraction
    latency_ms: Mapped[int | None] = mapped_column(Integer)

    captured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, index=True
    )
