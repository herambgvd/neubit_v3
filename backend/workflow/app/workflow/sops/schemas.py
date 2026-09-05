"""SOP / state / transition request + response schemas.

``*Public`` models carry a ``from_row`` classmethod rather than
``model_validate(orm)``: the wire shape is deliberately NOT the column shape (v2
field names are preserved for the frontend), so the mapping is written out once,
here, where a reviewer can see it.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

from ..core.enums import InstancePriority

# ── SOP ────────────────────────────────────────────────────────────────


class EscalationRule(BaseModel):
    model_config = ConfigDict(extra="ignore")
    after_hours: float = Field(gt=0)
    to_priority: InstancePriority = InstancePriority.HIGH
    notify_role_ids: list[str] = Field(default_factory=list)


class CreateSopRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(min_length=1, max_length=255)
    description: Optional[str] = None
    priority: InstancePriority = InstancePriority.MEDIUM
    trigger_event_types: list[str] = Field(default_factory=list)
    sla_hours: Optional[float] = None
    tags: list[str] = Field(default_factory=list)
    escalation_rules: list[EscalationRule] = Field(default_factory=list)
    is_active: bool = True


class UpdateSopRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: Optional[str] = Field(default=None, max_length=255)
    description: Optional[str] = None
    priority: Optional[InstancePriority] = None
    # NO ``initial_state``. It is derived from the state flagged ``is_initial``
    # (StateService._sync_pointer); accepting it here let a PATCH on the SOP write
    # any string into the column -- a state of another SOP, of another TENANT, or
    # one that never existed -- and the next graph-editor load could not resolve
    # it. ``extra="ignore"`` means a client still sending the field is ignored
    # rather than 422'd. The way to move it is PATCH .../states/{id} is_initial.
    trigger_event_types: Optional[list[str]] = None
    sla_hours: Optional[float] = None
    tags: Optional[list[str]] = None
    escalation_rules: Optional[list[EscalationRule]] = None
    is_active: Optional[bool] = None


class SopPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    sop_id: str
    name: str
    description: Optional[str] = None
    initial_state: Optional[str] = None
    priority: str
    trigger_event_types: list[str] = Field(default_factory=list)
    sla_hours: Optional[float] = None
    tags: list[str] = Field(default_factory=list)
    escalation_rules: list[dict] = Field(default_factory=list)
    version: int
    is_active: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, r) -> "SopPublic":
        return cls(
            sop_id=r.sop_id, name=r.name, description=r.description,
            initial_state=r.initial_state, priority=r.priority,
            trigger_event_types=r.trigger_event_types or [],
            sla_hours=r.sla_hours, tags=r.tags or [],
            escalation_rules=r.escalation_rules or [], version=r.version,
            is_active=r.is_active, created_at=r.created_at, updated_at=r.updated_at,
        )


class SopListResponse(BaseModel):
    items: list[SopPublic]
    total: int
    skip: int
    limit: int


# ── State ──────────────────────────────────────────────────────────────


class CreateStateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(min_length=1, max_length=255)
    description: Optional[str] = None
    color: str = "#6366F1"
    position_x: float = 0
    position_y: float = 0
    is_initial: bool = False
    is_terminal: bool = False
    is_cancellation: bool = False
    sla_hours: Optional[float] = None
    entry_actions: list[dict] = Field(default_factory=list)
    exit_actions: list[dict] = Field(default_factory=list)
    required_role_ids: list[str] = Field(default_factory=list)
    order: int = 0


class UpdateStateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: Optional[str] = Field(default=None, max_length=255)
    description: Optional[str] = None
    color: Optional[str] = None
    position_x: Optional[float] = None
    position_y: Optional[float] = None
    is_initial: Optional[bool] = None
    is_terminal: Optional[bool] = None
    is_cancellation: Optional[bool] = None
    sla_hours: Optional[float] = None
    entry_actions: Optional[list[dict]] = None
    exit_actions: Optional[list[dict]] = None
    required_role_ids: Optional[list[str]] = None
    order: Optional[int] = None


class StatePublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    state_id: str
    sop_id: str
    name: str
    description: Optional[str] = None
    color: str
    position_x: float
    position_y: float
    is_initial: bool
    is_terminal: bool
    is_cancellation: bool
    sla_hours: Optional[float] = None
    entry_actions: list[dict] = Field(default_factory=list)
    exit_actions: list[dict] = Field(default_factory=list)
    required_role_ids: list[str] = Field(default_factory=list)
    order: int
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, r) -> "StatePublic":
        return cls(
            state_id=r.state_id, sop_id=r.sop_id, name=r.name, description=r.description,
            color=r.color, position_x=r.position_x, position_y=r.position_y,
            is_initial=r.is_initial, is_terminal=r.is_terminal,
            is_cancellation=r.is_cancellation, sla_hours=r.sla_hours,
            entry_actions=r.entry_actions or [], exit_actions=r.exit_actions or [],
            required_role_ids=r.required_role_ids or [], order=r.order,
            created_at=r.created_at, updated_at=r.updated_at,
        )


# ── Transition ─────────────────────────────────────────────────────────


class TransitionCondition(BaseModel):
    model_config = ConfigDict(extra="ignore")
    field: str
    operator: str = "eq"
    value: Any = None


class CreateTransitionRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    from_state_id: str
    to_state_id: str
    label: str = Field(min_length=1, max_length=255)
    description: Optional[str] = None
    requires_note: bool = False
    confirmation_required: bool = False
    required_role_ids: list[str] = Field(default_factory=list)
    form_id: Optional[str] = None
    conditions: list[TransitionCondition] = Field(default_factory=list)
    notification_config: Optional[dict] = None


class UpdateTransitionRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    from_state_id: Optional[str] = None
    to_state_id: Optional[str] = None
    label: Optional[str] = Field(default=None, max_length=255)
    description: Optional[str] = None
    requires_note: Optional[bool] = None
    confirmation_required: Optional[bool] = None
    required_role_ids: Optional[list[str]] = None
    form_id: Optional[str] = None
    conditions: Optional[list[TransitionCondition]] = None
    notification_config: Optional[dict] = None


class TransitionPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    transition_id: str
    sop_id: str
    from_state_id: str
    to_state_id: str
    label: str
    description: Optional[str] = None
    requires_note: bool
    confirmation_required: bool
    required_role_ids: list[str] = Field(default_factory=list)
    form_id: Optional[str] = None
    conditions: list[dict] = Field(default_factory=list)
    notification_config: Optional[dict] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, r) -> "TransitionPublic":
        return cls(
            transition_id=r.transition_id, sop_id=r.sop_id,
            from_state_id=r.from_state_id, to_state_id=r.to_state_id, label=r.label,
            description=r.description, requires_note=r.requires_note,
            confirmation_required=r.confirmation_required,
            required_role_ids=r.required_role_ids or [], form_id=r.form_id,
            conditions=r.conditions or [], notification_config=r.notification_config,
            created_at=r.created_at, updated_at=r.updated_at,
        )


