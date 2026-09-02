"""Bookmark domain schemas (G3) — create / update / public / list models."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


class BookmarkCreate(BaseModel):
    """POST /vms/bookmarks — mark a moment (point) or a range on a camera timeline.

    ``end_ts`` omitted → a point bookmark; set → a range (must be > ``start_ts``).
    """

    model_config = ConfigDict(extra="forbid")
    camera_id: str = Field(min_length=1, max_length=36)
    start_ts: datetime
    end_ts: Optional[datetime] = None
    title: str = Field(min_length=1, max_length=255)
    note: Optional[str] = Field(default=None, max_length=4000)
    tags: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_range(self) -> "BookmarkCreate":
        if self.end_ts is not None and self.end_ts <= self.start_ts:
            raise ValueError("end_ts must be after start_ts")
        return self


class BookmarkUpdate(BaseModel):
    """PATCH /vms/bookmarks/{id} — edit any subset of the mutable fields."""

    model_config = ConfigDict(extra="forbid")
    start_ts: Optional[datetime] = None
    end_ts: Optional[datetime] = None
    title: Optional[str] = Field(default=None, min_length=1, max_length=255)
    note: Optional[str] = Field(default=None, max_length=4000)
    tags: Optional[list[str]] = None


class BookmarkPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    camera_id: str
    start_ts: datetime
    end_ts: Optional[datetime] = None
    title: str
    note: Optional[str] = None
    tags: list[str]
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "BookmarkPublic":
        return cls(
            id=row.id,
            camera_id=row.camera_id,
            start_ts=row.start_ts,
            end_ts=row.end_ts,
            title=row.title,
            note=row.note,
            tags=list(row.tags or []),
            created_by=row.created_by,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


class BookmarkListResponse(BaseModel):
    items: list[BookmarkPublic]
    total: int
