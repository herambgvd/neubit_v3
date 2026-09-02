"""Bookmark model — operator-marked moments/ranges in recorded footage (G3).

An investigation aid: an operator scrubbing recorded playback marks a moment (a
point, ``end_ts`` NULL) or a range (``end_ts`` set) on a camera's timeline with a
title, an optional note and free-form tags. The frontend lists them as markers on
the scrub bar and in a bookmarks panel; a click jumps playback to ``start_ts``.

Tenant-scoped (nullable ``tenant_id``; NULL = a platform/system row) — every read
goes through ``kernel.auth.scoped`` / the service verifies the owning camera. Plain
string / JSON columns, NO PG enums (the asyncpg add-column enum footgun, project
memory).

⭐ Migration gotcha (project memory): this module must be imported by BOTH
``migrations/env.py`` (via ``app.vms.models``) AND ``0001_vision_baseline._tables()``
AND landed on deployed DBs by ``0015_bookmarks_evidence`` — a model whose module is
not imported in all three is silently dropped on a fresh deploy. Keep
``models/__init__`` ``__all__`` + the baseline list + ``0015`` in sync.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    DateTime,
    Index,
    String,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from ._common import _utcnow, _uuid_str


class Bookmark(Base):
    """An operator bookmark on a camera timeline (a point or a range), tenant-scoped."""

    __tablename__ = "bookmarks"
    __table_args__ = (
        # The bookmarks panel + scrub-bar scan by camera + time window — the primary
        # access path. A tenant+start index supports estate-wide browse.
        Index("ix_bookmarks_camera_start", "camera_id", "start_ts"),
        Index("ix_bookmarks_tenant_start", "tenant_id", "start_ts"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    camera_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)

    # A point bookmark has end_ts NULL; a range bookmark has end_ts > start_ts.
    start_ts: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    end_ts: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    note: Mapped[str | None] = mapped_column(String(4000))
    # Free-form tag list, e.g. ["theft", "case-42"].
    tags: Mapped[list] = mapped_column(JSON, nullable=False, server_default=text("'[]'"))

    created_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
