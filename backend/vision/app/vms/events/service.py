"""VMS events service (P5-A) — ingest (normalize→dedupe→persist→publish) + feed/ack.

Two roles, mirroring the recording domain's service+consumer split:

  * INGEST (``ingest_device_event`` / ``ingest_system_event``) — the single
    normalize→dedupe→persist→publish path. The event-supervisor calls it per
    subscription callback (a driver ``DeviceEvent``); the health sampler / P3 workers
    call the system variant (camera online/offline, recording-error, storage-low).
    Runs OUTSIDE a caller scope (a background writer): it trusts the camera's tenant
    (device events) or an explicit tenant (system events), and publishes on the exact
    NATS subject/envelope the workflow correlation engine consumes.

  * READ (``list_`` / ``list_for_camera`` / ``ack``) — the tenant-scoped events feed.
    Every read goes through ``kernel.auth.scoped``; the by-id ack through
    ``assert_owned`` — the exact discipline of the recording/health services.

Dedupe: ``dedup_key = hash(camera_id + event_type + time-bucket)`` with a UNIQUE
index. A duplicate within the window collapses to the SAME key → the insert hits the
unique constraint → we roll back + skip (idempotent under a racing double-notification
/ at-least-once redelivery). ``ingest_*`` returns the event id, or ``None`` when the
event was a duplicate (skipped) — so the supervisor + tests can assert the dedupe.
"""

from __future__ import annotations

import logging
import uuid as _uuid
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped

from app.vms.common.events import emit_camera_event
from app.vms.models import VmsEvent

from .normalize import dedup_key, event_payload, normalize_event_type
from .schemas import VmsEventListResponse, VmsEventPublic

log = logging.getLogger("vision.events_service")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _coerce_tenant(tenant_id) -> _uuid.UUID | None:
    """A subject/str tenant → UUID | None (mirrors the recording consumer)."""
    if not tenant_id:
        return None
    if isinstance(tenant_id, _uuid.UUID):
        return tenant_id
    try:
        return _uuid.UUID(str(tenant_id))
    except (ValueError, TypeError):
        return None


def _parse_occurred(raw) -> datetime:
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)
    if isinstance(raw, str):
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            pass
    return _utcnow()


# Severity per normalized system event_type (device events carry the driver's severity).
_SYSTEM_SEVERITY = {
    "camera_online": "info",
    "camera_offline": "warning",
    "recording_error": "critical",
    "storage_low": "warning",
    "system": "info",
}


