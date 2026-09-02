"""Evidence-lock domain schemas (G3) — create / public / list / check models."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


class EvidenceLockCreate(BaseModel):
    """POST /vms/evidence — lock a camera + time-range from retention auto-deletion."""

    model_config = ConfigDict(extra="forbid")
    camera_id: str = Field(min_length=1, max_length=36)
    start_ts: datetime
    end_ts: datetime
    reason: Optional[str] = Field(default=None, max_length=2000)
    case_ref: Optional[str] = Field(default=None, max_length=255)

    @model_validator(mode="after")
    def _check_range(self) -> "EvidenceLockCreate":
        if self.end_ts <= self.start_ts:
            raise ValueError("end_ts must be after start_ts")
        return self


class EvidenceLockPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    camera_id: str
    start_ts: datetime
    end_ts: datetime
    reason: Optional[str] = None
    case_ref: Optional[str] = None
    is_active: bool
    created_by: Optional[str] = None
    created_at: datetime
    released_by: Optional[str] = None
    released_at: Optional[datetime] = None

    @classmethod
    def from_row(cls, row) -> "EvidenceLockPublic":
        return cls(
            id=row.id,
            camera_id=row.camera_id,
            start_ts=row.start_ts,
            end_ts=row.end_ts,
            reason=row.reason,
            case_ref=row.case_ref,
            is_active=row.is_active,
            created_by=row.created_by,
            created_at=row.created_at,
            released_by=row.released_by,
            released_at=row.released_at,
        )


class EvidenceLockListResponse(BaseModel):
    items: list[EvidenceLockPublic]
    total: int


class EvidenceCheckResult(BaseModel):
    """GET /vms/evidence/check — is this camera+point/range under an active hold?"""

    camera_id: str
    locked: bool
