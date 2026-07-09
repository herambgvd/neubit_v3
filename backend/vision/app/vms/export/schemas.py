"""Clip-export request/response schemas (pydantic v2, P4-B).

  * ``ExportStartBody``  — POST body: the [from, to] window + optional format (mp4).
  * ``ExportJobPublic``  — the job view: id + status + window + file_size + error +
    timestamps. The produced clip is streamed by ``GET /export/{id}/download`` (the
    absolute ``file_path`` is server-internal and never serialized to the client).
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class ExportStartBody(BaseModel):
    """POST /cameras/{id}/export — export the recorded [from, to] window to a clip."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    # ``from`` is a Python keyword → alias.
    from_: datetime = Field(alias="from")
    to: datetime
    # mp4 is the only container in P4-B; kept as a field for forward-compat.
    format: str = Field(default="mp4", max_length=8)


class ExportJobPublic(BaseModel):
    """An export job's status/result view (the file itself is streamed via /download)."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    job_id: str
    camera_id: str
    status: str  # queued | running | done | failed
    format: str = "mp4"
    from_: datetime = Field(serialization_alias="from")
    to: datetime
    file_size: Optional[int] = None
    error: Optional[str] = None
    created_at: datetime
    finished_at: Optional[datetime] = None

    @classmethod
    def from_row(cls, row) -> "ExportJobPublic":
        return cls.model_validate(
            {
                "job_id": row.id,
                "camera_id": row.camera_id,
                "status": row.status,
                "format": row.format,
                "from": row.from_time,
                "to": row.to_time,
                "file_size": row.file_size,
                "error": row.error,
                "created_at": row.created_at,
                "finished_at": row.finished_at,
            }
        )
