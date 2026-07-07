"""Ingest request/response schemas (pydantic)."""

from __future__ import annotations

import re
from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


class AuthType(str, Enum):
    NONE = "none"
    API_KEY = "api_key"
    BASIC = "basic"


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
    # Optional — server mints a secure random token if omitted.
    token: Optional[str] = Field(default=None, min_length=8, max_length=64)
    description: Optional[str] = Field(default=None, max_length=1024)

    auth_type: AuthType = AuthType.NONE
    auth_username: Optional[str] = Field(default=None, max_length=128)
    # Plaintext on create; server hashes before storing (never persisted raw).
    auth_secret: Optional[str] = Field(default=None, max_length=1024)

    payload_schema: dict[str, Any] = Field(default_factory=dict)
    transform: dict[str, str] = Field(default_factory=dict)
    event_type: str = Field(default="ingest.event", max_length=128)
    is_active: bool = True

    @field_validator("token")
    @classmethod
    def _token(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not _TOKEN_RE.match(v):
            raise ValueError("token must be 8-64 chars of [A-Za-z0-9_-]")
        return v


class WebhookUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category_id: Optional[str] = Field(default=None, min_length=1, max_length=36)
    name: Optional[str] = Field(default=None, min_length=1, max_length=128)
    description: Optional[str] = Field(default=None, max_length=1024)
    auth_type: Optional[AuthType] = None
    auth_username: Optional[str] = Field(default=None, max_length=128)
    # Provide to rotate the secret; omit to leave unchanged.
    auth_secret: Optional[str] = Field(default=None, max_length=1024)
    payload_schema: Optional[dict[str, Any]] = None
    transform: Optional[dict[str, str]] = None
    event_type: Optional[str] = Field(default=None, max_length=128)
    is_active: Optional[bool] = None


class WebhookPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    category_id: str
    name: str
    token: str
    description: Optional[str] = None
    auth_type: str
    auth_username: Optional[str] = None
    has_secret: bool = False
    payload_schema: dict[str, Any] = Field(default_factory=dict)
    transform: dict[str, str] = Field(default_factory=dict)
    event_type: str
    is_active: bool
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
                "token": row.token,
                "description": row.description,
                "auth_type": row.auth_type,
                "auth_username": row.auth_username,
                "has_secret": bool(row.auth_secret_hash),
                "payload_schema": row.payload_schema or {},
                "transform": row.transform or {},
                "event_type": row.event_type,
                "is_active": row.is_active,
                "ingest_url": ingest_url or f"/ingest/hooks/{row.token}",
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
    auth_outcome: str
    schema_outcome: str
    transform_outcome: str
    published: bool
    target_subject: Optional[str] = None
    error: Optional[str] = None
    event_id: Optional[str] = None
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
                "auth_outcome": row.auth_outcome,
                "schema_outcome": row.schema_outcome,
                "transform_outcome": row.transform_outcome,
                "published": row.published,
                "target_subject": row.target_subject,
                "error": row.error,
                "event_id": row.event_id,
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
                "auth_outcome": row.auth_outcome,
                "schema_outcome": row.schema_outcome,
                "transform_outcome": row.transform_outcome,
                "published": row.published,
                "target_subject": row.target_subject,
                "error": row.error,
                "event_id": row.event_id,
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
    would_publish_subject: Optional[str] = None
    auth_type: str


# ── Rotate secret ───────────────────────────────────────────────────


class RotateSecretRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # Also mint a fresh auth secret (only meaningful for api_key / basic webhooks).
    rotate_auth_secret: bool = False


class RotateSecretResponse(BaseModel):
    """Returned ONCE — the plaintext token/secret is never retrievable again."""

    id: str
    token: str
    ingest_url: str
    # Present only when rotate_auth_secret was requested on an authed webhook.
    auth_secret: Optional[str] = None
