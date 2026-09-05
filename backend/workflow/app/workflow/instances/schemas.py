"""Workflow-instance (incident) request + response schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from ..core.enums import InstancePriority, InstanceStatus

# ── Workflow instance ──────────────────────────────────────────────────


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
    # Cross-link fields (DERIVED from the originating event envelope in trigger_data;
    # not their own columns). event_source = the EventBus domain source tag on the
    # envelope ("vision" for camera events, "access", "ingest", …) — the coarse
    # grouping the incident Source filter uses. source_event_id = the ORIGINATING
    # event's OWN id (e.g. a VmsEvent id) carried in the envelope payload, which
    # differs from event_id (the bus envelope UUID). "manual" when operator-raised.
    event_source: Optional[str] = None
    source_event_id: Optional[str] = None
    closed_at: Optional[datetime] = None
    outcome: Optional[str] = None
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
            closed_at=r.closed_at, outcome=r.outcome,
            created_at=r.created_at, updated_at=r.updated_at,
        )


class InstanceListResponse(BaseModel):
    items: list[InstancePublic]
    total: int
    skip: int
    limit: int



class InstanceStatsResponse(BaseModel):
    """Incident counts for the stats strip.

    ``by_status`` keys: pending | active | paused | resolved | completed |
    cancelled (``completed`` is an alias of ``resolved``). ``by_priority`` keys:
    critical | high | medium | low. Every key is present (zero-filled).
    """

    model_config = ConfigDict(extra="ignore")
    by_status: dict[str, int] = Field(default_factory=dict)
    by_priority: dict[str, int] = Field(default_factory=dict)
    total: int = 0
