"""EvidenceLock model — legal-hold on a camera + time-range (G3).

A first-class legal-hold record: an active ``EvidenceLock`` protects EVERY recording
segment for ``camera_id`` whose time overlaps ``[start_ts, end_ts]`` from the retention
sweep's auto-deletion — for cases / court. It is a superset of the per-``Recording``
``locked`` boolean (``storage`` P3-B): a range lock also protects segments that arrive
AFTER the lock is placed (a still-recording window) and carries case/reason metadata
plus a soft-release audit trail.

The retention worker (``storage/worker.py``) resolves each candidate recording against
the active locks for its camera (``is_locked`` / the ``LockIndex`` helper) and SKIPS
any covered one, logging the skip. A released lock (``is_active=False`` / ``released_at``
set) no longer protects.

Tenant-scoped (nullable ``tenant_id``; NULL = platform/system row). Plain string / JSON
columns, NO PG enums (the asyncpg add-column enum footgun, project memory).

⭐ Migration gotcha (project memory): this module must be imported by BOTH
``migrations/env.py`` (via ``app.vms.models``) AND ``0001_vision_baseline._tables()``
AND landed on deployed DBs by ``0015_bookmarks_evidence`` — a model whose module is not
imported in all three is silently dropped on a fresh deploy.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Index,
    String,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from ._common import _utcnow, _uuid_str


class EvidenceLock(Base):
    """A legal hold protecting a camera's recordings over a time-range from deletion."""

    __tablename__ = "evidence_locks"
    __table_args__ = (
        # The retention sweep + the lock-check endpoint scan active locks by camera
        # (then filter by range in Python / SQL). A partial-friendly composite index.
        Index("ix_evidence_camera_active", "camera_id", "is_active"),
        Index("ix_evidence_tenant_active", "tenant_id", "is_active"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    camera_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)

    start_ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    end_ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    # Why the hold exists (free text) + an optional case/court reference for filing.
    reason: Mapped[str | None] = mapped_column(String(2000))
    case_ref: Mapped[str | None] = mapped_column(String(255), index=True)

    # is_active is the retention-exempt gate. Soft-release flips it False + stamps
    # released_at / released_by (the row is KEPT as an audit trail; DELETE is a hard
    # remove for a mistaken lock).
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true"), index=True
    )

    created_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    released_by: Mapped[str | None] = mapped_column(String(36))
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
