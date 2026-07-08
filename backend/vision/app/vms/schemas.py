"""VMS control-plane request/response schemas (pydantic v2).

These are the frozen OpenAPI contract the web + mobile + desktop clients build
against (P1 plan §Contracts). Every entity gets Create / Update / Public shapes.

Rules honoured:
  * Encrypted credentials (ONVIF/NVR passwords) are WRITE-ONLY — accepted on
    Create/Update as plaintext, NEVER serialized back. Public shapes expose only a
    ``has_credentials`` / ``has_password`` boolean.
  * Tenant scope is enforced server-side, not in the payload — ``tenant_id`` is not
    a client-supplied field.
  * String literals (status/mode/connection_type/...) mirror the plain-string model
    columns — represented here as typed ``Literal`` unions for a clean OpenAPI.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

# ── Shared literals (match the plain-string model columns) ──────────────────────

CameraStatus = Literal["online", "offline", "connecting", "error"]
ConnectionType = Literal["rtsp", "onvif", "nvr_channel"]
RecordingMode = Literal["continuous", "schedule", "motion", "manual"]
ProfileName = Literal["main", "sub", "third"]
NvrStatus = Literal["online", "offline", "connecting", "error", "unknown"]
NodeStatus = Literal["online", "offline", "draining", "error", "unknown"]
AclSubjectType = Literal["role", "user", "group"]
AclTargetType = Literal["camera", "group"]
AclPrivilege = Literal["view_live", "playback", "export", "ptz", "config"]


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


class AdvancedConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    privacy_masks: list[dict[str, Any]] = Field(default_factory=list)
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
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row, profiles: Optional[list] = None) -> "CameraPublic":
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
                },
                "advanced": {
                    "privacy_masks": row.privacy_masks or [],
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


# ── NVR ──────────────────────────────────────────────────────────────────────────


class NvrCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=255)
    is_enabled: bool = True
    brand: str = Field(default="onvif", max_length=64)
    driver: Optional[str] = Field(default=None, max_length=64)
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=80, ge=1, le=65535)
    username: str = Field(default="", max_length=255)
    # Plaintext on write; server encrypts. Never serialized back.
    password: Optional[str] = Field(default=None, max_length=1024)
    channel_count: int = Field(default=0, ge=0)


class NvrUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    is_enabled: Optional[bool] = None
    brand: Optional[str] = Field(default=None, max_length=64)
    driver: Optional[str] = Field(default=None, max_length=64)
    host: Optional[str] = Field(default=None, min_length=1, max_length=255)
    port: Optional[int] = Field(default=None, ge=1, le=65535)
    username: Optional[str] = Field(default=None, max_length=255)
    # Provide to rotate the credential; omit to leave unchanged.
    password: Optional[str] = Field(default=None, max_length=1024)
    channel_count: Optional[int] = Field(default=None, ge=0)


class NvrPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str
    is_enabled: bool
    brand: str
    driver: Optional[str] = None
    host: str
    port: int
    username: str
    has_credentials: bool = False
    channel_count: int
    status: str
    storage_info: dict[str, Any] = Field(default_factory=dict)
    capabilities: dict[str, Any] = Field(default_factory=dict)
    last_seen_at: Optional[datetime] = None
    last_error: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "NvrPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "name": row.name,
                "is_enabled": row.is_enabled,
                "brand": row.brand,
                "driver": row.driver,
                "host": row.host,
                "port": row.port,
                "username": row.username,
                "has_credentials": bool(row.enc_creds),
                "channel_count": row.channel_count,
                "status": row.status,
                "storage_info": row.storage_info or {},
                "capabilities": row.capabilities or {},
                "last_seen_at": row.last_seen_at,
                "last_error": row.last_error,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class NvrListResponse(BaseModel):
    items: list[NvrPublic]
    total: int
    skip: int
    limit: int


# ── Camera group ──────────────────────────────────────────────────────────────────


class CameraGroupCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    color: Optional[str] = Field(default=None, max_length=16)
    description: Optional[str] = Field(default=None, max_length=1024)
    camera_ids: list[str] = Field(default_factory=list)


class CameraGroupUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    color: Optional[str] = Field(default=None, max_length=16)
    description: Optional[str] = Field(default=None, max_length=1024)
    camera_ids: Optional[list[str]] = None


class CameraGroupPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str
    color: Optional[str] = None
    description: Optional[str] = None
    camera_ids: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "CameraGroupPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "name": row.name,
                "color": row.color,
                "description": row.description,
                "camera_ids": row.camera_ids or [],
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class CameraGroupListResponse(BaseModel):
    items: list[CameraGroupPublic]
    total: int


# ── Camera ACL ────────────────────────────────────────────────────────────────────


class CameraACLCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    subject_type: AclSubjectType
    subject_id: str = Field(min_length=1, max_length=64)
    target_type: AclTargetType
    target_id: str = Field(min_length=1, max_length=36)
    privileges: list[AclPrivilege] = Field(default_factory=list)


class CameraACLUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    privileges: Optional[list[AclPrivilege]] = None


class CameraACLPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    subject_type: str
    subject_id: str
    target_type: str
    target_id: str
    privileges: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "CameraACLPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "subject_type": row.subject_type,
                "subject_id": row.subject_id,
                "target_type": row.target_type,
                "target_id": row.target_id,
                "privileges": row.privileges or [],
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class CameraACLListResponse(BaseModel):
    items: list[CameraACLPublic]
    total: int


# ── Camera health ─────────────────────────────────────────────────────────────────


class CameraHealthPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    camera_id: str
    status: str
    bitrate_kbps: Optional[int] = None
    fps_actual: Optional[float] = None
    packet_loss: Optional[float] = None
    latency_ms: Optional[int] = None
    captured_at: datetime

    @classmethod
    def from_row(cls, row) -> "CameraHealthPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "camera_id": row.camera_id,
                "status": row.status,
                "bitrate_kbps": row.bitrate_kbps,
                "fps_actual": row.fps_actual,
                "packet_loss": row.packet_loss,
                "latency_ms": row.latency_ms,
                "captured_at": row.captured_at,
            }
        )


class CameraHealthListResponse(BaseModel):
    items: list[CameraHealthPublic]
    total: int
