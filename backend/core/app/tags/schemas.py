"""Tags request/response schemas (pydantic).

Color is validated to a 6-digit hex (``#RRGGBB``); name/description length mirror
the neubit_v2 contract (name ≤ 100, description ≤ 500). ``entity_type`` on the
assign/unassign payloads is a free string so new taggable modules need no schema
change here.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

_HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


def _validate_color(v: Optional[str]) -> Optional[str]:
    if v is None:
        return v
    v = v.strip()
    if not _HEX_COLOR_RE.match(v):
        raise ValueError("Color must be a 6-digit hex value (e.g. #3B82F6)")
    return v


def _validate_name(v: Optional[str], *, required: bool) -> Optional[str]:
    if v is None:
        if required:
            raise ValueError("Name is required")
        return None
    v = v.strip()
    if not v:
        raise ValueError("Name cannot be empty")
    if len(v) > 100:
        raise ValueError("Name must be 100 characters or fewer")
    return v


class CreateTagRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=100)
    color: str = "#3B82F6"
    description: Optional[str] = Field(default=None, max_length=500)
    is_active: bool = True

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        return _validate_name(v, required=True) or v

    @field_validator("color")
    @classmethod
    def _color(cls, v: str) -> str:
        return _validate_color(v) or v


class UpdateTagRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    color: Optional[str] = None
    description: Optional[str] = Field(default=None, max_length=500)
    is_active: Optional[bool] = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: Optional[str]) -> Optional[str]:
        return _validate_name(v, required=False)

    @field_validator("color")
    @classmethod
    def _color(cls, v: Optional[str]) -> Optional[str]:
        return _validate_color(v)


class TagAssignRequest(BaseModel):
    """Attach / detach a tag to / from an entity (a site, zone, … )."""

    model_config = ConfigDict(extra="forbid")

    entity_type: str = Field(min_length=1, max_length=64)
    entity_id: str = Field(min_length=1, max_length=64)

    @field_validator("entity_type", "entity_id")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Value cannot be empty")
        return v


class TagPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")

    tag_id: str
    name: str
    color: str
    description: Optional[str] = None
    is_active: bool
    usage_count: int = 0
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row, *, usage_count: int = 0) -> "TagPublic":
        return cls.model_validate(
            {
                "tag_id": row.tag_id,
                "name": row.name,
                "color": row.color,
                "description": row.description,
                "is_active": row.is_active,
                "usage_count": usage_count,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class TagListResponse(BaseModel):
    items: list[TagPublic]
    total: int
    skip: int
    limit: int


class TagLinkPublic(BaseModel):
    """One entity tagged with a tag — used by ``GET /tags/{id}/entities``."""

    model_config = ConfigDict(extra="ignore")

    entity_type: str
    entity_id: str

    @classmethod
    def from_row(cls, row) -> "TagLinkPublic":
        return cls.model_validate(
            {"entity_type": row.entity_type, "entity_id": row.entity_id}
        )
