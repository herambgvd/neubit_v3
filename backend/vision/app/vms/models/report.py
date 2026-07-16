"""ReportSchedule — a recurring operational report delivered via the notify path (P6-B).

An operator asks vision to generate an operational report (camera-uptime,
recording-coverage, storage-usage, event-stats, health-summary) on a **cadence**
(daily / weekly / monthly) and fan it out to recipients. The report SCHEDULER
(``app.main`` lifespan background task) evaluates due schedules each tick, computes the
report over its rolling window + filters, and publishes a ``tenant.<id>.notify.request``
on the NATS spine (the same channel-agnostic notify path P5-B linkage uses) with the
report attached/linked — the workflow/notifier connector fans it out (email / webhook).

Tenant-scoped (nullable ``tenant_id``); plain-string ``kind`` / ``cadence`` /
``export_format`` (NO PG enum — asyncpg add-column enum footgun, project memory). Filters
(``camera_id`` etc.) + recipients ride JSON blobs so the shape stays open.

⭐ Migration gotcha: this module MUST be imported in ``app.vms.models.__init__`` (so it
registers on ``Base.metadata``), which is imported by BOTH ``migrations/env.py`` AND
``0001_vision_baseline._tables()`` — a table whose module is not imported in both is
silently dropped on a fresh deploy. ``0010_report_schedules`` lands it on deployed DBs.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Index,
    Integer,
    String,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from ._common import _utcnow, _uuid_str


class ReportSchedule(Base):
    """A recurring operational report (kind + cadence + recipients + filters)."""

    __tablename__ = "report_schedules"
    __table_args__ = (
        # The scheduler scans enabled schedules estate-wide by next_run_at; browse is
        # by tenant + recency.
        Index("ix_report_schedules_enabled_next", "enabled", "next_run_at"),
        Index("ix_report_schedules_tenant_created", "tenant_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # --- multi-tenancy: owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    name: Mapped[str] = mapped_column(String(150), nullable=False)
    # camera-uptime | recording-coverage | storage-usage | event-stats | health-summary
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    # daily | weekly | monthly (plain string, no PG enum). Window length derives from this.
    cadence: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'daily'")
    )
    # json | csv | pdf — the attached report format the notify request references.
    export_format: Mapped[str] = mapped_column(
        String(8), nullable=False, server_default=text("'csv'")
    )

    # Recipients (opaque targets the notifier resolves): ["ops@x.com", ...].
    recipients: Mapped[list] = mapped_column(JSON, nullable=False, server_default=text("'[]'"))
    # Report filters (e.g. {"camera_id": "…"}); merged into the computation call.
    filters: Mapped[dict] = mapped_column(JSON, nullable=False, server_default=text("'{}'"))
    # Notify channel (email | webhook | ...); passed through on the notify request.
    channel: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=text("'email'")
    )

    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    # Hour-of-day (UTC) the report should fire at (0..23); the scheduler fires the first
    # tick at/after this hour once per cadence period.
    hour_utc: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("6")
    )

    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(String(1024))
    run_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))

    created_by: Mapped[str | None] = mapped_column(String(64))
    updated_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class ReportRun(Base):
    """One PERSISTED run of a report — a history row + a rendered artefact on disk.

    Every fired schedule (and, later, any ad-hoc "run now") lands a ``ReportRun``: the
    scheduler renders the report to bytes ONCE, writes it under the downloads volume
    (``output_path``), and records the run here so past reports have history + a
    downloadable file (large reports that used to be truncated at the 256 KB inline cap
    are now kept in full on disk). ``schedule_id`` is nullable so an ad-hoc run without a
    schedule is representable; ``status`` is ``done`` | ``error`` (a compute failure still
    records a row so failures surface in history).
    """

    __tablename__ = "report_runs"
    __table_args__ = (
        # History for a given schedule, newest-first; and a tenant-wide recency browse.
        Index("ix_report_runs_schedule_computed", "schedule_id", "computed_at"),
        Index("ix_report_runs_tenant_computed", "tenant_id", "computed_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # The owning ReportSchedule (NULL = ad-hoc / run-now without a schedule).
    schedule_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # --- multi-tenancy: owning tenant (NULL = platform/super-admin/system). ---
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    name: Mapped[str] = mapped_column(String(150), nullable=False)
    # camera-uptime | recording-coverage | storage-usage | event-stats | health-summary
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    # daily | weekly | monthly (snapshot of the schedule's cadence; NULL for ad-hoc).
    cadence: Mapped[str | None] = mapped_column(String(16))
    # json | csv | pdf — the format the artefact was rendered to.
    export_format: Mapped[str] = mapped_column(
        String(8), nullable=False, server_default=text("'csv'")
    )
    # The rolling window the report covered: {"from": iso, "to": iso}.
    window: Mapped[dict] = mapped_column(JSON, nullable=False, server_default=text("'{}'"))

    # Path of the rendered artefact on the downloads volume (NULL on compute error).
    output_path: Mapped[str | None] = mapped_column(String(1024))
    output_size: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))

    # done | error (plain string, no PG enum).
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'done'")
    )
    error: Mapped[str | None] = mapped_column(String(1024))

    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
