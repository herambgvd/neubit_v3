"""Pydantic request/response schemas for the workflow REST API.

``*Public`` models are the response contracts (built with ``from_row`` from ORM
rows); ``Create*`` / ``Update*`` are request bodies. List responses carry
pagination metadata. Enum fields validate against the shared enums.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

from .shared import FieldType, InstancePriority, InstanceStatus, ThreatLevelValue


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
    initial_state: Optional[str] = None
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


# ── Form ───────────────────────────────────────────────────────────────


class FormFieldSchema(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: Optional[str] = None
    label: str
    type: FieldType
    placeholder: Optional[str] = None
    help_text: Optional[str] = None
    default_value: Optional[Any] = None
    options: list[dict] = Field(default_factory=list)
    validation: dict = Field(default_factory=dict)
    order: int = 0
    width: str = "full"


class CreateFormRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(min_length=1, max_length=255)
    description: Optional[str] = None
    fields: list[FormFieldSchema] = Field(default_factory=list)
    is_active: bool = True


class UpdateFormRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: Optional[str] = Field(default=None, max_length=255)
    description: Optional[str] = None
    fields: Optional[list[FormFieldSchema]] = None
    is_active: Optional[bool] = None


class FormPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    form_id: str
    name: str
    description: Optional[str] = None
    fields: list[dict] = Field(default_factory=list)
    is_active: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, r) -> "FormPublic":
        return cls(
            form_id=r.form_id, name=r.name, description=r.description,
            fields=r.fields or [], is_active=r.is_active,
            created_at=r.created_at, updated_at=r.updated_at,
        )


# ── Notification template / channel ────────────────────────────────────


class CreateTemplateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(min_length=1, max_length=255)
    description: Optional[str] = None
    channel_type: str = "email"
    subject: Optional[str] = None
    body: str
    provider_template_ref: Optional[str] = None
    is_active: bool = True


class UpdateTemplateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: Optional[str] = None
    description: Optional[str] = None
    channel_type: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    provider_template_ref: Optional[str] = None
    is_active: Optional[bool] = None


class TemplatePublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    template_id: str
    name: str
    description: Optional[str] = None
    channel_type: str
    subject: Optional[str] = None
    body: str
    provider_template_ref: Optional[str] = None
    is_active: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, r) -> "TemplatePublic":
        return cls(
            template_id=r.template_id, name=r.name, description=r.description,
            channel_type=r.channel_type, subject=r.subject, body=r.body,
            provider_template_ref=r.provider_template_ref,
            is_active=r.is_active, created_at=r.created_at, updated_at=r.updated_at,
        )


class CreateChannelRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(min_length=1, max_length=255)
    channel_type: str  # email | webhook | whatsapp | mobile_push | sms
    config: dict = Field(default_factory=dict)
    is_enabled: bool = True
    is_default: bool = False


class UpdateChannelRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: Optional[str] = None
    channel_type: Optional[str] = None
    config: Optional[dict] = None
    is_enabled: Optional[bool] = None
    is_default: Optional[bool] = None


class ChannelPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    channel_id: str
    name: str
    channel_type: str
    config: dict = Field(default_factory=dict)
    is_enabled: bool
    is_default: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, r) -> "ChannelPublic":
        return cls(
            channel_id=r.channel_id, name=r.name, channel_type=r.channel_type,
            config=r.config or {}, is_enabled=r.is_enabled, is_default=r.is_default,
            created_at=r.created_at, updated_at=r.updated_at,
        )


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
    closed_at: Optional[datetime] = None
    outcome: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, r) -> "InstancePublic":
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
            closed_at=r.closed_at, outcome=r.outcome,
            created_at=r.created_at, updated_at=r.updated_at,
        )


class InstanceListResponse(BaseModel):
    items: list[InstancePublic]
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
