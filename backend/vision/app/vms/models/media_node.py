"""Media-node registry + stream-shard assignment — tenant-scoped.

A ``MediaNode`` is a MediaMTX/relay worker that fronts live/record streams; a
``StreamShard`` records the (camera, profile) → node placement. P1 ships the
REGISTRY only — the sharding/assignment logic (capacity-aware placement, failover)
lands in P2 when live streaming comes online.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
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


class MediaNode(Base):
    """A media-plane worker (MediaMTX/relay) that carries camera streams."""

    __tablename__ = "media_nodes"
    __table_args__ = (
        Index("ix_media_nodes_tenant_status", "tenant_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    host: Mapped[str] = mapped_column(String(255), nullable=False)

    capacity_channels: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    used_channels: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )

    # online | offline | draining | error | unknown (plain string, no PG enum).
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'unknown'"), index=True
    )
    last_heartbeat: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class StreamShard(Base):
    """A (camera, profile) → media-node placement record (registry; logic in P2)."""

    __tablename__ = "stream_shards"
    __table_args__ = (
        Index("ix_stream_shards_tenant_node", "tenant_id", "node_id"),
        Index("ix_stream_shards_camera", "camera_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    camera_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("cameras.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    node_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("media_nodes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # main | sub | third (which MediaProfile stream this shard carries).
    profile: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'main'")
    )
    assigned_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
