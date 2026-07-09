"""Camera device-event log — one row per normalized device/system event (P5-A).

The event-supervisor opens a subscription per event-enabled camera (ONVIF PullPoint /
brand alarm stream), normalizes each device notification through the driver topic map
into a brand-neutral ``VmsEvent``, dedupes it, persists it, and publishes
``tenant.<id>.vms.camera.<event_type>`` on the NATS spine — the exact subject family
the workflow correlation engine consumes (``tenant.*.vms.>``) to raise SOP incidents.
System events (camera online/offline from the health sampler; recording-error /
storage-low from the P3 workers) also land here as ``source='system'`` rows.

Ported (shape + dedup + topic mapping) from ``gvd_nvr`` ``events/models.py`` +
``onvif_event_service.py``, adapted to the v3 tenant-scoped ORM conventions (nullable
``tenant_id``; NO PG enums — ``event_type`` / ``severity`` / ``source`` are plain
strings). Tenant-scoped; indexed by (camera_id, occurred_at) + (tenant_id,
occurred_at) for the events feed + per-camera timeline scans P5-B/C run.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
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


class VmsEvent(Base):
    """A normalized camera device-event (or a system event), tenant-scoped."""

    __tablename__ = "vms_events"
    __table_args__ = (
        # The events feed scans by camera + time (per-camera timeline) and estate-wide
        # by tenant + time (the Events surface). Both are the primary access paths.
        Index("ix_vms_events_camera_occurred", "camera_id", "occurred_at"),
        Index("ix_vms_events_tenant_occurred", "tenant_id", "occurred_at"),
        Index("ix_vms_events_type", "event_type"),
        Index("ix_vms_events_severity", "severity"),
        Index("ix_vms_events_acknowledged", "acknowledged"),
        # Dedup: the supervisor skips a duplicate within a short window (same
        # camera+type+time-bucket). A unique index makes the insert idempotent even
        # under a racing double-notification / at-least-once redelivery.
        Index("ix_vms_events_dedup", "dedup_key", unique=True),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    # Nullable: a system event (e.g. storage_low) may not be tied to a camera.
    camera_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("cameras.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )

    # motion | tamper | video_loss | camera_online | camera_offline | io_input |
    # line_crossing | zone_intrusion | audio | recording_error | storage_low | system
    # (plain string, no PG enum).
    event_type: Mapped[str] = mapped_column(String(32), nullable=False)
    # info | warning | critical | alarm (plain string, no PG enum).
    severity: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'info'")
    )
    # onvif | brand | system (where this event originated).
    source: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'onvif'")
    )

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024))

    # Verbatim device payload (ONVIF topic + extracted SimpleItems / brand fields).
    raw: Mapped[dict] = mapped_column(JSON, nullable=False, server_default=text("'{}'"))

    # hash(camera_id + event_type + time-bucket) — the dedup grain (unique index).
    dedup_key: Mapped[str] = mapped_column(String(64), nullable=False)

    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )

    # Whether this event was successfully published on the NATS spine.
    published: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )

    # --- Operator acknowledgement. ---
    acknowledged: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    acknowledged_by: Mapped[str | None] = mapped_column(String(64))
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # --- Evidence linkage (P5-B fills; nullable from day 1). ---
    snapshot_path: Mapped[str | None] = mapped_column(String(512))
    recording_id: Mapped[str | None] = mapped_column(String(36), index=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
