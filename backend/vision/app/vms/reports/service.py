"""Reports control-plane service (P6-B) — ad-hoc report reads + ReportSchedule CRUD.

Two responsibilities, both tenant-scoped (``kernel.auth.scoped`` / ``assert_owned``):
  * ``report`` — compute an ad-hoc report (dispatch to ``computations.compute_report``)
    for a [from, to] window + optional camera filter.
  * ReportSchedule CRUD — the recurring-report catalog the scheduler drains. On create/
    update it (re-)computes ``next_run_at`` from the cadence so the scheduler knows when
    to fire.

Discipline mirrors the storage/export services: reads go through ``scoped``; by-id goes
through ``assert_owned`` (404 cross-tenant); new rows are stamped with the caller's
``tenant_id``. GRACEFUL: an unknown kind → ValidationError (422); an empty window still
computes (zero rows).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ValidationError

from app.vms.models import ReportSchedule

from .computations import compute_report
from .schemas import ReportScheduleCreate, ReportScheduleUpdate

log = logging.getLogger("vision.reports_service")

# Cadence → rolling report window length (the report covers the trailing period) +
# the inter-fire interval.
_CADENCE_DELTA = {
    "daily": timedelta(days=1),
    "weekly": timedelta(days=7),
    "monthly": timedelta(days=30),
}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def cadence_window(cadence: str, now: datetime | None = None) -> tuple[datetime, datetime]:
    """The trailing [from, to] window a report of ``cadence`` should cover (to = now)."""
    now = now or _utcnow()
    return now - _CADENCE_DELTA.get(cadence, timedelta(days=1)), now


def compute_next_run(cadence: str, hour_utc: int, *, now: datetime | None = None) -> datetime:
    """The next fire time: the next occurrence of ``hour_utc`` at/after ``now`` on cadence.

    Daily → next day at ``hour_utc`` (or today if not yet past); weekly/monthly step the
    cadence delta from that anchor. Kept simple + UTC (per-site tz is a later refinement).
    """
    now = now or _utcnow()
    anchor = now.replace(hour=hour_utc, minute=0, second=0, microsecond=0)
    if anchor <= now:
        anchor = anchor + timedelta(days=1)
    delta = _CADENCE_DELTA.get(cadence, timedelta(days=1))
    if cadence in ("weekly", "monthly"):
        # First fire tomorrow-at-hour, then every ``delta`` thereafter (scheduler advances).
        return anchor + (delta - timedelta(days=1))
    return anchor


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


class ReportService:
    """Tenant-scoped ad-hoc report reads + ReportSchedule CRUD."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    # ── ad-hoc report ───────────────────────────────────────────────────
    async def report(
        self, kind: str, from_: datetime, to: datetime, camera_id: str | None = None
    ) -> dict:
        if to <= from_:
            raise ValidationError("empty report window (to must be after from)")
        try:
            return await compute_report(kind, self.db, self.scope, from_, to, camera_id)
        except ValueError as exc:
            raise ValidationError(str(exc)) from exc

    # ── ReportSchedule CRUD ─────────────────────────────────────────────
    async def _schedule(self, sid: str) -> ReportSchedule:
        row = await self.db.get(ReportSchedule, sid)
        assert_owned(row, self.scope, message="report schedule not found")
        return row

    async def list_schedules(self) -> list[ReportSchedule]:
        stmt = scoped(select(ReportSchedule), ReportSchedule, self.scope).order_by(
            ReportSchedule.created_at.desc()
        )
        return list((await self.db.execute(stmt)).scalars().all())

    async def get_schedule(self, sid: str) -> ReportSchedule:
        return await self._schedule(sid)

    async def create_schedule(self, body: ReportScheduleCreate, *, actor) -> ReportSchedule:
        err = body.validate_enums()
        if err:
            raise ValidationError(err)
        now = _utcnow()
        row = ReportSchedule(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            kind=body.kind,
            cadence=body.cadence,
            export_format=body.export_format,
            recipients=list(body.recipients or []),
            filters=dict(body.filters or {}),
            channel=body.channel,
            enabled=body.enabled,
            hour_utc=body.hour_utc,
            next_run_at=compute_next_run(body.cadence, body.hour_utc, now=now),
            created_by=_actor_id(actor),
            updated_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        log.info("report schedule created: %s (%s/%s)", row.id, row.kind, row.cadence)
        return row

    async def update_schedule(
        self, sid: str, body: ReportScheduleUpdate, *, actor
    ) -> ReportSchedule:
        err = body.validate_enums()
        if err:
            raise ValidationError(err)
        row = await self._schedule(sid)
        data = body.model_dump(exclude_unset=True)
        cadence_changed = "cadence" in data or "hour_utc" in data
        for k, v in data.items():
            setattr(row, k, v)
        if cadence_changed:
            row.next_run_at = compute_next_run(row.cadence, row.hour_utc)
        row.updated_by = _actor_id(actor)
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def delete_schedule(self, sid: str) -> None:
        row = await self._schedule(sid)
        await self.db.delete(row)
        await self.db.commit()
