"""NVR control-plane request/response schemas (pydantic v2).

The NVR counterpart to the camera schemas. Credentials are WRITE-ONLY (accepted on
Create/Update as plaintext, never serialized back — Public exposes only
``has_credentials``). Tenant scope is server-side.

``MapChannelsResult`` reuses ``CameraPublic`` from the cameras package (channel →
channel-camera mapping) — the allowed cameras ← nvr dependency direction.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.vms.cameras.schemas import CameraPublic

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


# ── NVR discovery / channel-enum / map-channels / health (driver-backed) ──────────


class NvrDiscoverBody(BaseModel):
    """POST /nvrs/discover — LAN scan filtered to NVR-type devices (graceful empty)."""

    model_config = ConfigDict(extra="forbid")
    network: Optional[str] = Field(default=None, max_length=64)  # CIDR (None = auto)
    brand: Optional[str] = Field(default=None, max_length=64)


class NvrChannelsBody(BaseModel):
    """POST /nvrs/channels — enumerate an UNSAVED NVR host's channels before onboard.

    (The saved-NVR variant is ``GET /nvrs/{id}/channels`` which needs no body — it
    reads host/creds off the stored row.)
    """

    model_config = ConfigDict(extra="forbid")
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=80, ge=1, le=65535)
    username: str = Field(default="admin", max_length=255)
    password: str = Field(default="", max_length=1024)
    brand: Optional[str] = Field(default=None, max_length=64)


class MapChannelItem(BaseModel):
    """One channel selected for mapping → a channel-camera. ``add=false`` skips it."""

    model_config = ConfigDict(extra="forbid")
    channel_number: int = Field(ge=0)
    name: Optional[str] = Field(default=None, max_length=255)
    profile_token: Optional[str] = Field(default=None, max_length=255)
    add: bool = True
    site_id: Optional[str] = Field(default=None, max_length=36)
    floor_id: Optional[str] = Field(default=None, max_length=36)


class MapChannelsBody(BaseModel):
    """POST /nvrs/{id}/map-channels — create channel-cameras for the selected channels.

    Idempotent: a channel already mapped (same ``nvr_id`` + ``nvr_channel_number``) is
    skipped, not double-created.
    """

    model_config = ConfigDict(extra="forbid")
    channels: list[MapChannelItem] = Field(min_length=1, max_length=512)


class MapChannelsResult(BaseModel):
    """Result of a map-channels call — created channel-cameras + skipped (idempotent)."""

    created: list[CameraPublic] = Field(default_factory=list)
    created_count: int = 0
    skipped_count: int = 0
    nvr: Optional[NvrPublic] = None


class NvrHealthResponse(BaseModel):
    """GET /nvrs/{id}/health — current reachability + storage/channel snapshot."""

    model_config = ConfigDict(extra="ignore")
    nvr_id: str
    status: str
    is_enabled: bool
    channel_count: int
    mapped_channel_count: int = 0
    storage_info: dict[str, Any] = Field(default_factory=dict)
    capabilities: dict[str, Any] = Field(default_factory=dict)
    last_seen_at: Optional[datetime] = None
    last_error: Optional[str] = None


# ── NVR footage extraction (P4-B — search + playback on the NVR's own storage) ────


class NvrRecordingRange(BaseModel):
    """One recorded time-range the NVR reports for a channel (from the brand driver).

    ``start``/``end`` are the range bounds as the device reports them (ISO-8601 strings —
    brand time forms are normalised by the driver); ``extra`` carries brand-specific bits
    (``track_id`` / ``file_path`` / ``playback_uri``) for the UI / a direct-fetch path.
    """

    model_config = ConfigDict(extra="ignore")
    channel: int
    start: Optional[str] = None
    end: Optional[str] = None
    extra: dict[str, Any] = Field(default_factory=dict)


class NvrRecordingsResponse(BaseModel):
    """GET /nvrs/{id}/channels/{ch}/recordings — the NVR's own recorded ranges."""

    model_config = ConfigDict(extra="ignore")
    nvr_id: str
    channel: int
    items: list[NvrRecordingRange] = Field(default_factory=list)
    total: int = 0
    reachable: bool = True


class NvrPlaybackBody(BaseModel):
    """POST /nvrs/{id}/channels/{ch}/playback — play the NVR's recorded [from,to] stream."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    from_: datetime = Field(alias="from")
    to: datetime


class NvrPlaybackSession(BaseModel):
    """The NVR-footage playback session — a token-gated HLS/WebRTC view of the NVR's
    recorded stream (the NVR's playback RTSP registered as a MediaMTX path), OR the raw
    RTSP playback URI when MediaMTX registration is unavailable (a P4-C server-side proxy
    fallback). ``ready`` mirrors the live session shape."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    nvr_id: str
    channel: int
    kind: str = "nvr_recorded"
    from_: datetime = Field(serialization_alias="from")
    to: datetime
    hls_url: Optional[str] = None
    webrtc_url: Optional[str] = None
    rtsp_url: Optional[str] = None  # the NVR playback RTSP (server-side; no browser token)
    token: Optional[str] = None
    expires_at: Optional[datetime] = None
    ready: bool = False
