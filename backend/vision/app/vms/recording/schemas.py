"""Recording domain schemas (P3-A).

Request/response shapes for the recording-config PUT, manual start/stop, and the
recordings browse list. Mirrors the camera-domain schema style (plain-string
modes; ``extra="forbid"`` on request bodies, ``extra="ignore"`` on public reads).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

RecordingMode = Literal["continuous", "schedule", "motion", "event", "manual"]
TriggerType = Literal["continuous", "schedule", "motion", "event", "manual"]


class RecordingConfigBody(BaseModel):
    """PUT /cameras/{id}/recording — set the per-camera recording policy.

    ``schedule`` is a weekly-window map, e.g.::

        {"mon": [{"start": "08:00", "end": "18:00"}], "tue": [...], ...}

    Days are lower-case 3-letter keys (mon..sun); windows are HH:MM 24h local (the
    scheduler compares against the server clock). An empty list / missing day = no
    recording that day (for ``schedule`` mode).
    """

    model_config = ConfigDict(extra="forbid")

    mode: RecordingMode = "continuous"
    schedule: dict[str, Any] = Field(default_factory=dict)
    retention_days: int = Field(default=30, ge=0, le=3650)
    record_substream: bool = False
    # G6: retain the audio track in the recording when the source carries one
    # (false = record video only). Passed to the nvr on start-recording.
    audio_enabled: bool = False
    # Per-camera storage pool (enterprise VMS): which storage pool this camera's
    # recordings land on. None = the default recordings volume. Sent as the nvr
    # record_dir on start so segments physically land on the pool's path.
    storage_pool_id: Optional[str] = None


class RecordingConfigPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")

    camera_id: str
    mode: str
    schedule: dict[str, Any]
    retention_days: int
    record_substream: bool
    audio_enabled: bool = False
    storage_pool_id: Optional[str] = None
    # Whether the nvr is recording this camera right now (best-effort; may be
    # stale if the nvr is unreachable — the field is advisory).
    recording_now: bool = False


class RecordingControlResult(BaseModel):
    """Manual start/stop result."""

    model_config = ConfigDict(extra="ignore")

    camera_id: str
    profile: str
    recording: bool
    trigger_type: Optional[str] = None


class RecordingPublic(BaseModel):
    """One recorded segment (browse list / detail)."""

    model_config = ConfigDict(extra="ignore")

    id: str
    camera_id: str
    profile: str
    path: str
    start_time: datetime
    end_time: Optional[datetime] = None
    duration: Optional[float] = None
    file_size: Optional[int] = None
    codec: Optional[str] = None
    resolution: Optional[str] = None
    trigger_type: str
    storage_pool_id: Optional[str] = None
    checksum: Optional[str] = None
    integrity_status: str
    locked: bool
    locked_by: Optional[str] = None
    has_motion: bool
    event_markers: list = Field(default_factory=list)
    created_at: datetime

    @classmethod
    def from_row(cls, row) -> "RecordingPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "camera_id": row.camera_id,
                "profile": row.profile,
                "path": row.path,
                "start_time": row.start_time,
                "end_time": row.end_time,
                "duration": row.duration,
                "file_size": row.file_size,
                "codec": row.codec,
                "resolution": row.resolution,
                "trigger_type": row.trigger_type,
                "storage_pool_id": row.storage_pool_id,
                "checksum": row.checksum,
                "integrity_status": row.integrity_status,
                "locked": row.locked,
                "locked_by": row.locked_by,
                "has_motion": row.has_motion,
                "event_markers": row.event_markers or [],
                "created_at": row.created_at,
            }
        )


class RecordingListResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    items: list[RecordingPublic]
    total: int
    skip: int
    limit: int
