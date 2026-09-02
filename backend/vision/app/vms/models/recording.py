"""Recording metadata — one row per finalized recording segment, tenant-scoped.

vision persists a ``Recording`` when the Go ``nvr`` data-plane emits a
``tenant.<id>.vms.recording.segment`` event (a MediaMTX fmp4 segment finalized on
disk). The nvr owns the muxing + the segment ledger; vision owns the durable,
queryable metadata (browse / playback-index / retention policy).

Ported (control-plane subset) from ``gvd_nvr`` ``recordings/models.py`` adapted to
the v3 tenant-scoped ORM conventions (nullable ``tenant_id``; plain-string
trigger/integrity — NO PG enum). Time-partition-friendly index (camera_id,
start_time) for the playback timeline scans P4 will run.

P3-B adds the pool/tiering/retention/integrity LOGIC; the columns are here from day
1 (build-once): ``storage_pool_id`` / ``checksum`` / ``integrity_status`` are
nullable and unfilled until then.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    String,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from ._common import _utcnow, _uuid_str


class Recording(Base):
    """A recorded segment (one fmp4 file), tenant-scoped."""

    __tablename__ = "recordings"
    __table_args__ = (
        # The playback timeline scans by camera + time window (P4) — the primary
        # access path. A second index by tenant+start supports estate-wide browse.
        Index("ix_recordings_camera_start", "camera_id", "start_time"),
        Index("ix_recordings_tenant_start", "tenant_id", "start_time"),
        Index("ix_recordings_trigger", "trigger_type"),
        # Dedupe key: the nvr already dedupes by path, but a unique index makes the
        # consumer's insert idempotent even under at-least-once NATS redelivery.
        Index("ix_recordings_path", "path", unique=True),
        # Footage-locality: playback routes by the RECORDING's node (the machine that
        # holds the file), so this is scanned when resolving old footage after reassign.
        Index("ix_recordings_media_node_id", "media_node_id"),
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
    # main | sub | third (which MediaProfile this segment recorded).
    profile: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'main'")
    )

    # Absolute segment file path (the nvr-side record path). Unique → dedupe.
    path: Mapped[str] = mapped_column(String(1024), nullable=False)

    start_time: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    end_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    duration: Mapped[float | None] = mapped_column(Float)  # seconds
    file_size: Mapped[int | None] = mapped_column(BigInteger)  # bytes

    codec: Mapped[str | None] = mapped_column(String(32))
    resolution: Mapped[str | None] = mapped_column(String(32))  # e.g. "1920x1080"

    # continuous | schedule | motion | event | manual (plain string, no PG enum).
    trigger_type: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'continuous'")
    )

    # --- Footage locality: the recorder node (MediaNode) that produced this segment. ---
    # The file physically lives on THIS node's disk. Playback/export route by this id (the
    # node holding the footage), NOT the camera's CURRENT media_node_id — so old footage
    # stays reachable after a camera is reassigned to a different recorder machine. NULL =
    # single-node deployment / pre-locality row → fall back to the camera's node / global
    # VE_NVR_URL (back-compat). Indexed in __table_args__.
    media_node_id: Mapped[str | None] = mapped_column(String(36))

    # --- Storage pool + integrity (P3-B fills these; nullable from day 1). ---
    storage_pool_id: Mapped[str | None] = mapped_column(String(36), index=True)
    checksum: Mapped[str | None] = mapped_column(String(64))  # SHA-256 hex (P3-B)
    # verified | corrupted | unchecked | missing_file (P3-B). Default unchecked.
    integrity_status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'unchecked'")
    )

    # --- Evidence lock (a locked recording is retention-exempt, P3-B). ---
    locked: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), index=True
    )
    locked_by: Mapped[str | None] = mapped_column(String(64))
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # --- Motion / event markers (P5 fills; present from day 1). ---
    has_motion: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    # [{"type": "motion", "offset_seconds": 45.2}, ...]
    event_markers: Mapped[list] = mapped_column(
        JSON, nullable=False, server_default=text("'[]'")
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
