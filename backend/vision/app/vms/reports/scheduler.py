"""Report scheduler (P6-B) — due ReportSchedules → compute → notify.request.

Estate-wide lifespan background task (started in ``app.main`` like the health sampler /
recording scheduler). Each cycle it claims every ENABLED schedule whose ``next_run_at`` is
due, computes its report over the cadence's trailing window, renders a small artefact
(CSV inline, or a link for PDF), and publishes ``tenant.<id>.notify.request`` on the NATS
spine — the same channel-agnostic notify path P5-B linkage uses — for the workflow /
notifier connector to fan out (email / webhook). It then advances ``next_run_at`` +
records ``last_run_at`` / ``run_count`` (or ``last_error`` on a compute failure).

Discipline mirrors the recording scheduler: own DB session per cycle; a cancellable
``stop()``; per-cycle transient backoff; GRACEFUL (one bad schedule → ``last_error`` +
advance, never crashes the loop). Runs under a platform scope to service every tenant's
schedules, but each report is COMPUTED in that schedule's own tenant scope (never leaks
cross-tenant data). Best-effort notify (a down NATS just logs).
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kernel.auth import Scope

from app.vms.common.events import emit_notify_request
from app.vms.models import ReportSchedule

from .computations import compute_report
from .render import PdfUnavailable, to_csv, to_pdf
from .service import cadence_window, compute_next_run

log = logging.getLogger("vision.report_scheduler")

# Cap the inline-attachment size published on the notify request (large reports link out).
_MAX_INLINE_BYTES = 256 * 1024


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


def interval_sec() -> int:
    return max(15, _env_int("VE_REPORT_SCHEDULE_INTERVAL_SEC", 60))


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ReportScheduler:
    """Estate-wide due-report driver → notify.request. Started in ``app.main`` lifespan."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker
        self._task: asyncio.Task | None = None
        self._running = False

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        log.info("report scheduler started (interval=%ss)", interval_sec())

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        log.info("report scheduler stopped")

    async def _loop(self) -> None:
        try:
            await asyncio.sleep(min(8, interval_sec()))
        except asyncio.CancelledError:
            return
        backoff = interval_sec()
        while self._running:
            try:
                await self.run_cycle()
                backoff = interval_sec()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — one bad cycle must not kill the loop
                backoff = min(backoff * 2, 300)
                log.warning("report scheduler cycle error (%s) — backing off %ss", exc, backoff)
            try:
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                return

    async def run_cycle(self, *, now: datetime | None = None) -> int:
        """Fire every due enabled schedule. Returns how many fired (handy for tests)."""
        now = now or _utcnow()
        fired = 0
        async with self._sessionmaker() as db:
            due = (
                await db.execute(
                    select(ReportSchedule)
                    .where(ReportSchedule.enabled.is_(True))
                    .where(
                        (ReportSchedule.next_run_at.is_(None))
                        | (ReportSchedule.next_run_at <= now)
                    )
                    .order_by(ReportSchedule.next_run_at.asc())
                )
            ).scalars().all()
            for sched in due:
                if await self._fire(db, sched, now):
                    fired += 1
            await db.commit()
        return fired

    async def _fire(self, db: AsyncSession, sched: ReportSchedule, now: datetime) -> bool:
        """Compute + notify one schedule; advance its next_run_at. Never raises."""
        scope = Scope(tenant_id=sched.tenant_id, is_superadmin=False)
        from_, to = cadence_window(sched.cadence, now)
        camera_id = (sched.filters or {}).get("camera_id")
        try:
            report = await compute_report(sched.kind, db, scope, from_, to, camera_id)
        except Exception as exc:  # noqa: BLE001 — a bad report just records + advances
            sched.last_error = f"compute failed: {exc}"[:1024]
            sched.next_run_at = compute_next_run(sched.cadence, sched.hour_utc, now=now)
            log.warning("report schedule %s compute failed: %s", sched.id, exc)
            return False

        attachment = self._render_attachment(sched, report)
        payload = {
            "channel": sched.channel or "email",
            "targets": list(sched.recipients or []),
            "subject": f"VMS Report: {sched.name}",
            "body": (
                f"Scheduled {sched.kind} report ({sched.cadence}) for window "
                f"{report.get('window', {}).get('from')} → {report.get('window', {}).get('to')}."
            ),
            "report_kind": sched.kind,
            "report_totals": report.get("totals", {}),
            "schedule_id": sched.id,
            "config": {"cadence": sched.cadence, "format": sched.export_format},
            **attachment,
        }
        try:
            subj = await emit_notify_request(sched.tenant_id, payload)
            log.info("report schedule %s fired → notify.request on %s", sched.id, subj)
        except Exception as exc:  # noqa: BLE001 — notify is best-effort
            log.warning("report schedule %s notify failed: %s", sched.id, exc)

        sched.last_run_at = now
        sched.last_error = None
        sched.run_count = (sched.run_count or 0) + 1
        sched.next_run_at = compute_next_run(sched.cadence, sched.hour_utc, now=now)
        return True

    def _render_attachment(self, sched: ReportSchedule, report: dict) -> dict:
        """Render the report to the schedule's format → an inline (base64) attachment.

        CSV/JSON are inlined (small); PDF is inlined when reportlab is present, else the
        notify falls back to CSV. Oversized artefacts are truncated with a note (a real
        deploy would upload + link; the notify request carries enough to regenerate).
        """
        fmt = sched.export_format or "csv"
        try:
            if fmt == "pdf":
                data = to_pdf(report)
                mime = "application/pdf"
            elif fmt == "json":
                import json

                data = json.dumps(report, default=str).encode("utf-8")
                mime = "application/json"
            else:
                data = to_csv(report)
                mime = "text/csv"
        except PdfUnavailable:
            data = to_csv(report)
            mime = "text/csv"
            fmt = "csv"
        truncated = len(data) > _MAX_INLINE_BYTES
        if truncated:
            data = data[:_MAX_INLINE_BYTES]
        return {
            "attachment": {
                "filename": f"{sched.kind}-report.{fmt if fmt != 'json' else 'json'}",
                "mime": mime,
                "content_b64": base64.b64encode(data).decode("ascii"),
                "truncated": truncated,
            }
        }
