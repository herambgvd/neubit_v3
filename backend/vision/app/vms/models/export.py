"""ExportJob — one clip-export request (concat recorded fmp4 → downloadable mp4), P4-B.

An operator asks vision to export a time-window of a camera's recorded footage into a
single downloadable mp4 (``POST /cameras/{id}/export``). vision resolves the covered
``Recording`` fmp4 segments, creates a QUEUED ``ExportJob`` row, and an export worker
(``app.main`` lifespan background task) concatenates/remuxes them with ffmpeg
(``-c copy`` fast path when codecs allow) into the downloads area, flipping the job to
``done`` (+ ``file_path``/``file_size``) or ``failed`` (+ ``error``).

Tenant-scoped (nullable ``tenant_id``); plain-string ``status``/``format`` (NO PG enum —
asyncpg add-column enum footgun, project memory). Follows the ``Recording`` model
conventions (string PK, ``_utcnow``/``_uuid_str`` helpers, tenant-first index).

⭐ Migration gotcha: this module MUST be imported in BOTH ``migrations/env.py`` (via the
``app.vms.models`` package __init__) AND the ``0001_vision_baseline._tables()`` sweep, or
the ``export_jobs`` table is silently dropped on a fresh deploy. ``0007_export_jobs``
lands it on already-deployed DBs.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    String,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from ._common import _utcnow, _uuid_str


class ExportJob(Base):
    """A clip-export job (concat recorded segments → one mp4), tenant-scoped."""

    __tablename__ = "export_jobs"
    __table_args__ = (
        # The worker polls queued jobs oldest-first; browse is by tenant + recency.
        Index("ix_export_jobs_status_created", "status", "created_at"),
        Index("ix_export_jobs_tenant_created", "tenant_id", "created_at"),
        Index("ix_export_jobs_camera", "camera_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    camera_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("cameras.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    from_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    to_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    # Container format of the produced clip (mp4 only in P4-B; plain string, no enum).
    format: Mapped[str] = mapped_column(
        String(8), nullable=False, server_default=text("'mp4'")
    )

    # queued | running | done | failed (plain string, no PG enum).
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'queued'"), index=True
    )

    # The produced clip's absolute path (in the downloads area) + its size, once done.
    file_path: Mapped[str | None] = mapped_column(String(1024))
    file_size: Mapped[int | None] = mapped_column(BigInteger)  # bytes
    error: Mapped[str | None] = mapped_column(String(2048))

    # --- Tamper-evident signing (P6-B; nullable — filled by the worker on success). ---
    # SHA-256 (hex) of the produced clip; the Ed25519 signature over the manifest
    # (base64); and the absolute path of the ``<job>.manifest.json`` sidecar. Together
    # they make the export court-admissible: re-hash + verify proves no tampering.
    checksum: Mapped[str | None] = mapped_column(String(64))  # SHA-256 hex
    signature: Mapped[str | None] = mapped_column(String(128))  # base64 Ed25519 sig
    manifest_path: Mapped[str | None] = mapped_column(String(1024))
    # Whether the clip was re-encoded with a visible drawtext watermark (site/cam/time).
    watermark: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )

    requested_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
