"""Camera master record + media profiles — tenant-scoped, the VMS core entity.

Ported (control-plane subset) from ``gvd_nvr`` camera/settings + neubit_v3 device
conventions. Every enterprise field is present from day 1 (build-once): recording
config, advanced (privacy/motion/POS/dewarp/backchannel), PTZ, floor-plan
placement refs, NVR-channel + storage-pool + media-node linkage. The logic that
fills these arrives in later phases; the schema does NOT churn.

ONVIF/RTSP credentials are stored REVERSIBLY encrypted (``onvif_enc_pass``,
``enc:...``) exactly like the access service's controller secrets. No PG enums —
status / connection_type / recording mode are plain strings.
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
    Integer,
    String,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from ._common import _utcnow, _uuid_str


class Camera(Base):
    """A registered camera (direct RTSP/ONVIF or an NVR channel), tenant-scoped."""

    __tablename__ = "cameras"
    __table_args__ = (
        Index("ix_cameras_tenant_status", "tenant_id", "status"),
        Index("ix_cameras_tenant_name", "tenant_id", "name"),
        Index("ix_cameras_nvr", "nvr_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    is_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true"), index=True
    )
    # online | offline | connecting | error (plain string, no PG enum).
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'offline'"), index=True
    )

    # Brand selects the driver: onvif | hikvision | cpplus | lumina | dahua | ...
    brand: Mapped[str] = mapped_column(
        String(64), nullable=False, server_default=text("'onvif'"), index=True
    )
    # Concrete driver key resolved by the driver factory (defaults to brand).
    driver: Mapped[str | None] = mapped_column(String(64))
    # rtsp | onvif | nvr_channel — how this camera is reached (plain string).
    connection_type: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'onvif'"), index=True
    )

    # --- Network reach (JSON: ip / port / rtsp_port / mac). ---
    network_info: Mapped[dict] = mapped_column(JSON, nullable=False, server_default=text("'{}'"))

    # --- ONVIF connection (columns; password reversibly encrypted). ---
    onvif_host: Mapped[str | None] = mapped_column(String(255))
    onvif_port: Mapped[int | None] = mapped_column(Integer)
    onvif_user: Mapped[str | None] = mapped_column(String(255))
    onvif_enc_pass: Mapped[str | None] = mapped_column(String(1024))
    onvif_profile_token: Mapped[str | None] = mapped_column(String(255))
    # Detected ONVIF capability matrix (Profile S/G/T features, PTZ, imaging, IO).
    onvif_capabilities: Mapped[dict] = mapped_column(
        JSON, nullable=False, server_default=text("'{}'")
    )
    # --- Device-event ingestion (P5-A). ---
    # When true, the event-supervisor opens an ONVIF PullPoint / brand-alarm
    # subscription for this camera and normalizes → persists → publishes each event.
    onvif_events_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), index=True
    )
    # Optional allow-list of NORMALIZED event_types to keep (e.g. ["motion","tamper"]).
    # Empty = accept every mapped type the device reports. UI/logic in P5-C.
    onvif_event_topics: Mapped[list] = mapped_column(
        JSON, nullable=False, server_default=text("'[]'")
    )

    # --- Recording config (mode/schedule/fps/substream/retention/buffers/ANR). ---
    # mode: continuous | schedule | motion | manual (plain string, no PG enum).
    recording_mode: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'continuous'")
    )
    recording_schedule: Mapped[dict] = mapped_column(
        JSON, nullable=False, server_default=text("'{}'")
    )
    recording_fps: Mapped[int | None] = mapped_column(Integer)
    record_substream: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    retention_days: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("30")
    )
    pre_buffer_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("5")
    )
    post_buffer_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("5")
    )
    # ANR = automatic network replenishment (edge-buffer backfill on reconnect).
    anr_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )

    # --- Advanced config (JSON blobs; UI + logic in later phases). ---
    privacy_masks: Mapped[list] = mapped_column(JSON, nullable=False, server_default=text("'[]'"))
    motion_config: Mapped[dict] = mapped_column(JSON, nullable=False, server_default=text("'{}'"))
    pos_overlay: Mapped[dict] = mapped_column(JSON, nullable=False, server_default=text("'{}'"))
    dewarp: Mapped[dict] = mapped_column(JSON, nullable=False, server_default=text("'{}'"))
    backchannel: Mapped[dict] = mapped_column(JSON, nullable=False, server_default=text("'{}'"))

    # --- PTZ. ---
    ptz_capable: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    ptz_presets: Mapped[list] = mapped_column(JSON, nullable=False, server_default=text("'[]'"))

    # --- Floor-plan / map placement refs (nullable; core DevicePlacement owns geo). ---
    site_id: Mapped[str | None] = mapped_column(String(36), index=True)
    floor_id: Mapped[str | None] = mapped_column(String(36))
    zone_id: Mapped[str | None] = mapped_column(String(36))

    # --- NVR-channel linkage (nullable; set when onboarded as an NVR channel). ---
    nvr_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("nvrs.id", ondelete="SET NULL"),
        index=True,
    )
    nvr_channel_number: Mapped[int | None] = mapped_column(Integer)

    # --- Storage pool + media-node placement (nullable; assignment in later phases). ---
    storage_pool_id: Mapped[str | None] = mapped_column(String(36), index=True)
    media_node_id: Mapped[str | None] = mapped_column(String(36), index=True)

    display_order: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0"), index=True
    )
    thumbnail_path: Mapped[str | None] = mapped_column(String(512))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(String(2048))

    created_by: Mapped[str | None] = mapped_column(String(64))
    updated_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class MediaProfile(Base):
    """A camera media stream (main/sub/third) — codec/resolution/fps/rtsp path."""

    __tablename__ = "media_profiles"
    __table_args__ = (
        Index("ix_media_profiles_camera", "camera_id"),
        Index("ix_media_profiles_tenant", "tenant_id"),
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
    # main | sub | third (plain string, no PG enum).
    name: Mapped[str] = mapped_column(String(16), nullable=False, server_default=text("'main'"))
    codec: Mapped[str | None] = mapped_column(String(32))
    resolution: Mapped[str | None] = mapped_column(String(32))  # e.g. "1920x1080"
    fps: Mapped[int | None] = mapped_column(Integer)
    rtsp_path: Mapped[str | None] = mapped_column(String(512))
    bitrate: Mapped[int | None] = mapped_column(Integer)  # kbps

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
