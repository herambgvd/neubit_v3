"""Camera control-plane request/response schemas (pydantic v2).

These are the frozen OpenAPI contract the web + mobile + desktop clients build
against (P1 plan §Contracts). Every entity gets Create / Update / Public shapes.

Rules honoured:
  * Encrypted credentials (ONVIF passwords) are WRITE-ONLY — accepted on
    Create/Update as plaintext, NEVER serialized back. Public shapes expose only a
    ``has_password`` boolean.
  * Tenant scope is enforced server-side, not in the payload — ``tenant_id`` is not
    a client-supplied field.
  * String literals (status/mode/connection_type/...) mirror the plain-string model
    columns — represented as typed ``Literal`` unions (from ``common.schemas``) for a
    clean OpenAPI.

Owns the media-profile, network, discovery/onboarding and config-sub-resource shapes
too — the NVR module reuses ``DiscoverResponse`` / ``ChannelsResponse`` / ``CameraPublic``
from here (the allowed cameras ← nvr direction).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.vms.common.schemas import ConnectionType, ProfileName, RecordingMode

# ── Network / media sub-objects ─────────────────────────────────────────────────


class NetworkInfo(BaseModel):
    model_config = ConfigDict(extra="ignore")
    ip: Optional[str] = None
    port: Optional[int] = None
    rtsp_port: Optional[int] = None
    mac: Optional[str] = None


class MediaProfileCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: ProfileName = "main"
    codec: Optional[str] = Field(default=None, max_length=32)
    resolution: Optional[str] = Field(default=None, max_length=32)
    fps: Optional[int] = Field(default=None, ge=1, le=240)
    rtsp_path: Optional[str] = Field(default=None, max_length=512)
    bitrate: Optional[int] = Field(default=None, ge=0)  # kbps


class MediaProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[ProfileName] = None
    codec: Optional[str] = Field(default=None, max_length=32)
    resolution: Optional[str] = Field(default=None, max_length=32)
    fps: Optional[int] = Field(default=None, ge=1, le=240)
    rtsp_path: Optional[str] = Field(default=None, max_length=512)
    bitrate: Optional[int] = Field(default=None, ge=0)


class MediaProfilePublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    camera_id: str
    name: str
    codec: Optional[str] = None
    resolution: Optional[str] = None
    fps: Optional[int] = None
    rtsp_path: Optional[str] = None
    bitrate: Optional[int] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "MediaProfilePublic":
        return cls.model_validate(
            {
                "id": row.id,
                "camera_id": row.camera_id,
                "name": row.name,
                "codec": row.codec,
                "resolution": row.resolution,
                "fps": row.fps,
                "rtsp_path": row.rtsp_path,
                "bitrate": row.bitrate,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


# ── Camera credential / config sub-objects ──────────────────────────────────────


class OnvifConfig(BaseModel):
    """ONVIF connection — ``password`` is WRITE-ONLY (never returned)."""

    model_config = ConfigDict(extra="forbid")
    host: Optional[str] = Field(default=None, max_length=255)
    port: Optional[int] = Field(default=None, ge=1, le=65535)
    user: Optional[str] = Field(default=None, max_length=255)
    # Plaintext on write; server encrypts before storing. Never serialized back.
    password: Optional[str] = Field(default=None, max_length=1024)
    profile_token: Optional[str] = Field(default=None, max_length=255)


class OnvifPublic(BaseModel):
    """ONVIF connection as returned — no password, only ``has_password``."""

    model_config = ConfigDict(extra="ignore")
    host: Optional[str] = None
    port: Optional[int] = None
    user: Optional[str] = None
    has_password: bool = False
    profile_token: Optional[str] = None
    capabilities: dict[str, Any] = Field(default_factory=dict)


class RecordingConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: RecordingMode = "continuous"
    schedule: dict[str, Any] = Field(default_factory=dict)
    fps: Optional[int] = Field(default=None, ge=1, le=240)
    record_substream: bool = False
    retention_days: int = Field(default=30, ge=0, le=3650)
    pre_buffer_seconds: int = Field(default=5, ge=0, le=300)
    post_buffer_seconds: int = Field(default=5, ge=0, le=300)
    anr_enabled: bool = False
    # G6: retain the audio track in the recording when the source carries one
    # (false = record video only). Wired to the nvr via the recording-config
    # contract's ``audio`` field.
    audio_enabled: bool = False


class AdvancedConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # privacy_masks / motion_zones: lists of NORMALIZED (0..1) shapes drawn by the G5
    # draw tool — rects {x,y,w,h} and/or polygons {points:[[x,y],...]}. motion_zones may
    # carry an optional per-zone {sensitivity, threshold}.
    privacy_masks: list[dict[str, Any]] = Field(default_factory=list)
    motion_zones: list[dict[str, Any]] = Field(default_factory=list)
    motion_config: dict[str, Any] = Field(default_factory=dict)
    pos_overlay: dict[str, Any] = Field(default_factory=dict)
    dewarp: dict[str, Any] = Field(default_factory=dict)
    backchannel: dict[str, Any] = Field(default_factory=dict)


class PtzConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    capable: bool = False
    presets: list[dict[str, Any]] = Field(default_factory=list)


class Placement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    site_id: Optional[str] = Field(default=None, max_length=36)
    floor_id: Optional[str] = Field(default=None, max_length=36)
    zone_id: Optional[str] = Field(default=None, max_length=36)


# ── Camera ──────────────────────────────────────────────────────────────────────


class CameraCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    is_enabled: bool = True
    brand: str = Field(default="onvif", max_length=64)
    driver: Optional[str] = Field(default=None, max_length=64)
    connection_type: ConnectionType = "onvif"

    network_info: NetworkInfo = Field(default_factory=NetworkInfo)
    onvif: Optional[OnvifConfig] = None
    recording: RecordingConfig = Field(default_factory=RecordingConfig)
    advanced: AdvancedConfig = Field(default_factory=AdvancedConfig)
    ptz: PtzConfig = Field(default_factory=PtzConfig)
    placement: Placement = Field(default_factory=Placement)

    media_profiles: list[MediaProfileCreate] = Field(default_factory=list)

    nvr_id: Optional[str] = Field(default=None, max_length=36)
    nvr_channel_number: Optional[int] = Field(default=None, ge=0)
    storage_pool_id: Optional[str] = Field(default=None, max_length=36)
    media_node_id: Optional[str] = Field(default=None, max_length=36)
    display_order: int = 0


class CameraUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    is_enabled: Optional[bool] = None
    brand: Optional[str] = Field(default=None, max_length=64)
    driver: Optional[str] = Field(default=None, max_length=64)
    connection_type: Optional[ConnectionType] = None

    network_info: Optional[NetworkInfo] = None
    onvif: Optional[OnvifConfig] = None
    recording: Optional[RecordingConfig] = None
    advanced: Optional[AdvancedConfig] = None
    ptz: Optional[PtzConfig] = None
    placement: Optional[Placement] = None

    nvr_id: Optional[str] = Field(default=None, max_length=36)
    nvr_channel_number: Optional[int] = Field(default=None, ge=0)
    storage_pool_id: Optional[str] = Field(default=None, max_length=36)
    media_node_id: Optional[str] = Field(default=None, max_length=36)
    display_order: Optional[int] = None


class CameraPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    is_enabled: bool
    status: str
    brand: str
    driver: Optional[str] = None
    connection_type: str

    network_info: dict[str, Any] = Field(default_factory=dict)
    onvif: OnvifPublic = Field(default_factory=OnvifPublic)
    recording: RecordingConfig = Field(default_factory=RecordingConfig)
    advanced: AdvancedConfig = Field(default_factory=AdvancedConfig)
    ptz: PtzConfig = Field(default_factory=PtzConfig)
    placement: Placement = Field(default_factory=Placement)

    media_profiles: list[MediaProfilePublic] = Field(default_factory=list)

    nvr_id: Optional[str] = None
    nvr_channel_number: Optional[int] = None
    storage_pool_id: Optional[str] = None
    media_node_id: Optional[str] = None
    display_order: int = 0
    thumbnail_path: Optional[str] = None
    last_seen_at: Optional[datetime] = None
    # G6 two-way audio: whether the device has a detected backchannel (speaker) — the
    # frontend shows a push-to-talk control + hits ``POST /cameras/{id}/talk/session``.
    # Derived from ``onvif_capabilities.backchannel`` (driver-detected at probe time).
    talk_capable: bool = False
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row, profiles: Optional[list] = None) -> "CameraPublic":
        caps = row.onvif_capabilities or {}
        return cls.model_validate(
            {
                "id": row.id,
                "name": row.name,
                "is_enabled": row.is_enabled,
                "status": row.status,
                "brand": row.brand,
                "driver": row.driver,
                "connection_type": row.connection_type,
                "network_info": row.network_info or {},
                "onvif": {
                    "host": row.onvif_host,
                    "port": row.onvif_port,
                    "user": row.onvif_user,
                    "has_password": bool(row.onvif_enc_pass),
                    "profile_token": row.onvif_profile_token,
                    "capabilities": row.onvif_capabilities or {},
                },
                "recording": {
                    "mode": row.recording_mode,
                    "schedule": row.recording_schedule or {},
                    "fps": row.recording_fps,
                    "record_substream": row.record_substream,
                    "retention_days": row.retention_days,
                    "pre_buffer_seconds": row.pre_buffer_seconds,
                    "post_buffer_seconds": row.post_buffer_seconds,
                    "anr_enabled": row.anr_enabled,
                    "audio_enabled": row.audio_enabled,
                },
                "advanced": {
                    "privacy_masks": row.privacy_masks or [],
                    "motion_zones": row.motion_zones or [],
                    "motion_config": row.motion_config or {},
                    "pos_overlay": row.pos_overlay or {},
                    "dewarp": row.dewarp or {},
                    "backchannel": row.backchannel or {},
                },
                "ptz": {
                    "capable": row.ptz_capable,
                    "presets": row.ptz_presets or [],
                },
                "placement": {
                    "site_id": row.site_id,
                    "floor_id": row.floor_id,
                    "zone_id": row.zone_id,
                },
                "media_profiles": [
                    MediaProfilePublic.from_row(p) for p in (profiles or [])
                ],
                "nvr_id": row.nvr_id,
                "nvr_channel_number": row.nvr_channel_number,
                "storage_pool_id": row.storage_pool_id,
                "media_node_id": row.media_node_id,
                "display_order": row.display_order,
                "thumbnail_path": row.thumbnail_path,
                "last_seen_at": row.last_seen_at,
                "talk_capable": bool(caps.get("backchannel")),
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class CameraListResponse(BaseModel):
    items: list[CameraPublic]
    total: int
    skip: int
    limit: int


class CameraReorderItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=36)
    display_order: int = Field(ge=0)


class CameraReorderBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[CameraReorderItem] = Field(default_factory=list)


class CameraBulkBody(BaseModel):
    """Bulk camera action (enable/disable/group/retention/delete; cap 200)."""

    model_config = ConfigDict(extra="forbid")
    camera_ids: list[str] = Field(min_length=1, max_length=200)
    action: Literal["enable", "disable", "group", "retention", "delete"]
    group_id: Optional[str] = Field(default=None, max_length=36)
    retention_days: Optional[int] = Field(default=None, ge=0, le=3650)


# ── Discovery / onboarding request bodies (driver-backed) ─────────────────────────


class DiscoverBody(BaseModel):
    """POST /cameras/onvif/discover — LAN scan (graceful empty if none/unreachable)."""

    model_config = ConfigDict(extra="forbid")
    network: Optional[str] = Field(default=None, max_length=64)  # CIDR (None = auto)
    brand: Optional[str] = Field(default=None, max_length=64)


class DiscoveredPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    ip: str
    port: int = 80
    xaddr: Optional[str] = None
    name: Optional[str] = None
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    firmware: Optional[str] = None
    serial_number: Optional[str] = None
    mac: Optional[str] = None
    brand: str = "onvif"
    auth_required: bool = False


class DiscoverResponse(BaseModel):
    items: list[DiscoveredPublic] = Field(default_factory=list)
    total: int = 0


class ProbeBody(BaseModel):
    """POST /cameras/onvif/probe — reachability + identity + capabilities."""

    model_config = ConfigDict(extra="forbid")
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=80, ge=1, le=65535)
    username: str = Field(default="admin", max_length=255)
    password: str = Field(default="", max_length=1024)
    brand: Optional[str] = Field(default=None, max_length=64)


class ProbeResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    reachable: bool
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    firmware: Optional[str] = None
    serial_number: Optional[str] = None
    hardware_id: Optional[str] = None
    mac: Optional[str] = None
    channel_count: int = 0
    has_ptz: bool = False
    has_imaging: bool = False
    has_events: bool = False
    has_analytics: bool = False
    has_audio: bool = False
    error: Optional[str] = None
    capabilities: dict[str, Any] = Field(default_factory=dict)


class ChannelsBody(BaseModel):
    """POST /cameras/onvif/channels — enumerate NVR/DVR/encoder channels."""

    model_config = ConfigDict(extra="forbid")
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=80, ge=1, le=65535)
    username: str = Field(default="admin", max_length=255)
    password: str = Field(default="", max_length=1024)
    brand: Optional[str] = Field(default=None, max_length=64)


class StreamInfoPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    profile_token: Optional[str] = None
    stream_url: Optional[str] = None
    resolution: Optional[str] = None
    fps: Optional[int] = None
    codec: Optional[str] = None
    bitrate: Optional[int] = None


class ChannelPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    channel: int
    name: str
    source_token: Optional[str] = None
    channel_number: Optional[int] = None
    main: Optional[StreamInfoPublic] = None
    sub: Optional[StreamInfoPublic] = None
    snapshot_url: Optional[str] = None
    ptz_capable: bool = False


class ChannelsResponse(BaseModel):
    items: list[ChannelPublic] = Field(default_factory=list)
    total: int = 0


class SnapshotBody(BaseModel):
    """POST /cameras/onvif/snapshot — grab a single JPEG (502 graceful if none)."""

    model_config = ConfigDict(extra="forbid")
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=80, ge=1, le=65535)
    username: str = Field(default="admin", max_length=255)
    password: str = Field(default="", max_length=1024)
    brand: Optional[str] = Field(default=None, max_length=64)


class BulkAddChannel(BaseModel):
    """One channel spec for POST /cameras/onvif/bulk-add."""

    model_config = ConfigDict(extra="forbid")
    channel_number: Optional[int] = Field(default=None, ge=0)
    name: Optional[str] = Field(default=None, max_length=255)
    profile_token: Optional[str] = Field(default=None, max_length=255)
    nvr_id: Optional[str] = Field(default=None, max_length=36)
    site_id: Optional[str] = Field(default=None, max_length=36)
    floor_id: Optional[str] = Field(default=None, max_length=36)


class BulkAddBody(BaseModel):
    """POST /cameras/onvif/bulk-add — create N cameras (one per channel) in one tx."""

    model_config = ConfigDict(extra="forbid")
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=80, ge=1, le=65535)
    username: str = Field(default="admin", max_length=255)
    password: str = Field(default="", max_length=1024)
    brand: str = Field(default="onvif", max_length=64)
    channels: list[BulkAddChannel] = Field(min_length=1, max_length=200)


# ── Config sub-resource request bodies (driver / local) ───────────────────────────


PtzAction = Literal[
    "continuous", "stop", "relative", "absolute",
    "goto_preset", "set_preset", "delete_preset", "get_presets",
]


class PtzBody(BaseModel):
    """POST /cameras/{id}/ptz — a single PTZ action (driver.ptz)."""

    model_config = ConfigDict(extra="forbid")
    action: PtzAction
    pan: float = 0.0
    tilt: float = 0.0
    zoom: float = 0.0
    speed: float = Field(default=0.5, ge=0.0, le=1.0)
    preset_token: Optional[str] = Field(default=None, max_length=255)
    preset_name: Optional[str] = Field(default=None, max_length=255)
    profile_token: Optional[str] = Field(default=None, max_length=255)


class ImagingBody(BaseModel):
    """PATCH /cameras/{id}/imaging — driver.configure('imaging', ...)."""

    model_config = ConfigDict(extra="allow")


class IoBody(BaseModel):
    """PATCH /cameras/{id}/io — driver.configure('io', ...)."""

    model_config = ConfigDict(extra="allow")


class MotionConfigBody(BaseModel):
    model_config = ConfigDict(extra="allow")


class PrivacyMasksBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    masks: list[dict[str, Any]] = Field(default_factory=list)


class MotionZonesBody(BaseModel):
    """PUT /cameras/{id}/motion-zones — replace the motion-detection regions.

    ``zones`` is a list of NORMALIZED (0..1) shapes: rects ``{x,y,w,h}`` and/or
    polygons ``{points:[[x,y],...]}`` with an optional per-zone ``sensitivity`` /
    ``threshold``. Persisted locally + best-effort pushed to the device.
    """

    model_config = ConfigDict(extra="forbid")
    zones: list[dict[str, Any]] = Field(default_factory=list)


class OnvifEventsBody(BaseModel):
    """PUT /cameras/{id}/onvif-events — persist enabled + topics (ingest at scale = P5)."""

    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    topics: list[str] = Field(default_factory=list)


class ConfigResult(BaseModel):
    """Generic driver/local config result echo."""

    model_config = ConfigDict(extra="allow")


# ── Bulk result ───────────────────────────────────────────────────────────────────


class BulkResult(BaseModel):
    affected: int = 0


class ReorderResult(BaseModel):
    reordered: int = 0


# Camera-health shapes (CameraHealthPublic / CameraHealthListResponse) moved to the
# dedicated ``app.vms.health.schemas`` domain package (reorg) — this domain no longer
# owns them.
