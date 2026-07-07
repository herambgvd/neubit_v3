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
    # The opaque secret in the public URL: /ingest/hooks/{token}. Globally unique
    # (unguessable) so the receiver can look a webhook up without a JWT/tenant hint.
    token: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    description: Mapped[str | None] = mapped_column(String(1024))

    # "none" | "api_key" | "basic".
    auth_type: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'none'")
    )
    # For basic: the expected username (plaintext, non-secret).
    auth_username: Mapped[str | None] = mapped_column(String(128))
    # HASHED secret (api_key token / basic password) — never plaintext. NULL for "none".
    auth_secret_hash: Mapped[str | None] = mapped_column(String(128))

    # JSON Schema (Draft 2020-12). Empty {} accepts anything.
    payload_schema: Mapped[dict] = mapped_column(
        JSON, nullable=False, server_default=text("'{}'")
    )
    # {target_field: "jmespath expression"} applied to the raw payload. Empty {} = passthrough.
    transform: Mapped[dict] = mapped_column(JSON, nullable=False, server_default=text("'{}'"))

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


class IngestEventLog(Base):
    """One row per inbound ``POST /ingest/hooks/{token}`` request — the audit trail.

    Captures the outcome at each pipeline stage (auth → schema → transform →
    publish) so operators can see exactly what happened to every delivery,
    including auth failures on unknown tokens (webhook_id / category_id NULL).
    ``raw_payload`` is stored verbatim but capped at ``MAX_RAW_PAYLOAD_CHARS``
    (``raw_truncated`` flags when it was clipped). Written in the same txn as the
    receiver so recording never lags the accept.

    Outcome columns are short plain strings (no DB enum — avoids the asyncpg
    add-column enum footgun): auth_outcome/schema_outcome/transform_outcome ∈
    {"ok","failed","skipped"} (auth is only ok/failed).
    """

    __tablename__ = "ingest_event_logs"
    __table_args__ = (
        Index("ix_ingest_event_logs_tenant_received", "tenant_id", "received_at"),
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
    # True when this row was produced by a replay of an earlier log.
    is_replay: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), index=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
