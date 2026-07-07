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

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    String,
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
