"""VMS events domain schemas (P5-A).

Response shapes for the camera device-events feed (list / per-camera list) + the ack
result. Mirrors the recording-domain schema style (``extra="ignore"`` on public
reads; plain-string type/severity).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class VmsEventPublic(BaseModel):
    """One normalized camera device / system event (feed list / detail)."""

    model_config = ConfigDict(extra="ignore")

    id: str
    camera_id: Optional[str] = None
    event_type: str
    severity: str
    source: str
    title: str
    description: Optional[str] = None
    raw: dict[str, Any] = Field(default_factory=dict)
    occurred_at: datetime
    published: bool
    acknowledged: bool
    acknowledged_by: Optional[str] = None
    acknowledged_at: Optional[datetime] = None
    snapshot_path: Optional[str] = None
    recording_id: Optional[str] = None
    created_at: datetime

    @classmethod
    def from_row(cls, row) -> "VmsEventPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "camera_id": row.camera_id,
                "event_type": row.event_type,
                "severity": row.severity,
                "source": row.source,
                "title": row.title,
                "description": row.description,
                "raw": row.raw or {},
                "occurred_at": row.occurred_at,
                "published": row.published,
                "acknowledged": row.acknowledged,
                "acknowledged_by": row.acknowledged_by,
                "acknowledged_at": row.acknowledged_at,
                "snapshot_path": row.snapshot_path,
                "recording_id": row.recording_id,
                "created_at": row.created_at,
            }
        )


class VmsEventListResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    items: list[VmsEventPublic]
    total: int
    skip: int
    limit: int
