"""Tags ORM — cross-cutting labels + a generic tagging association.

Two tables, both TENANT-SCOPED (nullable ``tenant_id``; NULL = platform/super-admin/
system row) matching the row-scoping pattern used by 0007/0009:

  * ``Tag``     — one reusable label (name + hex color + description). Unique per
                  tenant on ``(tenant_id, name)``.
  * ``TagLink`` — a generic association so ANYTHING can be tagged. It stores a
                  ``tag_id`` FK plus a free-string ``entity_type`` (``"site"`` /
                  ``"zone"`` today, ``"device"`` / ``"incident"`` later) and an
                  ``entity_id``. Unique per tenant on
                  ``(tenant_id, tag_id, entity_type, entity_id)`` and indexed on
                  ``(tenant_id, entity_type, entity_id)`` for the reverse lookup.

Portable generic types (Uuid/String/Boolean/DateTime) keep the same model on
Postgres and SQLite (tests). Reads and by-id lookups go through
``app.tenancy.scope`` so isolation lives in one place.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..db.base import Base


def _uuid_str() -> str:
    return str(uuid.uuid4())


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Tag(Base):
    """A reusable, color-coded label."""

    __tablename__ = "tags"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_tags_tenant_name"),
    )

    tag_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: the owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    name: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    color: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=text("'#3B82F6'")
    )
    description: Mapped[str | None] = mapped_column(String(500))
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


class TagLink(Base):
    """A generic association: one ``tag`` attached to one ``entity``.

    ``entity_type`` is a free string (``"site"`` / ``"zone"`` today, extensible to
    ``"device"`` / ``"incident"`` later) — deliberately NOT an FK, so new taggable
    modules need no migration here. ``entity_id`` is the target's id as a string.
    """

    __tablename__ = "tag_links"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id",
            "tag_id",
            "entity_type",
            "entity_id",
            name="uq_tag_links_unique",
        ),
        Index("ix_tag_links_entity", "tenant_id", "entity_type", "entity_id"),
    )

    link_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: the owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    tag_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("tags.tag_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(64), nullable=False)

    created_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
