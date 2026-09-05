"""Threat-level request + response schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from ..core.enums import ThreatLevelValue

# ── Threat level ───────────────────────────────────────────────────────


class SetThreatLevelRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    level: ThreatLevelValue
    reason: Optional[str] = None
    site_id: Optional[str] = None  # None == deployment-wide


class ThreatLevelPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    site_id: Optional[str] = None
    level: str
    reason: Optional[str] = None
    set_by: Optional[str] = None
    set_at: datetime
    history: list[dict] = Field(default_factory=list)

    @classmethod
    def from_row(cls, r) -> "ThreatLevelPublic":
        return cls(
            id=r.id, site_id=r.site_id, level=r.level, reason=r.reason,
            set_by=r.set_by, set_at=r.set_at, history=r.history or [],
        )


