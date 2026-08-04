"""Ingest ORM — categories + webhooks, tenant-scoped.

Both tables carry a nullable ``tenant_id`` (the owning tenant; NULL = a
platform/super-admin/system row) — the kernel multi-tenancy pattern. Reads and
by-id lookups go through ``kernel.auth.scoped`` / ``assert_owned`` so isolation
lives in one place.

Portable generic types (String/Boolean/DateTime/Uuid/JSON) keep the same model on
Postgres and SQLite (tests). ``payload_schema`` (JSON Schema) and ``transform``
(JMESPath field-map) are JSON blobs validated by the pydantic schemas before they
reach the DB. The webhook's ``auth_secret`` is stored HASHED (never plaintext) —
see ``security.py``.
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
    # The operator-chosen path segment of the public URL: /ingest/hooks/{slug}
    # (e.g. "face-detection"). Globally unique — the receiver takes no JWT, so
    # the slug is the ONLY key it has to find the webhook, and it must therefore
    # be unambiguous across tenants.
    #
    # Readable and guessable BY DESIGN (v2 parity): the URL identifies the
    # webhook, it does not authenticate the caller. That job belongs to
    # auth_type — which is why an auth_type="none" webhook is an open endpoint
    # and the form warns about it.
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
    # HASHED secret (api_key token / basic password) — never plaintext. NULL for "none".
    # Sized for the widest producer: security.encrypt_secret (hmac) emits
    # 4 + 32 + 1 + 2*len(plain) chars, and the schema admits a 1024-char secret.
    auth_secret_hash: Mapped[str | None] = mapped_column(String(2048))

    # JSON Schema (Draft 2020-12). Empty {} accepts anything.
    payload_schema: Mapped[dict] = mapped_column(
        JSON, nullable=False, server_default=text("'{}'")
    )
    # {target_field: "jmespath expression"} applied to the raw payload. Empty {} = passthrough.
    transform: Mapped[dict] = mapped_column(JSON, nullable=False, server_default=text("'{}'"))

    # JMESPath into the RAW payload naming the value that identifies the sending
    # device (e.g. "data.dev_net_info[0].mac"). v2 resolved this against its
    # devices table's source_ref and enriched the event with device_id/site_id.
    # v3 has no device registry yet (device identity is split across the vision /
    # access services, each in its own DB, and cross-service HTTP is banned), so
    # the extracted value is published as ``device_lookup_value`` for a
    # downstream consumer to resolve. See ReceiverService.run_pipeline.
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

    Ported 1:1 from neubit_v2's ``IngestEventRuleORM``. A webhook with at least
    one enabled rule uses the rule-based flow: walk rules by ``priority`` (ASC,
    then ``created_at`` ASC), evaluate each rule's ``match_conditions`` against
    the RAW payload, and the FIRST matching rule wins — its ``field_map``
    REPLACES the webhook-level ``transform`` (it is not chained on top of it) and
    its ``event_type`` becomes the emitted event type. A webhook with enabled
    rules but no match REJECTS the delivery (v2's ``no_rule_match``) rather than
    publishing an unrouted event. A webhook with zero enabled rules falls back to
    the webhook-level ``transform`` + default ``event_type``.

    Conditions read the RAW payload, not the transformed one: a vendor's sample
    body is what an operator writes paths against, and the webhook ``transform``
    may well have dropped the very field a condition tests. This also keeps the
    rule-test endpoint honest — it evaluates the same input the receiver does.

    Unlike v2 (which stored a Kafka ``target_topic`` and a per-rule
    ``workflow_id``), a v3 rule simply EMITS an ``event_type``. SOP binding is
    done downstream by workflow triggers matching on that type — see
    ``backend/workflow/app/workflow/correlation.py``. (v2's ``workflow_id`` was
    stamped onto the event and never read by anything.) ``target_domain`` is an
    optional per-rule override of the category's routing domain.

    Tenant-scoped (``tenant_id`` mirrors the owning webhook). JSON columns are
    portable generic types; no PG enum (dodges the asyncpg add-column footgun).
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

    Captures the outcome at each pipeline stage (auth → schema → transform →
    publish) so operators can see exactly what happened to every delivery,
    including auth failures on unknown tokens (webhook_id / category_id NULL).
    ``raw_payload`` is stored verbatim but capped at ``MAX_RAW_PAYLOAD_CHARS``
    (``raw_truncated`` flags when it was clipped). Written in the same txn as the
    receiver so recording never lags the accept.

    Outcome columns are short plain strings (no DB enum — avoids the asyncpg
    add-column enum footgun): auth_outcome/schema_outcome/transform_outcome ∈
    {"ok","failed","skipped"} (auth is only ok/failed).

    ``status`` is v2's single-value verdict, kept alongside the per-stage columns
    because it names outcomes the stage columns cannot express — ``no_rule_match``
    and ``rejected_method`` both look like a plain auth/schema pass otherwise —
    and because the operator UI filters on exactly these eight values. The stage
    columns stay authoritative for "where did it stop"; ``status`` answers "why".
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

    # The value the webhook's device_lookup_expr pulled out of this payload
    # (NULL when the webhook configures no lookup). Published for a downstream
    # consumer to resolve; see Webhook.device_lookup_expr.
    device_lookup_value: Mapped[str | None] = mapped_column(String(256))
    # v2 resolved device_lookup_value against its devices table and stored the hit
    # here. Always NULL until v3 grows a device registry — kept so the column (and
    # the UI's "Resolved Device" row) is ready when resolution lands.
    resolved_device_id: Mapped[str | None] = mapped_column(String(36))
    # True when this row was produced by a replay of an earlier log.
    is_replay: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), index=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
