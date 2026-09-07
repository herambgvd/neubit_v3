"""Media-node registry — tenant-scoped.

A ``MediaNode`` is a MediaMTX/relay worker that fronts live/record streams.

This module once also carried a ``StreamShard`` (camera, profile) → node placement
table, shipped empty in P1 with its assignment logic promised for P2. P2 solved
placement differently — ``Camera.media_node_id`` plus ``app.vms.common.node_routing``
— so the shard table was never read or written by anything. It is deleted; its table
is dropped by ``0030_drop_stream_shards``.
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

    # --- MN-1a: independent recorder-machine routing (Go nvr + MediaMTX bases). ---
    # ``api_url`` is the recorder's Go-nvr base URL (e.g. http://recorder-2:8000) — the
    # KEY routing field: control-plane heartbeat + (later) per-node stream routing target.
    # It is nullable in the DB (already-deployed rows predate it), but REQUIRED on create.
    api_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # MediaMTX media bases the recorder machine exposes (nullable — filled on onboarding).
    hls_base: Mapped[str | None] = mapped_column(String(512), nullable=True)
    webrtc_base: Mapped[str | None] = mapped_column(String(512), nullable=True)
    rtsp_base: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # Human location / region tag (e.g. "Tower-B basement", "us-east").
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Per-node federation credential (Phase-2 trust): the scoped key this node
    # issued to us at enrolment. Presented as X-Node-Credential on estate calls
    # instead of the ambient shared-secret JWT. NULL → fall back to the service JWT.
    credential: Mapped[str | None] = mapped_column(String(128), nullable=True)

    capacity_channels: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("128")
    )
    used_channels: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )

    # online | offline | draining | error | unknown (plain string, no PG enum).
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'unknown'"), index=True
    )
    last_heartbeat: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Why this node's CREDENTIAL is not working, when it is not — set by the
    # heartbeat, cleared the moment a call succeeds.
    #
    # It exists because a stale credential is invisible until somebody uses the one
    # feature it broke. A federation credential freezes the grants it was minted
    # with, so widening the recorder's grant set leaves every existing credential
    # short — and the node stays REACHABLE and reports online the whole time. Without
    # this the estate's node list says "online" while a screen somewhere returns an
    # error, and the two are never connected.
    credential_error: Mapped[str | None] = mapped_column(String(512), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
