"""Report + report-schedule schemas (pydantic v2, P6-B).

  * ``ReportScheduleCreate`` / ``Update`` — CRUD bodies for a recurring report.
  * ``ReportSchedulePublic`` — the schedule view (+ next/last-run audit).
  * ``ReportResponse`` — the ad-hoc JSON report envelope (the computed report dict).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.vms.reports.computations import REPORT_KINDS

_KINDS = set(REPORT_KINDS)
_CADENCES = {"daily", "weekly", "monthly"}
_FORMATS = {"json", "csv", "pdf"}


class ReportScheduleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=150)
    kind: str
    cadence: str = "daily"
    export_format: str = "csv"
    recipients: list[str] = Field(default_factory=list)
    filters: dict[str, Any] = Field(default_factory=dict)
    channel: str = "email"
    enabled: bool = True
    hour_utc: int = Field(default=6, ge=0, le=23)

    def validate_enums(self) -> str | None:
        if self.kind not in _KINDS:
            return f"kind must be one of {sorted(_KINDS)}"
        if self.cadence not in _CADENCES:
            return f"cadence must be one of {sorted(_CADENCES)}"
        if self.export_format not in _FORMATS:
            return f"export_format must be one of {sorted(_FORMATS)}"
        return None


class ReportScheduleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, max_length=150)
    kind: Optional[str] = None
    cadence: Optional[str] = None
    export_format: Optional[str] = None
    recipients: Optional[list[str]] = None
    filters: Optional[dict[str, Any]] = None
    channel: Optional[str] = None
    enabled: Optional[bool] = None
    hour_utc: Optional[int] = Field(default=None, ge=0, le=23)

    def validate_enums(self) -> str | None:
        if self.kind is not None and self.kind not in _KINDS:
            return f"kind must be one of {sorted(_KINDS)}"
        if self.cadence is not None and self.cadence not in _CADENCES:
            return f"cadence must be one of {sorted(_CADENCES)}"
        if self.export_format is not None and self.export_format not in _FORMATS:
            return f"export_format must be one of {sorted(_FORMATS)}"
        return None


class ReportSchedulePublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str
    kind: str
    cadence: str
    export_format: str
    recipients: list[str]
    filters: dict[str, Any]
    channel: str
    enabled: bool
    hour_utc: int
    last_run_at: Optional[datetime] = None
    next_run_at: Optional[datetime] = None
    last_error: Optional[str] = None
    run_count: int = 0
    created_at: datetime

    @classmethod
    def from_row(cls, row) -> "ReportSchedulePublic":
        return cls.model_validate({
            "id": row.id,
            "name": row.name,
            "kind": row.kind,
            "cadence": row.cadence,
            "export_format": row.export_format,
            "recipients": row.recipients or [],
            "filters": row.filters or {},
            "channel": row.channel,
            "enabled": row.enabled,
            "hour_utc": row.hour_utc,
            "last_run_at": row.last_run_at,
            "next_run_at": row.next_run_at,
            "last_error": row.last_error,
            "run_count": row.run_count,
            "created_at": row.created_at,
        })


class ReportScheduleList(BaseModel):
    items: list[ReportSchedulePublic]
    total: int
