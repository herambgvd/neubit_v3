"""Ingest request/response schemas (pydantic)."""

from __future__ import annotations

import os
import re
from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

# v2's exact slug rule: lowercase alphanumeric with -/_ , 3-64 chars, must start
# and end with an alphanumeric.
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$")
_SLUG_ERROR = "slug must be lowercase alphanumeric with -/_ (3-64 chars)"

# The receiver's public origin (e.g. "https://ingest.acme.com"), so the operator
# UI can show a URL that is copy-pasteable straight into a vendor's config. This
# is v2's ``settings.frontend_base_url`` under a service-scoped name. Unset → the
# bare path, which the frontend resolves against its own origin. Kept local to
# ingest rather than added to the shared kernel Settings: no other service
# publishes an externally-callable URL today.
_PUBLIC_BASE_URL = (os.environ.get("VE_INGEST_PUBLIC_BASE_URL") or "").rstrip("/")


def receiver_url(slug: str) -> str:
    """The public inbound URL for a webhook slug — absolute if configured."""
    return f"{_PUBLIC_BASE_URL}/ingest/hooks/{slug}"


class AuthType(str, Enum):
    NONE = "none"
    API_KEY = "api_key"
    BASIC = "basic"
    BEARER = "bearer"
    HMAC = "hmac"


class InboundMethod(str, Enum):
    POST = "post"
    GET = "get"


class EventStatus(str, Enum):
    """The single-value verdict on an inbound delivery (v2's event-log status).

    The operator UI filters on exactly these. ``UNRESOLVED_DEVICE`` is declared
    but never written until v3 grows a device registry — see
    ``Webhook.device_lookup_expr``.
    """

    ACCEPTED = "accepted"
    REJECTED_AUTH = "rejected_auth"
    REJECTED_SCHEMA = "rejected_schema"
    REJECTED_METHOD = "rejected_method"
    TRANSFORM_FAILED = "transform_failed"
    NO_RULE_MATCH = "no_rule_match"
    UNRESOLVED_DEVICE = "unresolved_device"
    PUBLISH_FAILED = "publish_failed"


# ── Category ────────────────────────────────────────────────────────


class CategoryCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=128)
    description: Optional[str] = Field(default=None, max_length=1024)
    target_domain: str = Field(default="ingest", min_length=1, max_length=64)

    @field_validator("target_domain")
    @classmethod
    def _domain(cls, v: str) -> str:
        if not re.match(r"^[a-z][a-z0-9_]{0,63}$", v):
            raise ValueError("target_domain must be lowercase [a-z0-9_], starting with a letter")
        return v


class CategoryUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=128)
    description: Optional[str] = Field(default=None, max_length=1024)
    target_domain: Optional[str] = Field(default=None, min_length=1, max_length=64)
    is_active: Optional[bool] = None

    @field_validator("target_domain")
    @classmethod
    def _domain(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not re.match(r"^[a-z][a-z0-9_]{0,63}$", v):
            raise ValueError("target_domain must be lowercase [a-z0-9_], starting with a letter")
        return v


class CategoryPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str
    description: Optional[str] = None
    target_domain: str
    is_active: bool
    created_at: datetime
    updated_at: datetime
    webhook_count: int = 0

    @classmethod
    def from_row(cls, row, *, webhook_count: int = 0) -> "CategoryPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "name": row.name,
                "description": row.description,
                "target_domain": row.target_domain,
                "is_active": row.is_active,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
                "webhook_count": webhook_count,
            }
        )


class CategoryListResponse(BaseModel):
    items: list[CategoryPublic]
    total: int
    skip: int
    limit: int


# ── Webhook ─────────────────────────────────────────────────────────


class WebhookCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category_id: str = Field(min_length=1, max_length=36)
    name: str = Field(min_length=1, max_length=128)
    # The operator picks this — it IS the public URL's last segment.
    slug: str = Field(min_length=3, max_length=64)
    description: Optional[str] = Field(default=None, max_length=1024)
    # "post" reads the request body; "get" reads query params.
    request_method: InboundMethod = InboundMethod.POST

    auth_type: AuthType = AuthType.NONE
    auth_username: Optional[str] = Field(default=None, max_length=128)
    # Plaintext on create; server hashes (or encrypts, for hmac) before storing.
    auth_secret: Optional[str] = Field(default=None, max_length=1024)

    payload_schema: dict[str, Any] = Field(default_factory=dict)
    transform: dict[str, str] = Field(default_factory=dict)
    # JMESPath naming the device-identifying value in the raw payload.
    device_lookup_expr: Optional[str] = Field(default=None, max_length=512)
    event_type: str = Field(default="ingest.event", max_length=128)
    is_active: bool = True

    @field_validator("slug")
    @classmethod
    def _slug(cls, v: str) -> str:
        if not _SLUG_RE.match(v):
            raise ValueError(_SLUG_ERROR)
        return v


class WebhookUpdate(BaseModel):
    """Note: no ``slug``. It is the public URL an integrator has already been
    given, so it is fixed at create time (v2 did the same) — ``extra="forbid"``
    turns an attempt to change it into a 422 rather than a silent no-op."""

    model_config = ConfigDict(extra="forbid")

    category_id: Optional[str] = Field(default=None, min_length=1, max_length=36)
    name: Optional[str] = Field(default=None, min_length=1, max_length=128)
    description: Optional[str] = Field(default=None, max_length=1024)
    request_method: Optional[InboundMethod] = None
    auth_type: Optional[AuthType] = None
    auth_username: Optional[str] = Field(default=None, max_length=128)
    # Provide to rotate the secret; omit to leave unchanged.
    auth_secret: Optional[str] = Field(default=None, max_length=1024)
    payload_schema: Optional[dict[str, Any]] = None
    transform: Optional[dict[str, str]] = None
    device_lookup_expr: Optional[str] = Field(default=None, max_length=512)
    event_type: Optional[str] = Field(default=None, max_length=128)
    is_active: Optional[bool] = None


class WebhookPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    category_id: str
    name: str
    slug: str
    description: Optional[str] = None
    request_method: str = "post"
    auth_type: str
    auth_username: Optional[str] = None
    has_secret: bool = False
    payload_schema: dict[str, Any] = Field(default_factory=dict)
    transform: dict[str, str] = Field(default_factory=dict)
    device_lookup_expr: Optional[str] = None
    event_type: str
    is_active: bool
    # Absolute when the service knows its public base URL, else the bare path.
    ingest_url: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row, *, ingest_url: Optional[str] = None) -> "WebhookPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "category_id": row.category_id,
                "name": row.name,
                "slug": row.slug,
                "description": row.description,
                "request_method": getattr(row, "request_method", "post") or "post",
                "auth_type": row.auth_type,
                "auth_username": row.auth_username,
                "has_secret": bool(row.auth_secret_hash),
                "payload_schema": row.payload_schema or {},
                "transform": row.transform or {},
                "device_lookup_expr": row.device_lookup_expr,
                "event_type": row.event_type,
                "is_active": row.is_active,
                "ingest_url": ingest_url or receiver_url(row.slug),
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class WebhookListResponse(BaseModel):
    items: list[WebhookPublic]
    total: int
    skip: int
    limit: int


class IngestResponse(BaseModel):
    """Body returned by the public receiver."""

    accepted: bool
    event_id: Optional[str] = None


# ── Event logs ──────────────────────────────────────────────────────


