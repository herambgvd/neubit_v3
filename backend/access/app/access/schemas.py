"""Access-control request/response schemas (pydantic)."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Brand(str, Enum):
    DDS = "dds"


class AuthType(str, Enum):
    BASIC = "basic"
    JWT = "jwt"


# ── Instance ────────────────────────────────────────────────────────


class InstanceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    base_url: str = Field(min_length=1, max_length=512)
    brand: Brand = Brand.DDS
    auth_type: AuthType = AuthType.BASIC
    username: str = Field(default="", max_length=255)
    # Plaintext on create; server encrypts (reversibly) before storing.
    secret: Optional[str] = Field(default=None, max_length=1024)
    verify_tls: bool = False
    site_id: Optional[str] = Field(default=None, max_length=36)
    is_active: bool = True
    reconciler_cron: Optional[str] = Field(default="0 3 * * *", max_length=64)

    @field_validator("base_url")
    @classmethod
    def _url(cls, v: str) -> str:
        v = v.strip().rstrip("/")
        if not (v.startswith("http://") or v.startswith("https://")):
            raise ValueError("base_url must start with http:// or https://")
        return v


class InstanceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    base_url: Optional[str] = Field(default=None, min_length=1, max_length=512)
    auth_type: Optional[AuthType] = None
    username: Optional[str] = Field(default=None, max_length=255)
    # Provide to rotate the secret; omit to leave unchanged.
    secret: Optional[str] = Field(default=None, max_length=1024)
    verify_tls: Optional[bool] = None
    site_id: Optional[str] = Field(default=None, max_length=36)
    is_active: Optional[bool] = None
    reconciler_cron: Optional[str] = Field(default=None, max_length=64)

    @field_validator("base_url")
    @classmethod
    def _url(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = v.strip().rstrip("/")
        if not (v.startswith("http://") or v.startswith("https://")):
            raise ValueError("base_url must start with http:// or https://")
        return v


class InstancePublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str
    brand: str
    base_url: str
    auth_type: str
    username: str
    has_secret: bool = False
    verify_tls: bool
    status: str
    is_active: bool
    site_id: Optional[str] = None
    last_connected_at: Optional[datetime] = None
    last_sync_at: Optional[datetime] = None
    last_error: Optional[str] = None
    reconciler_cron: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "InstancePublic":
        return cls.model_validate(
            {
                "id": row.id,
                "name": row.name,
                "brand": row.brand,
                "base_url": row.base_url,
                "auth_type": row.auth_type,
                "username": row.username,
                "has_secret": bool(row.secret_enc),
                "verify_tls": row.verify_tls,
                "status": row.status,
                "is_active": row.is_active,
                "site_id": row.site_id,
                "last_connected_at": row.last_connected_at,
                "last_sync_at": row.last_sync_at,
                "last_error": row.last_error,
                "reconciler_cron": row.reconciler_cron,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class InstanceListResponse(BaseModel):
    items: list[InstancePublic]
    total: int
    skip: int
    limit: int


# ── Test connection ─────────────────────────────────────────────────


class TestConnectionResponse(BaseModel):
    ok: bool
    detail: dict[str, Any] = Field(default_factory=dict)
    error: Optional[str] = None


# ── Reconcile / sync jobs ───────────────────────────────────────────


class SyncJobPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    instance_id: str
    kind: str
    status: str
    trigger: str
    created_count: int
    updated_count: int
    deleted_count: int
    error_count: int
    counts: dict[str, Any] = Field(default_factory=dict)
    errors: list[Any] = Field(default_factory=list)
    error: Optional[str] = None
    started_at: datetime
    finished_at: Optional[datetime] = None

    @classmethod
    def from_row(cls, row) -> "SyncJobPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "instance_id": row.instance_id,
                "kind": row.kind,
                "status": row.status,
                "trigger": row.trigger,
                "created_count": row.created_count,
                "updated_count": row.updated_count,
                "deleted_count": row.deleted_count,
                "error_count": row.error_count,
                "counts": row.counts or {},
                "errors": row.errors or [],
                "error": row.error,
                "started_at": row.started_at,
                "finished_at": row.finished_at,
            }
        )


class SyncJobListResponse(BaseModel):
    items: list[SyncJobPublic]
    total: int


# ── Mirror listing ──────────────────────────────────────────────────


class MirrorRow(BaseModel):
    """A mirror entry: the verbatim DTO + mirror metadata."""

    model_config = ConfigDict(extra="ignore")
    id: str
    instance_id: str
    collection: str
    remote_uid: Optional[str] = None
    dto: dict[str, Any] = Field(default_factory=dict)
    last_synced_at: datetime

    @classmethod
    def from_row(cls, row) -> "MirrorRow":
        return cls.model_validate(
            {
                "id": row.id,
                "instance_id": row.instance_id,
                "collection": row.collection,
                "remote_uid": row.remote_uid,
                "dto": row.dto or {},
                "last_synced_at": row.last_synced_at,
            }
        )


class MirrorListResponse(BaseModel):
    items: list[MirrorRow]
    total: int
    skip: int
    limit: int


# ── Events ──────────────────────────────────────────────────────────


class AccessEventPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    instance_id: str
    category: str
    event_type: str
    result: str
    remote_uid: Optional[str] = None
    door_ref: Optional[str] = None
    cardholder_ref: Optional[str] = None
    site_id: Optional[str] = None
    raw: dict[str, Any] = Field(default_factory=dict)
    occurred_at: datetime

    @classmethod
    def from_row(cls, row) -> "AccessEventPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "instance_id": row.instance_id,
                "category": row.category,
                "event_type": row.event_type,
                "result": row.result,
                "remote_uid": row.remote_uid,
                "door_ref": row.door_ref,
                "cardholder_ref": row.cardholder_ref,
                "site_id": row.site_id,
                "raw": row.raw or {},
                "occurred_at": row.occurred_at,
            }
        )


class AccessEventListResponse(BaseModel):
    items: list[AccessEventPublic]
    total: int
    skip: int
    limit: int


# ── Doors ───────────────────────────────────────────────────────────


class DoorCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    instance_id: str = Field(min_length=1, max_length=36)
    name: str = Field(min_length=1, max_length=255)
    remote_ref: Optional[str] = Field(default=None, max_length=128)
    site_id: Optional[str] = Field(default=None, max_length=36)
    floor_id: Optional[str] = Field(default=None, max_length=36)
    zone_id: Optional[str] = Field(default=None, max_length=36)
    is_active: bool = True
    metadata: dict[str, Any] = Field(default_factory=dict)


class DoorUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    remote_ref: Optional[str] = Field(default=None, max_length=128)
    site_id: Optional[str] = Field(default=None, max_length=36)
    floor_id: Optional[str] = Field(default=None, max_length=36)
    zone_id: Optional[str] = Field(default=None, max_length=36)
    is_active: Optional[bool] = None
    metadata: Optional[dict[str, Any]] = None


class DoorPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    instance_id: str
    name: str
    remote_ref: Optional[str] = None
    site_id: Optional[str] = None
    floor_id: Optional[str] = None
    zone_id: Optional[str] = None
    is_active: bool
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "DoorPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "instance_id": row.instance_id,
                "name": row.name,
                "remote_ref": row.remote_ref,
                "site_id": row.site_id,
                "floor_id": row.floor_id,
                "zone_id": row.zone_id,
                "is_active": row.is_active,
                "metadata": row.metadata_json or {},
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class DoorListResponse(BaseModel):
    items: list[DoorPublic]
    total: int
    skip: int
    limit: int


# ── Write-through request bodies (cardholders / cards / groups / schedules) ──


class CardholderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, max_length=200)
    first_name: Optional[str] = Field(default=None, max_length=100)
    last_name: Optional[str] = Field(default=None, max_length=100)
    employee_id: Optional[str] = None
    email: Optional[str] = None
    description: Optional[str] = None
    pin_code: Optional[str] = None
    department_uid: Optional[str] = None
    security_group_uid: Optional[str] = None
    access_groups: list[str] = Field(default_factory=list)
    valid_from: Optional[datetime] = None
    valid_until: Optional[datetime] = None
    is_supervisor: bool = False
    need_escort: bool = False


class CardholderUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    employee_id: Optional[str] = None
    email: Optional[str] = None
    description: Optional[str] = None
    pin_code: Optional[str] = None
    department_uid: Optional[str] = None
    security_group_uid: Optional[str] = None
    access_groups: Optional[list[str]] = None
    valid_from: Optional[datetime] = None
    valid_until: Optional[datetime] = None
    is_supervisor: Optional[bool] = None
    need_escort: Optional[bool] = None


class AssignCardBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    card_id: str = Field(min_length=1, max_length=128)


class AssignGroupBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    access_group_id: str = Field(min_length=1, max_length=128)


class CardCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    card_code: str = Field(min_length=1, max_length=50)
    status: str = "Free"
    card_type: Optional[str] = None
    cardholder_uid: Optional[str] = None
    reader_function_uid: Optional[str] = None
    technology_type: Optional[int] = Field(default=None, ge=0, le=255)
    description: Optional[str] = None


class CardUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    card_code: Optional[str] = Field(default=None, min_length=1, max_length=50)
    status: Optional[str] = None
    card_type: Optional[str] = None
    cardholder_uid: Optional[str] = None
    reader_function_uid: Optional[str] = None
    technology_type: Optional[int] = Field(default=None, ge=0, le=255)
    description: Optional[str] = None


class CardStatusBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # Free | Used | Canceled | Lost | Stolen | Archived (v2 CardStatus)
    status: str = Field(min_length=1, max_length=32)


# ── Local catalogs: access-groups + schedules (v2 access_groups module) ──────
#
# Faithful port of ``neubit_v2/backend/gates/app/module/access_groups`` — a LOCAL
# repository catalog (NOT DDS write-through). Response keys match v2 exactly
# (``group_id`` / ``schedule_id`` / ``door_ids`` / ``windows`` / ``holidays`` /
# ``timezone`` …) so the frontend binds unchanged.


class AccessGroupCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    description: Optional[str] = None
    access_group_type: str = "Door"
    api_key: Optional[str] = Field(default=None, max_length=200)
    door_ids: list[str] = Field(default_factory=list)
    schedule_id: Optional[str] = Field(default=None, max_length=36)


class AccessGroupUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    description: Optional[str] = None
    access_group_type: Optional[str] = None
    api_key: Optional[str] = Field(default=None, max_length=200)
    door_ids: Optional[list[str]] = None
    schedule_id: Optional[str] = Field(default=None, max_length=36)


class AccessGroupPublic(BaseModel):
    """Response shape identical to v2 ``AccessGroupPublic`` (key ``group_id``)."""

    model_config = ConfigDict(extra="ignore")
    group_id: str
    name: str
    description: Optional[str] = None
    access_group_type: str = "Door"
    api_key: Optional[str] = None
    door_ids: list[str] = Field(default_factory=list)
    schedule_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "AccessGroupPublic":
        return cls.model_validate(
            {
                "group_id": row.id,
                "name": row.name,
                "description": row.description,
                "access_group_type": row.access_group_type,
                "api_key": row.api_key,
                "door_ids": row.door_ids or [],
                "schedule_id": row.schedule_id,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class AccessGroupListResponse(BaseModel):
    items: list[AccessGroupPublic]


class TimeWindow(BaseModel):
    """A schedule window (v2 ``TimeWindow``): days 0=Sun..6=Sat + start/end time."""

    model_config = ConfigDict(extra="ignore")
    days: list[int] = Field(default_factory=list)
    start_time: str
    end_time: str


class ScheduleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    description: Optional[str] = None
    timezone: str = "Asia/Kolkata"
    windows: list[TimeWindow] = Field(default_factory=list)
    holidays: list[str] = Field(default_factory=list)


class ScheduleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    description: Optional[str] = None
    timezone: Optional[str] = None
    windows: Optional[list[TimeWindow]] = None
    holidays: Optional[list[str]] = None


class SchedulePublic(BaseModel):
    """Response shape identical to v2 ``SchedulePublic`` (key ``schedule_id``)."""

    model_config = ConfigDict(extra="ignore")
    schedule_id: str
    name: str
    description: Optional[str] = None
    timezone: str
    windows: list[TimeWindow] = Field(default_factory=list)
    holidays: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "SchedulePublic":
        return cls.model_validate(
            {
                "schedule_id": row.id,
                "name": row.name,
                "description": row.description,
                "timezone": row.timezone,
                "windows": row.windows or [],
                "holidays": row.holidays or [],
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class ScheduleListResponse(BaseModel):
    items: list[SchedulePublic]


# ── Command request bodies (v2 commands/routes) ─────────────────────


class OutputTargets(BaseModel):
    model_config = ConfigDict(extra="forbid")
    uids: list[str] = Field(default_factory=list)
    api_keys: list[str] = Field(default_factory=list)
    period: Optional[str] = None  # seconds; "0" = continuous


class ArmBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    arm_type: Optional[str] = None  # ArmForDuration | ArmConstant
    period: Optional[str] = None
    is_minute: Optional[bool] = None


class DisarmBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    disarm_type: Optional[str] = None  # DisarmForDuration | DisarmConstant
    period: Optional[str] = None
    is_minute: Optional[bool] = None
