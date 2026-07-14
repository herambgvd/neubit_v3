"""Playback (live/recorded) viewer session — tenant-scoped.

A ``PlaybackSession`` is the control-plane record of a viewer stream: vision
issues one per ``POST /cameras/{id}/live`` after the Go ``nvr`` provisions the
MediaMTX path. It carries the browser-facing URLs (HLS/WebRTC/RTSP) + a
short-lived signed **media token** (the token Traefik ForwardAuth validates at
``/media/verify`` before proxying MediaMTX, P2-C). The token itself is stateless
(HS256 off the kernel jwt secret) — the row persists a HASH of it (never the raw
token at rest) plus the placement so release/renew can find + tear down the path.

Mirrors v2's ``PlaybackSessionDocument`` (camera_id/kind/mediamtx_path/hls_url/
webrtc_url/rtsp_url/expires_at) adapted to our vision↔nvr split + the v3
tenant-scoped ORM conventions (nullable ``tenant_id``; plain-string ``kind``; no
PG enum). Recorded-playback sessions (P4) reuse this same table (``kind`` +
future window columns), so it's built once here.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    String,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from ._common import _utcnow, _uuid_str


class PlaybackSession(Base):
    """A viewer stream session (live now; recorded in P4) — tenant-scoped."""

    __tablename__ = "playback_sessions"
    __table_args__ = (
        Index("ix_playback_sessions_tenant_camera", "tenant_id", "camera_id"),
        Index("ix_playback_sessions_expires", "expires_at"),
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
    # live | recorded (plain string, no PG enum). P4 recorded reuses this table.
    kind: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'live'")
    )
    # main | sub | third (which MediaProfile this session carries).
    profile: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'sub'")
    )

    # MediaMTX path name + node id (from the nvr ensure response) — needed to
    # release (DELETE the path) on session teardown.
    mediamtx_name: Mapped[str | None] = mapped_column(String(255))
    node: Mapped[str | None] = mapped_column(String(255))

    # Browser-facing URLs (carry ``?token=`` appended at return time).
    hls_url: Mapped[str | None] = mapped_column(String(1024))
    webrtc_url: Mapped[str | None] = mapped_column(String(1024))
    rtsp_url: Mapped[str | None] = mapped_column(String(1024))

    # Recorded-playback window (P4-A): the [from, to] time-range a recorded session
    # plays back. NULL for live sessions. Stored so a recorded session can be
    # re-minted / re-resolved against the same window (and audited).
    window_from: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    window_to: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # SHA-256 hash of the current media token (never the raw token at rest). The
    # token is stateless (JWT) so verification does not need this — it's kept for
    # audit / optional session-table cross-check on the hot path.
    token_hash: Mapped[str | None] = mapped_column(String(64))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    created_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
