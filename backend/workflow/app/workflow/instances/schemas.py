"""Workflow-instance (incident) request + response schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Optional

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from ..core.enums import InstancePriority, InstanceStatus

# ── Workflow instance ──────────────────────────────────────────────────

#: A source key is ``<producer>:<the producer's own id for the thing>``. The
#: namespace is required so two producers can never mint the same key for
#: different things; beyond it the key is the producer's and is never parsed here.
SOURCE_KEY_PATTERN = r"^[a-z][a-z0-9_]*:\S+$"
SOURCE_KEY_MAX = 255
#: The most keys one "which have open work" read may ask about. Far above the
#: findings one site or one alert window produces; a bound so a malformed caller
#: cannot turn one request into an unbounded IN list.
SOURCE_LOOKUP_MAX = 500

SourceKey = Annotated[
    str, StringConstraints(min_length=3, max_length=SOURCE_KEY_MAX, pattern=SOURCE_KEY_PATTERN)
]


class CreateInstanceRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    sop_id: str
    name: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[InstancePriority] = None
    site_id: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    trigger_data: Optional[dict] = None
    event_id: Optional[str] = None
    event_type: Optional[str] = None
    metadata: Optional[dict] = None
    # The finding this incident is about. When set, a create while an incident
    # for the same key is still OPEN returns that incident (200) instead of
    # raising a second one (201). See InstanceService.create.
    source_key: Optional[SourceKey] = None


class TransitionInstanceRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    transition_id: str
    notes: Optional[str] = None
    form_data: Optional[dict] = None


class AssignInstanceRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    assigned_to: Optional[str] = None
    assigned_to_name: Optional[str] = None
    assigned_role: Optional[str] = None
    assigned_role_name: Optional[str] = None


class StatusChangeRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    status: InstanceStatus
    outcome: Optional[str] = None


class EscalateInstanceRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    reason: Optional[str] = None


class InstancePublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    instance_id: str
    sop_id: str
    sop_name: str
    sop_version: int
    name: Optional[str] = None
    description: Optional[str] = None
    priority: str
    site_id: Optional[str] = None
    current_state: Optional[str] = None
    current_state_name: Optional[str] = None
    status: str
    assigned_to: Optional[str] = None
    assignment: Optional[dict] = None
    sla_hours: Optional[float] = None
    sla_deadline: Optional[datetime] = None
    is_sla_breached: bool
    state_entered_at: Optional[datetime] = None
    escalation: Optional[dict] = None
    tags: list[str] = Field(default_factory=list)
    timeline: list[dict] = Field(default_factory=list)
    metadata: Optional[dict] = None
    trigger_data: Optional[dict] = None
    event_id: Optional[str] = None
    event_type: Optional[str] = None
    # Derived from the originating envelope in trigger_data, not columns of their
    # own. event_source is the EventBus domain tag ("vision", "access", "ingest"),
    # the grouping the Source filter uses. source_event_id is the originating
    # event's OWN id, which differs from event_id (the bus envelope UUID).
    # "manual" when operator-raised.
    event_source: Optional[str] = None
    source_event_id: Optional[str] = None
    closed_at: Optional[datetime] = None
    outcome: Optional[str] = None
    source_key: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, r) -> "InstancePublic":
        env = r.trigger_data if isinstance(r.trigger_data, dict) else None
        extra = r.extra if isinstance(r.extra, dict) else None
        if env:
            event_source = env.get("source")
            payload = env.get("payload") if isinstance(env.get("payload"), dict) else {}
            source_event_id = payload.get("event_id") if isinstance(payload, dict) else None
        else:
            # No envelope → operator-raised (or an unmapped manual create).
            event_source = (extra or {}).get("source") or "manual"
            source_event_id = None
        return cls(
            instance_id=r.instance_id, sop_id=r.sop_id, sop_name=r.sop_name,
            sop_version=r.sop_version, name=r.name, description=r.description,
            priority=r.priority, site_id=r.site_id, current_state=r.current_state,
            current_state_name=r.current_state_name, status=r.status,
            assigned_to=r.assigned_to, assignment=r.assignment, sla_hours=r.sla_hours,
            sla_deadline=r.sla_deadline, is_sla_breached=r.is_sla_breached,
            state_entered_at=r.state_entered_at, escalation=r.escalation,
            tags=r.tags or [], timeline=r.timeline or [], metadata=r.extra,
            trigger_data=r.trigger_data, event_id=r.event_id, event_type=r.event_type,
            event_source=event_source, source_event_id=source_event_id,
            closed_at=r.closed_at, outcome=r.outcome, source_key=r.source_key,
            created_at=r.created_at, updated_at=r.updated_at,
        )


class InstanceListResponse(BaseModel):
    items: list[InstancePublic]
    total: int
    skip: int
    limit: int



class InstanceStatsResponse(BaseModel):
    """Incident counts for the stats strip.

    ``by_status``: pending | active | paused | resolved | completed | cancelled
    (``completed`` aliases ``resolved``). ``by_priority``: critical | high | medium
    | low. Every key is present, zero-filled.
    """

    model_config = ConfigDict(extra="ignore")
    by_status: dict[str, int] = Field(default_factory=dict)
    by_priority: dict[str, int] = Field(default_factory=dict)
    total: int = 0


# ── Open work by source key ────────────────────────────────────────────


class OpenBySourceRequest(BaseModel):
    """Which of these findings already have open work."""

    model_config = ConfigDict(extra="ignore")
    source_keys: list[SourceKey] = Field(min_length=1, max_length=SOURCE_LOOKUP_MAX)


class OpenWorkRef(BaseModel):
    """The open incident a finding already has — enough to draw a link to it."""

    model_config = ConfigDict(extra="ignore")
    instance_id: str
    name: Optional[str] = None
    sop_name: str
    status: str
    priority: str
    current_state_name: Optional[str] = None
    assigned_to: Optional[str] = None
    created_at: datetime

    @classmethod
    def from_row(cls, r) -> "OpenWorkRef":
        return cls(
            instance_id=r.instance_id, name=r.name, sop_name=r.sop_name, status=r.status,
            priority=r.priority, current_state_name=r.current_state_name,
            assigned_to=r.assigned_to, created_at=r.created_at,
        )


class OpenBySourceResponse(BaseModel):
    """Every asked key lands in exactly one of the two: a key with open work maps
    to that incident, a key without is listed. Nothing asked is dropped, so
    ``len(with_work) + len(without_work)`` is the number of distinct keys asked."""

    with_work: dict[str, OpenWorkRef] = Field(default_factory=dict)
    without_work: list[str] = Field(default_factory=list)