class EventLogSummary(BaseModel):
    """List-row view of an ingest delivery (no payload bodies)."""

    model_config = ConfigDict(extra="ignore")
    id: str
    webhook_id: Optional[str] = None
    category_id: Optional[str] = None
    received_at: datetime
    source_ip: Optional[str] = None
    status: str
    auth_outcome: str
    schema_outcome: str
    transform_outcome: str
    published: bool
    target_subject: Optional[str] = None
    error: Optional[str] = None
    event_id: Optional[str] = None
    matched_rule_id: Optional[str] = None
    device_lookup_value: Optional[str] = None
    resolved_device_id: Optional[str] = None
    is_replay: bool = False

    @classmethod
    def from_row(cls, row) -> "EventLogSummary":
        return cls.model_validate(
            {
                "id": row.id,
                "webhook_id": row.webhook_id,
                "category_id": row.category_id,
                "received_at": row.received_at,
                "source_ip": row.source_ip,
                "status": row.status,
                "auth_outcome": row.auth_outcome,
                "schema_outcome": row.schema_outcome,
                "transform_outcome": row.transform_outcome,
                "published": row.published,
                "target_subject": row.target_subject,
                "error": row.error,
                "event_id": row.event_id,
                "matched_rule_id": getattr(row, "matched_rule_id", None),
                "device_lookup_value": getattr(row, "device_lookup_value", None),
                "resolved_device_id": getattr(row, "resolved_device_id", None),
                "is_replay": row.is_replay,
            }
        )


class EventLogDetail(EventLogSummary):
    """Full event log incl. raw + transformed payload bodies."""

    raw_payload: Any = None
    raw_truncated: bool = False
    transformed_payload: Optional[Any] = None

    @classmethod
    def from_row(cls, row) -> "EventLogDetail":
        return cls.model_validate(
            {
                "id": row.id,
                "webhook_id": row.webhook_id,
                "category_id": row.category_id,
                "received_at": row.received_at,
                "source_ip": row.source_ip,
                "status": row.status,
                "auth_outcome": row.auth_outcome,
                "schema_outcome": row.schema_outcome,
                "transform_outcome": row.transform_outcome,
                "published": row.published,
                "target_subject": row.target_subject,
                "error": row.error,
                "event_id": row.event_id,
                "matched_rule_id": getattr(row, "matched_rule_id", None),
                "device_lookup_value": getattr(row, "device_lookup_value", None),
                "resolved_device_id": getattr(row, "resolved_device_id", None),
                "is_replay": row.is_replay,
                "raw_payload": row.raw_payload,
                "raw_truncated": row.raw_truncated,
                "transformed_payload": row.transformed_payload,
            }
        )


class EventLogListResponse(BaseModel):
    items: list[EventLogSummary]
    total: int
    skip: int
    limit: int


class ReplayResponse(BaseModel):
    """Result of replaying a stored event log through the webhook pipeline."""

    replay_log_id: str
    published: bool
    event_id: Optional[str] = None
    target_subject: Optional[str] = None
    schema_outcome: str
    transform_outcome: str
    error: Optional[str] = None


# ── Webhook test (dry-run) ──────────────────────────────────────────


class WebhookTestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    payload: dict[str, Any] = Field(default_factory=dict)


class WebhookTestResponse(BaseModel):
    """Dry-run outcome — nothing published, nothing logged."""

    schema_valid: bool
    schema_errors: list[str] = Field(default_factory=list)
    transformed: Optional[Any] = None
    transform_errors: list[str] = Field(default_factory=list)
    # Whether the live receiver would accept + publish this sample. False also
    # covers "the webhook has rules and none of them matched" — a case neither
    # schema_valid nor transform_errors expresses.
    would_publish: bool = True
    reject_reason: Optional[str] = None
    would_publish_subject: Optional[str] = None
    auth_type: str
    # The event_type the live receiver would emit for this sample (rule-resolved).
    resolved_event_type: Optional[str] = None
    # The rule id/name that would win (None → webhook default event_type).
    matched_rule_id: Optional[str] = None
    matched_rule_name: Optional[str] = None
    # What the webhook's device_lookup_expr pulled out of this sample.
    device_lookup_value: Optional[str] = None
    # Always None until v3 has a device registry — see Webhook.device_lookup_expr.
    resolved_device_id: Optional[str] = None


