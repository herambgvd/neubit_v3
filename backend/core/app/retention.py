"""Core's housekeeping sweeps: reset tokens, report exports, audit entries.

These three purges existed as Celery tasks (``app/tasks/retention.py``) with a
beat schedule armed at import, and NONE of them had ever run. Three independent
reasons, each sufficient on its own:

  * there is no core worker and no core beat process in the deployment;
  * the Celery app's ``include`` named an ``edge`` package that does not exist, so
    a worker would have died at finalization with ModuleNotFoundError;
  * and the schedule asked for ``edge.tasks.retention.*`` while the tasks
    registered as ``app.tasks.retention.*``, so every tick would have NAK'd as
    unregistered.

Adding the missing worker would have introduced a live bug rather than fixed one:
core's Celery app and workflow's share one Redis database and the DEFAULT queue,
so the first core task enqueued would be picked up by ``workflow-worker`` — the
container that drives every incident escalation in the estate.

So the sweeps run in core's own lifespan instead, like ``ingest``'s event-log
purge and ``vision``'s health/event purge: one ``asyncio.create_task`` started at
startup, cancelled on shutdown, each purge batched so it cannot hold a long lock.
A sweeper you have to remember to deploy is a sweeper that does not run.

Config (env, ``VE_`` prefix):
  * ``VE_CORE_RETENTION_SWEEP_SEC``  — seconds between cycles (default 3600).
  * ``VE_REPORT_RETENTION_DAYS``     — report-export window (default 30).

The audit window is NOT an env var: it is the per-tenant ``audit_retention_days``
setting an admin sets on the Settings screen, and 0 (the default) means keep
forever. See :func:`purge_audit`.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import os
import uuid

from sqlalchemy import delete, or_, select

log = logging.getLogger("core.retention")

#: How long a produced export is kept. An export is DERIVED data — the report can
#: be run again — so the window is about disk and about not leaving a tenant's
#: figures in the object store indefinitely, not about evidence.
REPORT_RETENTION_DAYS = int(os.getenv("VE_REPORT_RETENTION_DAYS", "30"))

#: How often to sweep. Hourly: reset tokens are the only thing that churns faster
#: than daily, and they are short-lived rather than numerous.
SWEEP_INTERVAL_SEC = int(os.getenv("VE_CORE_RETENTION_SWEEP_SEC", "3600"))

#: Rows per statement, so one purge cannot hold a long lock on a live table.
#: audit_log is the reason this exists: a first sweep after an operator finally
#: sets a window can be millions of rows.
BATCH = 5_000

AUDIT_RETENTION_KEY = "audit_retention_days"


def _utcnow() -> dt.datetime:
    """Timezone-aware "now", matching the DateTime(timezone=True) columns."""
    return dt.datetime.now(dt.timezone.utc)


async def _delete_in_batches(sessionmaker, model, *where) -> int:
    """Delete every row matching ``where``, BATCH at a time. Returns rows removed.

    Selects ids first and deletes by id: a bare ``DELETE ... LIMIT`` is not
    portable (SQLite builds without ENABLE_UPDATE_DELETE_LIMIT reject it, and
    Postgres has never had it), and each batch commits on its own so an
    interrupted sweep keeps the work it has already done.
    """
    removed = 0
    while True:
        async with sessionmaker() as db:
            ids = (
                await db.execute(select(model.id).where(*where).limit(BATCH))
            ).scalars().all()
            if not ids:
                return removed
            await db.execute(delete(model).where(model.id.in_(ids)))
            await db.commit()
            removed += len(ids)
        if len(ids) < BATCH:
            return removed


async def purge_expired_reset_tokens(sessionmaker) -> int:
    """Delete every password-reset token whose expiry has passed.

    Imported lazily, here and below, so importing this module does not drag every
    model into whatever imports it.
    """
    from .auth.models import PasswordResetToken

    return await _delete_in_batches(
        sessionmaker, PasswordResetToken, PasswordResetToken.expires_at < _utcnow()
    )


async def purge_old_reports(sessionmaker, days: int | None = None) -> int:
    """Delete report jobs older than the window — the stored export, then the row.

    The blob goes FIRST: delete the row first and the storage key is gone with it,
    which is precisely how the object store came to hold exports nothing points
    at. A blob that will not delete is logged and its row is kept, so the next
    sweep tries again rather than orphaning it.
    """
    from .core.storage import get_storage
    from .reports.models import ReportJob

    window = REPORT_RETENTION_DAYS if days is None else days
    if window <= 0:
        return 0
    cutoff = _utcnow() - dt.timedelta(days=window)
    storage = get_storage()
    removed = 0

    while True:
        async with sessionmaker() as db:
            rows = (
                await db.execute(
                    select(ReportJob.id, ReportJob.result_key)
                    .where(ReportJob.created_at < cutoff)
                    .limit(BATCH)
                )
            ).all()
            if not rows:
                return removed
            deletable: list[uuid.UUID] = []
            for job_id, result_key in rows:
                if result_key:
                    try:
                        await storage.delete(result_key)
                    except Exception:  # noqa: BLE001 — one bad blob is not the sweep
                        log.warning(
                            "retention: keeping report %s; its export %s would not delete",
                            job_id,
                            result_key,
                        )
                        continue
                deletable.append(job_id)
            if not deletable:
                return removed
            await db.execute(delete(ReportJob).where(ReportJob.id.in_(deletable)))
            await db.commit()
            removed += len(deletable)
        if len(rows) < BATCH:
            return removed


def _days(value: object) -> int:
    """A settings value as a window in days; anything unreadable means 0 (keep)."""
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0


async def purge_audit(sessionmaker, days: int | None = None) -> int:
    """Delete audit entries older than the configured retention window.

    PER TENANT. ``audit_retention_days`` is a per-tenant setting with a
    platform-default row (tenant_id NULL) behind it, so each tenant's trail is
    purged on its OWN window and a tenant that chose "keep forever" keeps
    everything — even when the platform default is 30 days. Deleting a record a
    tenant asked to keep is not recoverable, so the scope is not a detail.

    ``days``, when passed, overrides every policy and applies to all rows; that is
    the manual escape hatch and the only unscoped path.

    0 (or unset) means "keep forever" → nothing is deleted for that scope, and 0
    is the shipped default. That is deliberate: the audit log is the compliance
    trail, it is the evidence that a tenant erasure was performed at all
    (``tenancy/erasure.py`` retains it for exactly that reason), and this sweep
    has never run before. A non-zero default would mean the first startup after
    this change silently destroys years of trail that nobody asked it to destroy.
    Unbounded growth is visible and recoverable; a deleted audit trail is neither.

    The predecessor of this function read the setting with
    ``db.get(AppSetting, "audit_retention_days")``. ``Session.get`` takes a
    PRIMARY KEY and AppSetting's is a surrogate UUID ``id``, so it raised a
    StatementError rather than returning a window — one of the reasons to distrust
    the code this replaces rather than port it.
    """
    from .core.audit import AuditLog
    from .settings.models import AppSetting

    if days is not None:
        if days <= 0:
            return 0
        cutoff = _utcnow() - dt.timedelta(days=days)
        return await _delete_in_batches(sessionmaker, AuditLog, AuditLog.ts < cutoff)

    async with sessionmaker() as db:
        rows = (
            await db.execute(
                select(AppSetting.tenant_id, AppSetting.value).where(
                    AppSetting.key == AUDIT_RETENTION_KEY
                )
            )
        ).all()

    platform_days = 0
    per_tenant: dict = {}
    for tenant_id, value in rows:
        if tenant_id is None:
            platform_days = _days(value)
        else:
            per_tenant[tenant_id] = _days(value)

    deleted = 0
    # Each tenant that set its own window, on that window.
    for tenant_id, window in per_tenant.items():
        if window <= 0:
            continue
        cutoff = _utcnow() - dt.timedelta(days=window)
        deleted += await _delete_in_batches(
            sessionmaker,
            AuditLog,
            AuditLog.tenant_id == tenant_id,
            AuditLog.ts < cutoff,
        )

    # Everything else — platform rows and tenants with no override — on the
    # platform default. `notin_` cannot match a NULL tenant_id, so those rows are
    # selected explicitly rather than left out by accident.
    if platform_days > 0:
        cutoff = _utcnow() - dt.timedelta(days=platform_days)
        where = [AuditLog.ts < cutoff]
        if per_tenant:
            where.append(
                or_(
                    AuditLog.tenant_id.is_(None),
                    AuditLog.tenant_id.notin_(list(per_tenant)),
                )
            )
        deleted += await _delete_in_batches(sessionmaker, AuditLog, *where)

    return deleted


async def sweep_once(sessionmaker) -> dict[str, int]:
    """Run all three purges once. Returns {what: rows removed}."""
    return {
        "reset_tokens": await purge_expired_reset_tokens(sessionmaker),
        "reports": await purge_old_reports(sessionmaker),
        "audit": await purge_audit(sessionmaker),
    }


async def sweep_forever(sessionmaker) -> None:
    """Sweep on a loop. Never raises — a failed sweep must not stop the service."""
    while True:
        try:
            removed = await sweep_once(sessionmaker)
            if any(removed.values()):
                log.info(
                    "retention: pruned %d reset token(s), %d report(s), %d audit entr(ies)",
                    removed["reset_tokens"],
                    removed["reports"],
                    removed["audit"],
                )
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("retention sweep failed; retrying next interval")
        await asyncio.sleep(SWEEP_INTERVAL_SEC)
