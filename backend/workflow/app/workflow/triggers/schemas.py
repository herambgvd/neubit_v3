"""Trigger / alert-format / event-simulator request + response schemas.

The simulator's response models live here, with the two things it simulates: a
dry run reports which TRIGGERS matched, which ALERT FORMAT matched, and what was
skipped and why.

``TransitionCondition`` is imported rather than redeclared: a trigger's condition
and a transition's condition are the SAME ``{field, operator, value}`` triple,
evaluated by the same ``core.matching`` code. A second class of the same shape
would also be a second OpenAPI component, and the frontend reads one.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

from ..core.enums import InstancePriority
from ..sops.schemas import TransitionCondition

# ── Trigger ────────────────────────────────────────────────────────────


class DedupConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")
    strategy: str = "per_event_type"  # per_event_type | per_event_id | per_field
    key_field: Optional[str] = None
    window_seconds: int = 3600


class CreateTriggerRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(min_length=1, max_length=255)
    description: Optional[str] = None
    sop_id: str
    event_source: str = ""
    # Optional — a trigger may match on event_source alone. Empty/None == match any
    # event_type (the correlation engine treats "" as "match any").
    event_type: Optional[str] = None
    conditions: list[TransitionCondition] = Field(default_factory=list)
    dedup: DedupConfig = Field(default_factory=DedupConfig)
    priority: InstancePriority = InstancePriority.MEDIUM
    auto_assign: Optional[dict] = None
    assign_users: list[str] = Field(default_factory=list)
    enabled: bool = True


class UpdateTriggerRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: Optional[str] = Field(default=None, max_length=255)
    description: Optional[str] = None
    sop_id: Optional[str] = None
    event_source: Optional[str] = None
    event_type: Optional[str] = None
    conditions: Optional[list[TransitionCondition]] = None
    dedup: Optional[DedupConfig] = None
    priority: Optional[InstancePriority] = None
    auto_assign: Optional[dict] = None
    assign_users: Optional[list[str]] = None
    enabled: Optional[bool] = None


class TriggerPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    trigger_id: str
    name: str
    description: Optional[str] = None
    sop_id: str
    event_source: str
    event_type: str
    conditions: list[dict] = Field(default_factory=list)
    dedup: dict = Field(default_factory=dict)
    priority: str
    auto_assign: Optional[dict] = None
    assign_users: list[str] = Field(default_factory=list)
    enabled: bool
    last_fired_at: Optional[datetime] = None
    fire_count: int
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, r) -> "TriggerPublic":
        return cls(
            trigger_id=r.trigger_id, name=r.name, description=r.description,
            sop_id=r.sop_id, event_source=r.event_source, event_type=r.event_type,
            conditions=r.conditions or [], dedup=r.dedup or {}, priority=r.priority,
            auto_assign=r.auto_assign, assign_users=r.assign_users or [],
            enabled=r.enabled, last_fired_at=r.last_fired_at, fire_count=r.fire_count,
            created_at=r.created_at, updated_at=r.updated_at,
        )


class TriggerListResponse(BaseModel):
    items: list[TriggerPublic]
    total: int
    skip: int
    limit: int



# ── Alert format (alert_code → SOP mapping) ────────────────────────────


class CreateAlertFormatRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    alert_code: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=255)
    description: Optional[str] = None
    category: str = "custom"  # security|performance|maintenance|system|custom
    severity: str = "medium"
    priority: str = "medium"
    color_code: str = "#6B7280"
    icon: Optional[str] = None
    alert_sound: bool = False
    sop_id: Optional[str] = None
    sop_mode: str = "manual"  # automatic | manual
    is_active: bool = True


class UpdateAlertFormatRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    alert_code: Optional[str] = Field(default=None, max_length=128)
    name: Optional[str] = Field(default=None, max_length=255)
    description: Optional[str] = None
    category: Optional[str] = None
    severity: Optional[str] = None
    priority: Optional[str] = None
    color_code: Optional[str] = None
    icon: Optional[str] = None
    alert_sound: Optional[bool] = None
    sop_id: Optional[str] = None
    sop_mode: Optional[str] = None
    is_active: Optional[bool] = None


class AlertFormatPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    format_id: str
    alert_code: str
    name: str
    description: Optional[str] = None
    category: str
    severity: str
    priority: str
    color_code: str
    icon: Optional[str] = None
    alert_sound: bool
    sop_id: Optional[str] = None
    sop_mode: str
    is_active: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, r) -> "AlertFormatPublic":
        return cls(
            format_id=r.format_id, alert_code=r.alert_code, name=r.name,
            description=r.description, category=r.category, severity=r.severity,
            priority=r.priority, color_code=r.color_code, icon=r.icon,
            alert_sound=r.alert_sound, sop_id=r.sop_id, sop_mode=r.sop_mode,
            is_active=r.is_active, created_at=r.created_at, updated_at=r.updated_at,
        )


class AlertFormatListResponse(BaseModel):
    items: list[AlertFormatPublic]
    total: int
    skip: int
    limit: int


# ── Event simulator ────────────────────────────────────────────────────


class SimulateEventRequest(BaseModel):
    """A synthetic event injected into the matching pipeline.

    VMS-independent — a generic event envelope. ``alert_code`` (or a code inside
    ``payload``) drives AlertFormat matching; ``event_type`` + ``payload`` drive
    trigger matching. ``dry_run`` (default true) reports what WOULD happen without
    persisting; ``dry_run=false`` actually creates the incident(s).
    """

    model_config = ConfigDict(extra="ignore")
    event_type: str = Field(min_length=1, max_length=255)
    payload: dict[str, Any] = Field(default_factory=dict)
    site_id: Optional[str] = None
    alert_code: Optional[str] = None
    dry_run: bool = True


class SimulateMatchedTrigger(BaseModel):
    trigger_id: str
    name: str
    sop_id: str
    would_create: bool


class SimulateMatchedFormat(BaseModel):
    format_id: str
    alert_code: str
    name: str
    sop_id: Optional[str] = None
    sop_mode: str
    would_create: bool


class SimulateSkipped(BaseModel):
    trigger_id: Optional[str] = None
    format_id: Optional[str] = None
    reason: str


class SimulateEventResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    dry_run: bool
    event_type: str
    alert_code: Optional[str] = None
    matched_triggers: list[SimulateMatchedTrigger] = Field(default_factory=list)
    matched_format: Optional[SimulateMatchedFormat] = None
    skipped: list[SimulateSkipped] = Field(default_factory=list)
    created_instance_id: Optional[str] = None
    created_instance_ids: list[str] = Field(default_factory=list)
