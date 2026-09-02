"""Video-wall Pattern schemas (pydantic v2).

A Pattern is a rotating sequence shown on a video wall: it cycles through its
``camera_group_ids`` every ``seconds`` seconds (dwell 1..3600). Ported from
neubit_v2's ``PatternDocument`` / ``PatternPublic``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class PatternCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    description: Optional[str] = Field(default=None, max_length=1024)
    camera_group_ids: list[str] = Field(default_factory=list)
    seconds: int = Field(default=10, ge=1, le=3600)
    is_active: bool = True


class PatternUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    description: Optional[str] = Field(default=None, max_length=1024)
    camera_group_ids: Optional[list[str]] = None
    seconds: Optional[int] = Field(default=None, ge=1, le=3600)
    is_active: Optional[bool] = None


class PatternPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str
    description: Optional[str] = None
    camera_group_ids: list[str] = Field(default_factory=list)
    seconds: int
    is_active: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "PatternPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "name": row.name,
                "description": row.description,
                "camera_group_ids": row.camera_group_ids or [],
                "seconds": row.seconds,
                "is_active": row.is_active,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class PatternListResponse(BaseModel):
    items: list[PatternPublic]
    total: int
