"""Camera-group + per-camera ACL schemas (pydantic v2).

Groups are a LOCAL grouping catalog (membership is a JSON id-list on the group row).
The ACL is VMS-owned and keyed on core subject ids (role/user/group) — the typed
subject/target/privilege literals live in ``common.schemas`` (shared with cameras).
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.vms.common.schemas import (
    AclPrivilege,
    AclSubjectType,
    AclTargetType,
    GridLayout,
)

# ── Camera group ──────────────────────────────────────────────────────────────────


class CameraGroupCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    color: Optional[str] = Field(default=None, max_length=16)
    description: Optional[str] = Field(default=None, max_length=1024)
    camera_ids: list[str] = Field(default_factory=list)
    layout: GridLayout = "2x2"
    is_active: bool = True


class CameraGroupUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    color: Optional[str] = Field(default=None, max_length=16)
    description: Optional[str] = Field(default=None, max_length=1024)
    camera_ids: Optional[list[str]] = None
    layout: Optional[GridLayout] = None
    is_active: Optional[bool] = None


class CameraGroupPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str
    color: Optional[str] = None
    description: Optional[str] = None
    camera_ids: list[str] = Field(default_factory=list)
    layout: GridLayout = "2x2"
    is_active: bool = True
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
                "layout": row.layout or "2x2",
                "is_active": row.is_active if row.is_active is not None else True,
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


# ── ACL PUT body ──────────────────────────────────────────────────────────────────


class CameraACLEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    subject_type: AclSubjectType
    subject_id: str = Field(min_length=1, max_length=64)
    privileges: list[AclPrivilege] = Field(default_factory=list)


class CameraACLPutBody(BaseModel):
    """PUT /cameras/{id}/acl — replace the per-camera ACL wholesale."""

    model_config = ConfigDict(extra="forbid")
    entries: list[CameraACLEntry] = Field(default_factory=list, max_length=500)
