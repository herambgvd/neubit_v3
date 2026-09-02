"""Motion-search request/response schemas (pydantic v2, G4).

  * ``Region``               — one NORMALIZED (0..1) rectangle {x,y,w,h}.
  * ``MotionSearchStartBody``— POST body: the [from, to] window + region(s) + sensitivity.
  * ``MotionHit``            — one hit interval {start, end, score} (absolute times).
  * ``MotionSearchJobPublic``— the job view: id + status + progress + hits + note + error.

Region coords are NORMALIZED to 0..1 of the frame (resolution-independent) — the worker
scales them to pixels per segment via ffmpeg's ``iw``/``ih``. Documented so the frontend
sends the drawn rect divided by the reference-frame dimensions.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Region(BaseModel):
    """A drawn rectangle NORMALIZED to 0..1 of the frame (x,y = top-left; w,h = size)."""

    model_config = ConfigDict(extra="forbid")
    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    w: float = Field(gt=0.0, le=1.0)
    h: float = Field(gt=0.0, le=1.0)

    @model_validator(mode="after")
    def _in_bounds(self) -> "Region":
        # A rect must stay within the frame (x+w<=1, y+h<=1) — reject an off-frame draw.
        if self.x + self.w > 1.0001 or self.y + self.h > 1.0001:
            raise ValueError("region rectangle extends beyond the frame (x+w or y+h > 1)")
        return self


class MotionSearchStartBody(BaseModel):
    """POST /cameras/{id}/motion-search — find motion in the region(s) over [from, to]."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    # ``from`` is a Python keyword → alias.
    from_: datetime = Field(alias="from")
    to: datetime
    # One or more drawn regions; empty = whole frame (a single 0,0,1,1 region). The
    # validator normalizes an empty/missing list to the whole-frame region — ``validate_default``
    # makes it fire even when the caller omits ``regions`` entirely.
    regions: list[Region] = Field(default_factory=list, max_length=16, validate_default=True)
    # 0..1 sensitivity (higher = more sensitive). Maps to the ffmpeg scene threshold.
    sensitivity: float = Field(default=0.5, ge=0.0, le=1.0)
    # Analysis fps (server caps it); higher = finer time resolution but slower.
    sample_fps: float = Field(default=4.0, gt=0.0, le=15.0)

    @field_validator("regions")
    @classmethod
    def _default_whole_frame(cls, v: list[Region]) -> list[Region]:
        return v or [Region(x=0.0, y=0.0, w=1.0, h=1.0)]


class MotionHit(BaseModel):
    """One hit interval — [start, end] absolute times + a peak motion score (0..1)."""

    model_config = ConfigDict(extra="ignore")
    start: datetime
    end: datetime
    score: float


class MotionSearchJobPublic(BaseModel):
    """A motion-search job's status/result view (hits plotted on the timeline)."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    job_id: str
    camera_id: str
    status: str  # queued | running | done | failed
    progress: int = 0  # 0..100
    from_: datetime = Field(serialization_alias="from")
    to: datetime
    regions: list[Region] = Field(default_factory=list)
    sensitivity: float = 0.5
    hits: list[MotionHit] = Field(default_factory=list)
    note: Optional[str] = None
    error: Optional[str] = None
    created_at: datetime
    finished_at: Optional[datetime] = None

    @classmethod
    def from_row(cls, row) -> "MotionSearchJobPublic":
        return cls.model_validate(
            {
                "job_id": row.id,
                "camera_id": row.camera_id,
                "status": row.status,
                "progress": int(row.progress or 0),
                "from": row.from_time,
                "to": row.to_time,
                "regions": row.regions or [],
                "sensitivity": row.sensitivity,
                "hits": row.hits or [],
                "note": row.note,
                "error": row.error,
                "created_at": row.created_at,
                "finished_at": row.finished_at,
            }
        )