class VmsEventService:
    """Ingest (background writer) + the tenant-scoped events feed + ack."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    # ── INGEST: normalize → dedupe → persist → publish ──────────────────────
    async def ingest_device_event(
        self,
        *,
        tenant_id,
        camera_id: str | None,
        driver_event_type: str,
        severity: str,
        title: str,
        raw: dict | None = None,
        source: str = "onvif",
        occurred_at=None,
        topic_allow: list[str] | None = None,
    ) -> str | None:
        """Persist + publish one driver device-event. Returns the row id, or ``None``
        if it was a duplicate within the dedup window (skipped) / filtered by the
        camera's topic allow-list. Never raises out of the ingest path — a bad event
        must not stall a subscription.
        """
        event_type = normalize_event_type(driver_event_type)
        # Optional per-camera allow-list of normalized types.
        if topic_allow and event_type not in topic_allow:
            return None
        return await self._persist_publish(
            tenant_id=tenant_id,
            camera_id=camera_id,
            event_type=event_type,
            severity=severity or "info",
            source=source,
            title=title or event_type,
            description=None,
            raw=raw or {},
            occurred_at=occurred_at,
        )

    async def ingest_system_event(
        self,
        *,
        tenant_id,
        event_type: str,
        title: str,
        camera_id: str | None = None,
        severity: str | None = None,
        raw: dict | None = None,
        description: str | None = None,
        occurred_at=None,
    ) -> str | None:
        """Persist + publish a SYSTEM event (camera online/offline, recording-error,
        storage-low). ``source='system'``. Same dedupe + publish path as device events.
        """
        et = normalize_event_type(event_type)
        return await self._persist_publish(
            tenant_id=tenant_id,
            camera_id=camera_id,
            event_type=et,
            severity=severity or _SYSTEM_SEVERITY.get(et, "info"),
            source="system",
            title=title or et,
            description=description,
            raw=raw or {},
            occurred_at=occurred_at,
        )

    async def _persist_publish(
        self,
        *,
        tenant_id,
        camera_id,
        event_type,
        severity,
        source,
        title,
        description,
        raw,
        occurred_at,
    ) -> str | None:
        tid = _coerce_tenant(tenant_id)
        occ = _parse_occurred(occurred_at)
        key = dedup_key(camera_id, event_type, occ)

        # Dedupe up-front (cheap read) so a chatty camera doesn't spam failed inserts.
        existing = (
            await self.db.execute(select(VmsEvent.id).where(VmsEvent.dedup_key == key))
        ).scalar_one_or_none()
        if existing:
            return None

        row = VmsEvent(
            tenant_id=tid,
            camera_id=camera_id,
            event_type=event_type,
            severity=severity,
            source=source,
            title=title,
            description=description,
            raw=raw or {},
            dedup_key=key,
            occurred_at=occ,
            published=False,
        )
        self.db.add(row)
        try:
            await self.db.commit()
        except Exception as exc:  # noqa: BLE001 — a racing insert (unique key) is fine
            await self.db.rollback()
            log.debug("event dedup race for key=%s: %s", key, exc)
            return None
        await self.db.refresh(row)

        # Publish on the exact subject/envelope the workflow correlation consumes.
        try:
            subj = await emit_camera_event(tid, event_type, event_payload(row))
            row.published = True
            await self.db.commit()
            log.info(
                "vms event %s type=%s camera=%s published on %s",
                row.id, event_type, camera_id, subj,
            )
        except Exception as exc:  # noqa: BLE001 — publish is best-effort; row stays
            await self.db.rollback()
            log.warning("vms event %s persisted but publish failed: %s", row.id, exc)
        return row.id

    # ── READ: tenant-scoped events feed ─────────────────────────────────────
    async def _camera_owned(self, camera_id: str) -> None:
        from app.vms.models import Camera

        row = await self.db.get(Camera, camera_id)
        assert_owned(row, self.scope, message="camera not found")

    async def list_(
        self,
        *,
        camera_id: str | None = None,
        event_type: str | None = None,
        severity: str | None = None,
        acknowledged: bool | None = None,
        from_: datetime | None = None,
        to: datetime | None = None,
        skip: int = 0,
        limit: int = 50,
    ) -> VmsEventListResponse:
        stmt = scoped(select(VmsEvent), VmsEvent, self.scope)
        count_stmt = scoped(select(func.count(VmsEvent.id)), VmsEvent, self.scope)

        def _apply(q):
            if camera_id is not None:
                q = q.where(VmsEvent.camera_id == camera_id)
            if event_type is not None:
                q = q.where(VmsEvent.event_type == event_type)
            if severity is not None:
                q = q.where(VmsEvent.severity == severity)
            if acknowledged is not None:
                q = q.where(VmsEvent.acknowledged.is_(acknowledged))
            if from_ is not None:
                q = q.where(VmsEvent.occurred_at >= from_)
            if to is not None:
                q = q.where(VmsEvent.occurred_at <= to)
            return q

        stmt = _apply(stmt)
        count_stmt = _apply(count_stmt)

        total = int((await self.db.execute(count_stmt)).scalar() or 0)
        rows = list(
            (
                await self.db.execute(
                    stmt.order_by(VmsEvent.occurred_at.desc()).offset(skip).limit(limit)
                )
            )
            .scalars()
            .all()
        )
        return VmsEventListResponse(
            items=[VmsEventPublic.from_row(r) for r in rows],
            total=total,
            skip=skip,
            limit=limit,
        )

    async def list_for_camera(
        self, camera_id: str, *, skip: int = 0, limit: int = 50, **filters
    ) -> VmsEventListResponse:
        await self._camera_owned(camera_id)  # ownership check
        return await self.list_(camera_id=camera_id, skip=skip, limit=limit, **filters)

    async def ack(self, event_id: str, *, actor) -> VmsEventPublic:
        row = await self.db.get(VmsEvent, event_id)
        assert_owned(row, self.scope, message="event not found")
        if not row.acknowledged:
            row.acknowledged = True
            row.acknowledged_by = str(getattr(actor, "user_id", "")) or None
            row.acknowledged_at = _utcnow()
            await self.db.commit()
            await self.db.refresh(row)
        return VmsEventPublic.from_row(row)


# ── background-worker convenience: emit a system event with its own DB session ─────
async def emit_system_event(
    sessionmaker,
    *,
    tenant_id,
    event_type: str,
    title: str,
    camera_id: str | None = None,
    severity: str | None = None,
    raw: dict | None = None,
    description: str | None = None,
) -> str | None:
    """Persist + publish a SYSTEM event from a background worker (P3 storage/recording).

    Opens its OWN DB session (workers aren't request-scoped) and runs the same
    dedupe→persist→publish path as the supervisor. Best-effort — never raises out of a
    worker cycle. Returns the row id, or ``None`` when deduped / on failure.
    """
    from kernel.auth import Scope as _Scope

    try:
        async with sessionmaker() as db:
            svc = VmsEventService(db, _Scope(tenant_id=None, is_superadmin=True))
            return await svc.ingest_system_event(
                tenant_id=tenant_id,
                event_type=event_type,
                title=title,
                camera_id=camera_id,
                severity=severity,
                raw=raw,
                description=description,
            )
    except Exception as exc:  # noqa: BLE001 — a system-event emit must not break the worker
        log.debug("system event emit failed (%s): %s", event_type, exc)
        return None