# ── Event rules ─────────────────────────────────────────────────────


class MatchOp(str, Enum):
    EXISTS = "exists"
    NOT_EXISTS = "not_exists"
    EQUALS = "equals"
    NOT_EQUALS = "not_equals"
    CONTAINS = "contains"


class MatchCondition(BaseModel):
    """One predicate on the incoming (transformed) payload.

    ``path`` is a JMESPath expression (typically a simple dotted/indexed path).
    ``op`` selects the comparison. ``value`` is required for equals / not_equals
    / contains, and ignored for exists / not_exists.
    """

    model_config = ConfigDict(extra="forbid")
    path: str = Field(min_length=1, max_length=512)
    op: MatchOp = MatchOp.EXISTS
    value: Optional[Any] = None


class EventRuleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=128)
    description: Optional[str] = Field(default=None, max_length=1024)
    priority: int = Field(default=100, ge=0, le=10_000)
    match_conditions: list[MatchCondition] = Field(default_factory=list)
    field_map: dict[str, str] = Field(default_factory=dict)
    # The event type this rule EMITS when it wins.
    event_type: str = Field(default="ingest.event", max_length=128)
    # Optional per-rule override of the category's routing domain.
    target_domain: Optional[str] = Field(default=None, max_length=64)
    enabled: bool = True


class EventRuleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=128)
    description: Optional[str] = Field(default=None, max_length=1024)
    priority: Optional[int] = Field(default=None, ge=0, le=10_000)
    match_conditions: Optional[list[MatchCondition]] = None
    field_map: Optional[dict[str, str]] = None
    event_type: Optional[str] = Field(default=None, max_length=128)
    target_domain: Optional[str] = Field(default=None, max_length=64)
    enabled: Optional[bool] = None


class EventRulePublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    webhook_id: str
    name: str
    description: Optional[str] = None
    priority: int
    match_conditions: list[MatchCondition] = Field(default_factory=list)
    field_map: dict[str, str] = Field(default_factory=dict)
    event_type: str
    target_domain: Optional[str] = None
    enabled: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "EventRulePublic":
        return cls.model_validate(
            {
                "id": row.id,
                "webhook_id": row.webhook_id,
                "name": row.name,
                "description": row.description,
                "priority": row.priority,
                "match_conditions": row.match_conditions or [],
                "field_map": row.field_map or {},
                "event_type": row.event_type,
                "target_domain": row.target_domain,
                "enabled": row.enabled,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class EventRuleListResponse(BaseModel):
    items: list[EventRulePublic]
    total: int


class RuleTestRequest(BaseModel):
    """Dry-run a sample payload against an existing or proposed rule shape."""

    model_config = ConfigDict(extra="forbid")
    payload: dict[str, Any] = Field(default_factory=dict)
    # If provided, evaluate against an unsaved rule shape (form live preview);
    # otherwise evaluate against the persisted rule.
    match_conditions: Optional[list[MatchCondition]] = None
    field_map: Optional[dict[str, str]] = None


class RuleTestResponse(BaseModel):
    matched: bool
    condition_results: list[dict[str, Any]] = Field(default_factory=list)
    extracted: Optional[dict[str, Any]] = None
    # The event_type this rule would emit on a match.
    event_type: Optional[str] = None


# ── Rotate secret ───────────────────────────────────────────────────


class RotateSecretRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RotateSecretResponse(BaseModel):
    """Returned ONCE — the plaintext secret is never retrievable again.

    Rotates the AUTH SECRET only. The URL is not touched: its slug is an
    operator-chosen identifier, not a credential, so re-minting it would break
    every integrator's config to no security benefit. To retire a URL, disable
    or delete the webhook.
    """

    id: str
    slug: str
    ingest_url: str
    auth_secret: str
