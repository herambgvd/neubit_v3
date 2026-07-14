"""MotionSearchJob — one forensic (non-AI) motion-search request over recordings, G4.

An investigator asks vision to find MOTION inside one or more drawn rectangular
regions of a camera's recorded footage over a time window (Milestone "Smart Search"
style — pure ffmpeg VMD, NO AI). vision resolves the covered ``Recording`` fmp4
segments, creates a QUEUED ``MotionSearchJob`` row, and the ``MotionSearchWorker``
(``app.main`` lifespan background task) crops each region + runs an ffmpeg scene/
motion filter over the covering segments, thresholds the per-timestamp motion scores
into HIT INTERVALS, and flips the job to ``done`` (+ ``hits`` JSON) or ``failed``
(+ ``error``). It degrades gracefully — a missing segment / ffmpeg failure yields a
partial result + a ``note`` rather than crashing the worker.

Region rectangles are stored NORMALIZED (0..1 of the frame, x/y/w/h) so a search is
resolution-independent (the worker scales them to pixels per segment via the
recorded resolution / ffmpeg's ``iw``/``ih``). Tenant-scoped (nullable ``tenant_id``);
plain-string ``status`` (NO PG enum — asyncpg add-column enum footgun, project
memory). Mirrors the ``ExportJob`` conventions (string PK, ``_utcnow``/``_uuid_str``,
tenant-first index, worker-poll index).

⭐ Migration gotcha (project memory): this module MUST be imported in BOTH
``migrations/env.py`` (via the ``app.vms.models`` package __init__) AND the
``0001_vision_baseline._tables()`` sweep, or ``motion_search_jobs`` is silently
dropped on a fresh deploy. ``0016_motion_search`` lands it on already-deployed DBs.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from ._common import _utcnow, _uuid_str


class MotionSearchJob(Base):
    """A forensic motion-search job (VMD over recorded segments), tenant-scoped."""

    __tablename__ = "motion_search_jobs"
    __table_args__ = (
        # The worker polls queued jobs oldest-first; browse is by tenant + recency.
        Index("ix_motion_search_status_created", "status", "created_at"),
        Index("ix_motion_search_tenant_created", "tenant_id", "created_at"),
        Index("ix_motion_search_camera", "camera_id"),
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

    # Region rectangles: a JSON list of {x,y,w,h} NORMALIZED to 0..1 of the frame.
    # A search over the whole frame is a single {x:0,y:0,w:1,h:1}.
    regions: Mapped[list] = mapped_column(
        JSON, nullable=False, server_default=text("'[]'")
    )
    # Motion sensitivity 0..1 (higher = more sensitive → lower scene-change threshold).
    # The worker maps it to the ffmpeg scene threshold; default is a mid value.
    sensitivity: Mapped[float] = mapped_column(
        Float, nullable=False, server_default=text("0.5")
    )
    # Analysis sample rate (fps the worker decodes the crop at; capped by the worker).
    sample_fps: Mapped[float] = mapped_column(
        Float, nullable=False, server_default=text("4.0")
    )

    # queued | running | done | failed (plain string, no PG enum).
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'queued'"), index=True
    )
    # 0..100 coarse progress (segments analyzed / total) for the polling UI.
    progress: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )

    # The result: a JSON list of {start, end, score} hit intervals (absolute ISO times,
    # score 0..1). Filled by the worker on success; empty list = analyzed, no motion.
    hits: Mapped[list] = mapped_column(JSON, nullable=False, server_default=text("'[]'"))
    # A best-effort human note (e.g. "window truncated to cap", "2 segments missing").
    note: Mapped[str | None] = mapped_column(String(1024))
    error: Mapped[str | None] = mapped_column(String(2048))

    requested_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
