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
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kernel.auth import Scope

from app.vms.common.events import emit_notify_request
from app.vms.export.worker import downloads_dir
from app.vms.models import ReportRun, ReportSchedule

from .computations import compute_report
from .render import PdfUnavailable, to_csv, to_pdf
from .service import cadence_window, compute_next_run

log = logging.getLogger("vision.report_scheduler")

# Cap the inline-attachment size published on the notify request (large reports link out;
# the FULL artefact is always written to disk + recorded on the ReportRun, so nothing is
# lost — only the base64 payload rides truncated).
_MAX_INLINE_BYTES = 256 * 1024

# Per-format artefact extension.
_EXT = {"pdf": "pdf", "json": "json", "csv": "csv"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


def interval_sec() -> int:
    return max(15, _env_int("VE_REPORT_SCHEDULE_INTERVAL_SEC", 60))


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _uuid_str() -> str:
    return str(uuid.uuid4())


def reports_dir(tenant_id: uuid.UUID | None, schedule_id: str | None) -> str:
    """Directory a report artefact is written under, on the shared downloads volume.

    Mirrors the clip-export root (``app.vms.export.worker.downloads_dir``) so reports ride
    the same pooled volume as export clips (no extra mount):
    ``<downloads>/tenant/<tenant_id or 'platform'>/reports/<schedule_id or 'adhoc'>``.
    """
    tenant = str(tenant_id) if tenant_id else "platform"
    sched = schedule_id or "adhoc"
    return os.path.join(downloads_dir(), "tenant", tenant, "reports", sched)


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
        """Loop entrypoint: run one schedule + advance its next_run_at. Never raises.

        Thin wrapper over :meth:`run_schedule_now` — it does the compute/render/persist/
        notify; here we advance the schedule bookkeeping (last_run_at / run_count /
        next_run_at / last_error). Returns True on a successful compute.
        """
        run = await self.run_schedule_now(db, sched, now)
        sched.next_run_at = compute_next_run(sched.cadence, sched.hour_utc, now=now)
        if run is not None and run.status == "done":
            sched.last_run_at = now
            sched.last_error = None
            sched.run_count = (sched.run_count or 0) + 1
            return True
        if run is not None and run.status == "error":
            sched.last_error = (run.error or "compute failed")[:1024]
        return False

    async def run_schedule_now(
        self, db: AsyncSession, sched: ReportSchedule, now: datetime
    ) -> ReportRun | None:
        """Compute → render-once → write-to-disk + persist a ReportRun → notify.

        The reusable "fire one schedule now" entrypoint (the loop AND a future "run now"
        endpoint both call this). Best-effort/graceful throughout: a compute failure
        records an ``error`` ReportRun (so failures show in history); a persist/notify
        failure just logs. Returns the created ReportRun (``None`` only if even recording
        the error row failed). Does NOT touch schedule bookkeeping / next_run_at — that's
        the caller's job (``_fire`` for the loop).
        """
        scope = Scope(tenant_id=sched.tenant_id, is_superadmin=False)
        from_, to = cadence_window(sched.cadence, now)
        camera_id = (sched.filters or {}).get("camera_id")
        window = {"from": from_.isoformat(), "to": to.isoformat()}

        # --- compute ---------------------------------------------------------------
        try:
            report = await compute_report(sched.kind, db, scope, from_, to, camera_id)
        except Exception as exc:  # noqa: BLE001 — a bad report records an error row
            log.warning("report schedule %s compute failed: %s", sched.id, exc)
            return self._persist_run(
                db, sched, window, status="error",
                error=f"compute failed: {exc}", now=now,
            )

        # --- render ONCE → bytes reused for both the file + the inline attachment ---
        data, mime, ext = self._render_report(sched.export_format, report)

        # --- write the FULL artefact to the downloads volume -----------------------
        output_path: str | None = None
        output_size = 0
        run_id = _uuid_str()
        try:
            out_dir = reports_dir(sched.tenant_id, sched.id)
            os.makedirs(out_dir, exist_ok=True)
            output_path = os.path.join(out_dir, f"{run_id}.{ext}")
            with open(output_path, "wb") as fh:
                fh.write(data)
            output_size = len(data)
        except Exception as exc:  # noqa: BLE001 — a write failure must not lose the run
            log.warning("report schedule %s file write failed: %s", sched.id, exc)
            output_path = None

        # --- persist the run (status=done) -----------------------------------------
        run = self._persist_run(
            db, sched, window, status="done", error=None, now=now,
            run_id=run_id, output_path=output_path, output_size=output_size,
        )

        # --- notify (inline attachment reuses the SAME rendered bytes) -------------
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
            "run_id": run_id,
            "config": {
                "cadence": sched.cadence,
                "format": sched.export_format,
                "run_id": run_id,
            },
            **self._inline_attachment(sched, data, mime, ext),
        }
        try:
            subj = await emit_notify_request(sched.tenant_id, payload)
            log.info("report schedule %s fired → notify.request on %s", sched.id, subj)
            if run is not None:
                run.notified_at = now
        except Exception as exc:  # noqa: BLE001 — notify is best-effort
            log.warning("report schedule %s notify failed: %s", sched.id, exc)
        return run

    def _persist_run(
        self,
        db: AsyncSession,
        sched: ReportSchedule,
        window: dict,
        *,
        status: str,
        error: str | None,
        now: datetime,
        run_id: str | None = None,
        output_path: str | None = None,
        output_size: int = 0,
    ) -> ReportRun | None:
        """Add a ReportRun row to the session (committed by the cycle). Never raises."""
        try:
            run = ReportRun(
                id=run_id or _uuid_str(),
                schedule_id=sched.id,
                tenant_id=sched.tenant_id,
                name=sched.name,
                kind=sched.kind,
                cadence=sched.cadence,
                export_format=sched.export_format or "csv",
                window=window,
                output_path=output_path,
                output_size=output_size,
                status=status,
                error=(error[:1024] if error else None),
                computed_at=now,
            )
            db.add(run)
            return run
        except Exception as exc:  # noqa: BLE001 — persistence must not crash the loop
            log.warning("report schedule %s run-persist failed: %s", sched.id, exc)
            return None

    def _render_report(self, export_format: str | None, report: dict) -> tuple[bytes, str, str]:
        """Render the report to RAW bytes ONCE → (data, mime, ext).

        Reused for BOTH the on-disk artefact and the inline base64 attachment. CSV/JSON
        render inline; PDF renders when reportlab is present, else falls back to CSV.
        """
        fmt = export_format or "csv"
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
        return data, mime, _EXT.get(fmt, "csv")

    def _inline_attachment(
        self, sched: ReportSchedule, data: bytes, mime: str, ext: str
    ) -> dict:
        """The notify request's inline (base64) attachment — reuses the rendered bytes.

        Oversized artefacts are truncated in the inline payload (the FULL artefact is on
        disk + on the ReportRun); shape is unchanged so the notifier/email keep working.
        """
        truncated = len(data) > _MAX_INLINE_BYTES
        inline = data[:_MAX_INLINE_BYTES] if truncated else data
        return {
            "attachment": {
                "filename": f"{sched.kind}-report.{ext}",
                "mime": mime,
                "content_b64": base64.b64encode(inline).decode("ascii"),
                "truncated": truncated,
            }
        }
