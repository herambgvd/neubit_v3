"""Storage domain schemas (P3-B).

Request/response shapes for StoragePool + TierRule CRUD, pool usage, and the
recording integrity/lock/verify operations. Secrets (SMB password, S3 secret key)
are WRITE-ONLY inputs — never echoed back in a public read (only a ``has_secret``
boolean is exposed). Mirrors the camera/recording schema style (plain-string types;
``extra="forbid"`` on request bodies, ``extra="ignore"`` on public reads).
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

PoolType = Literal["local", "nfs", "smb", "s3"]


# ── StoragePool ──────────────────────────────────────────────────────────────
class StoragePoolCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=100)
    pool_type: PoolType = "local"
    path: Optional[str] = Field(default=None, max_length=1024)
    priority: int = Field(default=0, ge=0, le=1000)
    max_size_bytes: Optional[int] = Field(default=None, ge=0)
    is_default: bool = False
    is_active: bool = True

    # NAS (nfs/smb)
    nas_server: Optional[str] = Field(default=None, max_length=255)
    nas_share: Optional[str] = Field(default=None, max_length=255)
    nas_protocol: Optional[Literal["nfs", "smb"]] = None
    nas_username: Optional[str] = Field(default=None, max_length=255)
    nas_password: Optional[str] = None  # write-only → encrypted at rest
    nas_domain: Optional[str] = Field(default=None, max_length=128)
    nas_mount_options: Optional[str] = None

    # S3
    s3_endpoint: Optional[str] = Field(default=None, max_length=512)
    s3_bucket: Optional[str] = Field(default=None, max_length=255)
    s3_region: Optional[str] = Field(default=None, max_length=64)
    s3_access_key: Optional[str] = Field(default=None, max_length=255)
    s3_secret_key: Optional[str] = None  # write-only → encrypted at rest
    s3_use_ssl: bool = True

    # RAID link (optional) — documentary tie from a local pool to a monitored array.
    raid_level: Optional[Literal["raid0", "raid1", "raid5", "raid6", "raid10"]] = None
    raid_device: Optional[str] = Field(default=None, max_length=64)


class StoragePoolUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    path: Optional[str] = Field(default=None, max_length=1024)
    priority: Optional[int] = Field(default=None, ge=0, le=1000)
    max_size_bytes: Optional[int] = Field(default=None, ge=0)
    is_default: Optional[bool] = None
    is_active: Optional[bool] = None

    nas_server: Optional[str] = Field(default=None, max_length=255)
    nas_share: Optional[str] = Field(default=None, max_length=255)
    nas_protocol: Optional[Literal["nfs", "smb"]] = None
    nas_username: Optional[str] = Field(default=None, max_length=255)
    nas_password: Optional[str] = None
    nas_domain: Optional[str] = Field(default=None, max_length=128)
    nas_mount_options: Optional[str] = None

    s3_endpoint: Optional[str] = Field(default=None, max_length=512)
    s3_bucket: Optional[str] = Field(default=None, max_length=255)
    s3_region: Optional[str] = Field(default=None, max_length=64)
    s3_access_key: Optional[str] = Field(default=None, max_length=255)
    s3_secret_key: Optional[str] = None
    s3_use_ssl: Optional[bool] = None

    raid_level: Optional[Literal["raid0", "raid1", "raid5", "raid6", "raid10"]] = None
    raid_device: Optional[str] = Field(default=None, max_length=64)


class StoragePoolPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    pool_type: str
    path: Optional[str] = None
    priority: int
    max_size_bytes: Optional[int] = None
    is_default: bool
    is_active: bool

    nas_server: Optional[str] = None
    nas_share: Optional[str] = None
    nas_protocol: Optional[str] = None
    nas_username: Optional[str] = None
    nas_domain: Optional[str] = None
    mount_state: Optional[str] = None
    last_mount_error: Optional[str] = None
    nas_has_password: bool = False

    s3_endpoint: Optional[str] = None
    s3_bucket: Optional[str] = None
    s3_region: Optional[str] = None
    s3_access_key: Optional[str] = None
    s3_use_ssl: bool = True
    s3_has_secret_key: bool = False

    raid_level: Optional[str] = None
    raid_device: Optional[str] = None

    reachable: Optional[bool] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "StoragePoolPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "name": row.name,
                "pool_type": row.pool_type,
                "path": row.path,
                "priority": row.priority,
                "max_size_bytes": row.max_size_bytes,
                "is_default": row.is_default,
                "is_active": row.is_active,
                "nas_server": row.nas_server,
                "nas_share": row.nas_share,
                "nas_protocol": row.nas_protocol,
                "nas_username": row.nas_username,
                "nas_domain": row.nas_domain,
                "mount_state": row.mount_state,
                "last_mount_error": row.last_mount_error,
                "nas_has_password": bool(row.nas_enc_password),
                "s3_endpoint": row.s3_endpoint,
                "s3_bucket": row.s3_bucket,
                "s3_region": row.s3_region,
                "s3_access_key": row.s3_access_key,
                "s3_use_ssl": row.s3_use_ssl,
                "s3_has_secret_key": bool(row.s3_enc_secret_key),
                "raid_level": row.raid_level,
                "raid_device": row.raid_device,
                "reachable": row.reachable,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class StoragePoolListResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    items: list[StoragePoolPublic]
    total: int


class StoragePoolUsage(BaseModel):
    model_config = ConfigDict(extra="ignore")

    pool_id: str
    pool_type: str
    recording_count: int
    bytes_used: int
    max_size_bytes: Optional[int] = None
    percent_used: Optional[float] = None  # null when capacity is unlimited


# ── TierRule ─────────────────────────────────────────────────────────────────
class TierRuleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=100)
    source_pool_id: str
    target_pool_id: str
    after_age_hours: int = Field(ge=0, le=87600)  # up to 10 years
    enabled: bool = True


class TierRuleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    source_pool_id: Optional[str] = None
    target_pool_id: Optional[str] = None
    after_age_hours: Optional[int] = Field(default=None, ge=0, le=87600)
    enabled: Optional[bool] = None


class TierRulePublic(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    source_pool_id: str
    target_pool_id: str
    after_age_hours: int
    enabled: bool
    last_run_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "TierRulePublic":
        return cls.model_validate(
            {
                "id": row.id,
                "name": row.name,
                "source_pool_id": row.source_pool_id,
                "target_pool_id": row.target_pool_id,
                "after_age_hours": row.after_age_hours,
                "enabled": row.enabled,
                "last_run_at": row.last_run_at,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class TierRuleListResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    items: list[TierRulePublic]
    total: int


# ── recording integrity / lock (response of lock/unlock/verify) ──────────────
class RecordingLockBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: Optional[str] = Field(default=None, max_length=255)


class RecordingIntegrityResult(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    integrity_status: str  # verified | corrupted | missing | unchecked
    checksum: Optional[str] = None
    locked: bool
    locked_by: Optional[str] = None


# ── RAID (software-RAID health monitoring) ───────────────────────────────────
class RaidArrayOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    device: str
    level: str
    state: Optional[str] = None
    health: str  # healthy | degraded | rebuilding | failed | unknown
    working_devices: int
    failed_devices: int
    total_devices: int
    rebuild_status: Optional[str] = None
    rebuild_percent: Optional[int] = None
    first_degraded_at: Optional[datetime] = None
    last_seen_at: Optional[datetime] = None

    @classmethod
    def from_row(cls, row) -> "RaidArrayOut":
        return cls.model_validate(
            {
                "device": row.device,
                "level": row.level,
                "state": row.state,
                "health": row.health,
                "working_devices": row.working_devices,
                "failed_devices": row.failed_devices,
                "total_devices": row.total_devices,
                "rebuild_status": row.rebuild_status,
                "rebuild_percent": row.rebuild_percent,
                "first_degraded_at": row.first_degraded_at,
                "last_seen_at": row.last_seen_at,
            }
        )


class RaidDeviceOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str  # /dev/sdb
    size: str  # human-readable (lsblk SIZE)
    model: str = ""


class RaidStatusResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    available: bool  # False on non-Linux / mdadm-absent hosts
    reason: Optional[str] = None  # why unavailable (shown in UI)
    arrays: list[RaidArrayOut] = []
