"""Ingest ORM — categories + webhooks, tenant-scoped.

Both tables carry a nullable ``tenant_id`` (the owning tenant; NULL = a
platform/super-admin/system row) — the kernel multi-tenancy pattern. Reads and
by-id lookups go through ``kernel.auth.scoped`` / ``assert_owned`` so isolation
lives in one place.

Portable generic types (String/Boolean/DateTime/Uuid/JSON) keep one model on both
Postgres and SQLite (tests). ``payload_schema`` and ``transform`` are JSON blobs
the pydantic schemas validate before they reach the DB. ``auth_secret`` is stored
hashed, never plaintext — see ``security.py``.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def _uuid_str() -> str:
    return str(uuid.uuid4())


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class IngestCategory(Base):
    """A logical grouping of webhooks that names where their events route."""

    __tablename__ = "ingest_categories"
    __table_args__ = (
        # v2 held a global unique index on name; the tenant-scoped equivalent is
        # unique per owning tenant (NULL tenant = the platform's own namespace).
        Index("uq_ingest_categories_tenant_name", "tenant_id", "name", unique=True),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: the owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    name: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(String(1024))
    # The domain segment of the published subject: tenant.<tid>.<domain>.event.received.
    # Defaults to "ingest"; a category can route its events to another domain.
    target_domain: Mapped[str] = mapped_column(
        String(64), nullable=False, server_default=text("'ingest'")
    )

    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true"), index=True
    )
    created_by: Mapped[str | None] = mapped_column(String(36))
    updated_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


# The maximum size (in serialized-JSON chars) of a raw payload we persist verbatim.
# Anything larger is truncated to a marker so a hostile/huge body can't bloat the log.
MAX_RAW_PAYLOAD_CHARS = 64_000


class Webhook(Base):
    """A public receiver: its token (URL), per-webhook auth, schema + transform."""

    __tablename__ = "ingest_webhooks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: the owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    category_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("ingest_categories.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    # Operator-chosen path segment of the public URL: /ingest/hooks/{slug}.
    # Globally unique, because the receiver takes no JWT and the slug is the only
    # key it has to find the webhook — so it must be unambiguous across tenants.
    # Guessable by design: the URL identifies, auth_type authenticates, which is
    # why an auth_type="none" webhook is an open endpoint and the form warns.
    slug: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    description: Mapped[str | None] = mapped_column(String(1024))

    # "post" (read body) | "get" (read query params). Plain string (no PG enum).
    request_method: Mapped[str] = mapped_column(
        String(8), nullable=False, server_default=text("'post'")
    )

    # "none" | "api_key" | "basic" | "bearer" | "hmac".
    auth_type: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'none'")
    )
    # For basic: the expected username (plaintext, non-secret).
    auth_username: Mapped[str | None] = mapped_column(String(128))
    # Hashed secret (api_key token / basic password), never plaintext; NULL for
    # "none". Sized for the widest producer: security.encrypt_secret (hmac) emits
    # 4 + 32 + 1 + 2*len(plain) chars against a 1024-char secret limit.
    auth_secret_hash: Mapped[str | None] = mapped_column(String(2048))

    # JSON Schema (Draft 2020-12). Empty {} accepts anything.
    payload_schema: Mapped[dict] = mapped_column(
        JSON, nullable=False, server_default=text("'{}'")
    )
    # {target_field: "jmespath expression"} applied to the raw payload. Empty {} = passthrough.
    transform: Mapped[dict] = mapped_column(JSON, nullable=False, server_default=text("'{}'"))

    # JMESPath into the RAW payload naming the value that identifies the sending
    # device (e.g. "data.dev_net_info[0].mac"). v3 has no device registry —
    # identity is split across vision and access, each in its own DB, and
    # cross-service HTTP is banned — so the extracted value is published as
    # ``device_lookup_value`` for a downstream consumer to resolve.
    device_lookup_expr: Mapped[str | None] = mapped_column(String(512))

    # The event ``type`` stamped on the published envelope.
    event_type: Mapped[str] = mapped_column(
        String(128), nullable=False, server_default=text("'ingest.event'")
    )

    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true"), index=True
    )
    created_by: Mapped[str | None] = mapped_column(String(36))
    updated_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class IngestEventRule(Base):
    """A payload-driven routing rule owned by one webhook.

    A webhook with at least one enabled rule uses the rule flow: walk rules by
    priority ASC then created_at ASC, evaluate each rule's ``match_conditions``
    against the raw payload, and the first match wins. Its ``field_map`` replaces
    the webhook-level ``transform`` rather than chaining onto it, and its
    ``event_type`` is emitted. Enabled rules with no match reject the delivery;
    zero enabled rules fall back to the webhook transform and default event_type.

    Conditions read the raw payload, not the transformed one — that is what the
    operator wrote their paths against, and the transform may have dropped the
    field a condition tests. It also keeps the rule-test endpoint honest.

    A rule only emits an ``event_type``; SOP binding happens downstream in
    workflow triggers matching on it (``workflow/app/workflow/correlation.py``).
    ``target_domain`` optionally overrides the category's routing domain.

    Tenant-scoped, mirroring the owning webhook. JSON columns are portable
    generic types and there is no PG enum — that avoids the asyncpg add-column
    footgun.
    """

    __tablename__ = "ingest_event_rules"
    __table_args__ = (
        # Exactly the receiver's hot query: WHERE webhook_id ORDER BY priority, created_at.
        Index(
            "ix_ingest_event_rules_webhook_priority",
            "webhook_id",
            "priority",
            "created_at",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: the owning tenant (mirrors the webhook's tenant_id). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    webhook_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("ingest_webhooks.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024))
    # Lower value = evaluated first; stable tiebreak by created_at.
    priority: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("100")
    )
    # [{path, op, value}, ...] — evaluated by matcher.py.
    match_conditions: Mapped[Any] = mapped_column(
        JSON, nullable=False, server_default=text("'[]'")
    )
    # {target_field: "jmespath_expr"} — the extraction applied when this rule wins.
    field_map: Mapped[dict] = mapped_column(
        JSON, nullable=False, server_default=text("'{}'")
    )
    # The event ``type`` stamped on the published envelope when this rule matches.
    event_type: Mapped[str] = mapped_column(
        String(128), nullable=False, server_default=text("'ingest.event'")
    )
    # Optional per-rule override of the category's routing domain (else category's).
    target_domain: Mapped[str | None] = mapped_column(String(64))
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )

    created_by: Mapped[str | None] = mapped_column(String(36))
    updated_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class IngestEventLog(Base):
    """One row per inbound ``POST /ingest/hooks/{slug}`` request — the audit trail.

    Records the outcome of each pipeline stage (auth → schema → transform →
    publish), including auth failures on unknown tokens (webhook_id / category_id
    NULL). ``raw_payload`` is verbatim but capped at ``MAX_RAW_PAYLOAD_CHARS``,
    with ``raw_truncated`` flagging a clip. Written in the receiver's own txn so
    recording never lags the accept.

    Outcome columns are plain strings, not a DB enum (asyncpg add-column footgun):
    auth_outcome/schema_outcome/transform_outcome ∈ {"ok","failed","skipped"},
    auth being only ok/failed.

    ``status`` is kept alongside them because it names outcomes the stage columns
    cannot express — ``no_rule_match`` and ``rejected_method`` otherwise look like
    a plain pass — and because the operator UI filters on exactly these eight
    values. Stage columns say where it stopped, ``status`` says why.
    """

    __tablename__ = "ingest_event_logs"
    __table_args__ = (
        Index("ix_ingest_event_logs_tenant_received", "tenant_id", "received_at"),
        # The per-webhook events tab: WHERE webhook_id ORDER BY received_at DESC.
        Index("ix_ingest_event_logs_webhook_received", "webhook_id", "received_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: the owning tenant (NULL only on an unknown-token auth fail). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    # Nullable: a failed auth on an unknown token has no webhook/category.
    # No FK — the log must survive the webhook/category being deleted (audit trail).
    webhook_id: Mapped[str | None] = mapped_column(String(36), index=True)
    category_id: Mapped[str | None] = mapped_column(String(36), index=True)

    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, index=True
    )
    source_ip: Mapped[str | None] = mapped_column(String(64))

    # Per-stage outcomes. auth ∈ {ok,failed}; schema/transform ∈ {ok,failed,skipped}.
    auth_outcome: Mapped[str] = mapped_column(String(16), nullable=False)
    schema_outcome: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'skipped'")
    )
    transform_outcome: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'skipped'")
    )
    # The single-value verdict — one of the STATUS_* constants in service.py.
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=text("'accepted'"), index=True
    )

    published: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), index=True
    )
    target_subject: Mapped[str | None] = mapped_column(String(256))
    error: Mapped[str | None] = mapped_column(Text)

    raw_payload: Mapped[Any] = mapped_column(JSON, nullable=False)
    raw_truncated: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    transformed_payload: Mapped[Any | None] = mapped_column(JSON)

    # The ingest event_id stamped on the published envelope (NULL if not published).
    event_id: Mapped[str | None] = mapped_column(String(36))
    # The IngestEventRule that determined the emitted event_type (NULL = default/none).
    matched_rule_id: Mapped[str | None] = mapped_column(String(36))

    # What the webhook's device_lookup_expr pulled out of this payload; NULL when
    # no lookup is configured. Published for a downstream consumer to resolve.
    device_lookup_value: Mapped[str | None] = mapped_column(String(256))
    # Always NULL until v3 grows a device registry; kept so the column and the
    # UI's "Resolved Device" row are ready when resolution lands.
    resolved_device_id: Mapped[str | None] = mapped_column(String(36))
    # True when this row was produced by a replay of an earlier log.
    is_replay: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), index=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
