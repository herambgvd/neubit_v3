"""Celery-beat scheduled cleanup: expired reset tokens, old report exports, audit rows.

    celery -A edge.tasks.app.celery_app worker -l info
    celery -A edge.tasks.app.celery_app beat -l info      # fires the schedule below

Celery tasks are synchronous, so DB access uses the sync session from
:func:`edge.tasks.base.get_sync_session`, not the app's AsyncSession. The object
store is async-only, so storage deletes are bridged with ``asyncio.run(...)`` —
fine at housekeeping cadence, not on a hot path.
"""

from __future__ import annotations

import asyncio
import datetime as dt

from celery.schedules import crontab

from ..core.config import get_settings  # noqa: F401  (kept for scenarios that tune retention via settings)
from ..core.logging import get_logger
from ..core.storage import get_storage
from .base import celery_app, get_sync_session, task

log = get_logger("edge.retention")


def _utcnow() -> dt.datetime:
    """Timezone-aware "now" so comparisons match the DateTime(timezone=True) columns."""
    return dt.datetime.now(dt.timezone.utc)


@task
def cleanup_expired_reset_tokens() -> int:
    """Delete every password-reset token whose expiry is in the past.

    Returns the number of rows deleted.
    """
    # Imported lazily so importing this module does not drag the auth models (and
    # their table registration) into the web process.
    from app.auth.models import PasswordResetToken

    now = _utcnow()
    with get_sync_session() as db:
        # Bulk DELETE; synchronize_session=False avoids per-row ORM churn.
        deleted = (
            db.query(PasswordResetToken)
            .filter(PasswordResetToken.expires_at < now)
            .delete(synchronize_session=False)
        )
        db.commit()

    log.info("cleanup_expired_reset_tokens: deleted %d expired token(s)", deleted)
    return deleted


@task
def cleanup_old_reports(days: int = 30) -> int:
    """Delete report jobs older than ``days`` — DB rows and their stored exports.

    Deletes the blob at ``ReportJob.result_key`` before the row, so nothing is
    orphaned. Returns the number of rows deleted.
    """
    from app.reports.models import ReportJob

    cutoff = _utcnow() - dt.timedelta(days=days)
    storage = get_storage()
    deleted = 0

    with get_sync_session() as db:
        # Fetch rows first so each blob can be cleaned up before its row goes.
        stale = db.query(ReportJob).filter(ReportJob.created_at < cutoff).all()
        for job in stale:
            if job.result_key:
                try:
                    # Storage is async-only; bridge it with a throwaway event loop.
                    asyncio.run(storage.delete(job.result_key))
                except Exception:  # noqa: BLE001 — one bad blob must not abort the sweep
                    log.warning(
                        "cleanup_old_reports: failed to delete blob %s", job.result_key
                    )
            db.delete(job)
            deleted += 1
        db.commit()

    log.info(
        "cleanup_old_reports: deleted %d report(s) older than %d day(s)", deleted, days
    )
    return deleted


@task
def cleanup_old_audit(days: int | None = None) -> int:
    """Delete audit entries older than the configured retention window.

    ``days`` is read from the ``audit_retention_days`` system setting when not
    passed. A value of 0 (or missing) means "keep forever" → nothing is deleted.
    Returns the number of audit rows removed.
    """
    from app.core.audit import AuditLog
    from app.settings.models import AppSetting

    with get_sync_session() as db:
        if days is None:
            row = db.get(AppSetting, "audit_retention_days")
            try:
                days = int(row.value) if row and row.value is not None else 0
            except (TypeError, ValueError):
                days = 0
        if not days or days <= 0:
            return 0
        cutoff = _utcnow() - dt.timedelta(days=days)
        deleted = (
            db.query(AuditLog).filter(AuditLog.ts < cutoff).delete(synchronize_session=False)
        )
        db.commit()

    log.info("cleanup_old_audit: deleted %d entr(ies) older than %d day(s)", deleted, days)
    return deleted


@task
def enforce_storage_cap() -> None:
    """Stub: evict oldest artifacts once storage exceeds the license's ``storage_gb``.

    Unfinished because the worker holds no verified License (the web app loads it
    at startup). To wire up: surface the cap to the worker via a settings row/env
    var or ``edge.core.license.load_license(get_settings())``; sum blob sizes for
    usage; then compare against ``edge.core.limits.storage_within_cap`` and delete
    oldest artifacts via ``asyncio.run(get_storage().delete(key))`` until under.
    """
    log.info(
        "enforce_storage_cap: TODO: measure storage usage vs license storage_gb "
        "and evict oldest artifacts"
    )


# --- Celery-beat schedule ----------------------------------------------------
# Registered onto the shared celery_app at import time by register_beat() below.
BEAT_SCHEDULE = {
    # Reset tokens churn quickly; prune hourly.
    "cleanup-expired-reset-tokens": {
        "task": "edge.tasks.retention.cleanup_expired_reset_tokens",
        "schedule": crontab(minute=0),  # top of every hour
        "args": (),
    },
    # Report exports move slowly; a daily sweep is plenty.
    "cleanup-old-reports": {
        "task": "edge.tasks.retention.cleanup_old_reports",
        "schedule": crontab(hour=3, minute=30),  # 03:30 UTC daily
        "args": (),
    },
    # Enforce audit_retention_days daily; no-op unless an admin sets a positive window.
    "cleanup-old-audit": {
        "task": "edge.tasks.retention.cleanup_old_audit",
        "schedule": crontab(hour=3, minute=45),  # 03:45 UTC daily
        "args": (),
    },
}


def register_beat(app=celery_app):
    """Merge BEAT_SCHEDULE into the app's beat schedule.

    Merges rather than overwrites so periodic jobs registered by other modules
    survive.
    """
    existing = getattr(app.conf, "beat_schedule", None) or {}
    app.conf.beat_schedule = {**existing, **BEAT_SCHEDULE}


# Arm the schedule on import so `celery ... beat` sees these tasks with no extra wiring.
register_beat()
