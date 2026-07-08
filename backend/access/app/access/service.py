"""Access-control services — tenant-scoped instance CRUD, reconcile, mirror reads.

Every read goes through ``kernel.auth.scoped``; every by-id fetch through
``assert_owned``; new rows are stamped with the caller's ``tenant_id``. The
controller secret is encrypted here (reversibly — the connector needs it back).

The reconcile + connection paths DEGRADE GRACEFULLY when the controller is
unreachable: ``test_connection`` returns an error result (never raises), and
``reconcile`` records a FAILED ``SyncJob`` instead of 500-ing. This is faithful to
v2's reconciler (per-collection try/except + a job status of failed/partial).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ConflictError

from datetime import datetime as _dt

from ..connectors.base import MIRROR_COLLECTIONS
from ..connectors.factory import get_connector
from .crypto import decrypt_secret, encrypt_secret
from .models import AccessEvent, AccessMirror, Instance, SyncJob
from .schemas import (
    AccessEventListResponse,
    AccessEventPublic,
    InstanceCreate,
    InstanceListResponse,
    InstancePublic,
    InstanceUpdate,
    MirrorListResponse,
    MirrorRow,
    SyncJobListResponse,
    SyncJobPublic,
    TestConnectionResponse,
)

log = logging.getLogger("access.service")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


class InstanceService:
    """Tenant-scoped CRUD + connector-driven ops over ``access_instances``."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _row(self, instance_id: str) -> Instance:
        row = await self.db.get(Instance, instance_id)
        assert_owned(row, self.scope, message="Instance not found")
        return row

    def _connector(self, row: Instance):
        """Build the brand connector, decrypting the stored secret."""
        secret = decrypt_secret(row.secret_enc)
        return get_connector(row, secret=secret)

    # ── CRUD ────────────────────────────────────────────────────────────
    async def create(self, body: InstanceCreate, *, actor) -> InstancePublic:
        # Name is unique within the caller's tenant.
        dup = await self.db.scalar(
            scoped(select(Instance), Instance, self.scope).where(Instance.name == body.name)
        )
        if dup is not None:
            raise ConflictError("an instance with this name already exists")

        actor_id = _actor_id(actor)
        row = Instance(
            tenant_id=self.scope.tenant_id,
            brand=body.brand.value,
            name=body.name,
            base_url=body.base_url,
            auth_type=body.auth_type.value,
            username=body.username or "",
            secret_enc=encrypt_secret(body.secret) if body.secret else None,
            verify_tls=body.verify_tls,
            site_id=body.site_id,
            is_active=body.is_active,
            reconciler_cron=body.reconciler_cron,
            status="unknown",
            created_by=actor_id,
            updated_by=actor_id,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return InstancePublic.from_row(row)

    async def list_(
        self, *, skip: int = 0, limit: int = 20, search: str | None = None
    ) -> InstanceListResponse:
        stmt = scoped(select(Instance), Instance, self.scope)
        count_stmt = scoped(
            select(func.count()).select_from(Instance), Instance, self.scope
        )
        if search:
            term = f"%{search}%"
            stmt = stmt.where(Instance.name.ilike(term))
            count_stmt = count_stmt.where(Instance.name.ilike(term))
        stmt = stmt.order_by(Instance.created_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count_stmt) or 0)
        return InstanceListResponse(
            items=[InstancePublic.from_row(r) for r in rows],
            total=total,
            skip=skip,
            limit=limit,
        )

    async def get(self, instance_id: str) -> InstancePublic:
        return InstancePublic.from_row(await self._row(instance_id))

    async def update(
        self, instance_id: str, body: InstanceUpdate, *, actor
    ) -> InstancePublic:
        row = await self._row(instance_id)
        update = body.model_dump(
            exclude_none=True, exclude={"secret", "auth_type"}
        )
        if body.auth_type is not None:
            update["auth_type"] = body.auth_type.value
        if body.secret is not None:
            update["secret_enc"] = encrypt_secret(body.secret) if body.secret else None
        actor_id = _actor_id(actor)
        if actor_id:
            update["updated_by"] = actor_id
        update["updated_at"] = _utcnow()
        for k, v in update.items():
            setattr(row, k, v)
        await self.db.commit()
        await self.db.refresh(row)
        return InstancePublic.from_row(row)

    async def delete(self, instance_id: str, *, actor) -> None:
        row = await self._row(instance_id)
        await self.db.delete(row)  # FK CASCADE removes mirror/doors/events/jobs
        await self.db.commit()

    # ── Connector-driven ops ────────────────────────────────────────────
    async def test_connection(self, instance_id: str) -> TestConnectionResponse:
        """Ping the controller. Never 500s on an unreachable controller — records
        the outcome on the instance and returns ok/error."""
        row = await self._row(instance_id)
        connector = self._connector(row)
        try:
            result = await connector.test_connection()
        finally:
            await connector.aclose()

        if result.ok:
            row.status = "online"
            row.last_connected_at = _utcnow()
            row.last_error = None
        else:
            row.status = "offline"
            row.last_error = result.error
        row.updated_at = _utcnow()
        await self.db.commit()
        return TestConnectionResponse(ok=result.ok, detail=result.detail, error=result.error)

    async def reconcile(self, instance_id: str, *, trigger: str = "manual") -> SyncJobPublic:
        """Full-sync every mirrored collection into ``access_mirror`` + record a
        ``SyncJob``. Faithful to v2's reconciler: per-collection try/except, orphan
        cleanup via a seen-set, and a degraded (failed/partial) job status when the
        controller is unreachable — NEVER a 500."""
        row = await self._row(instance_id)

        job = SyncJob(
            tenant_id=row.tenant_id,
            instance_id=row.id,
            kind="full",
            status="running",
            trigger=trigger,
            started_at=_utcnow(),
        )
        self.db.add(job)
        await self.db.commit()
        await self.db.refresh(job)

        connector = self._connector(row)
        per_collection: dict[str, Any] = {}
        errors: list[dict] = []
        tot_created = tot_updated = tot_deleted = tot_errors = 0

        try:
            for collection in MIRROR_COLLECTIONS:
                counts = await self._reconcile_collection(row, connector, collection)
                per_collection[collection] = counts
                tot_created += counts["created"]
                tot_updated += counts["updated"]
                tot_deleted += counts["deleted"]
                tot_errors += counts["errors"]
                if counts["errors"]:
                    errors.append({"collection": collection, "errors": counts["errors"]})
        finally:
            await connector.aclose()

        # Status: succeeded (no errors) / failed (all errored, nothing synced) /
        # partial (some errored). Mirrors v2's status derivation.
        if not errors:
            status = "succeeded"
        elif tot_created + tot_updated == 0:
            status = "failed"
        else:
            status = "partial"

        job.status = status
        job.created_count = tot_created
        job.updated_count = tot_updated
        job.deleted_count = tot_deleted
        job.error_count = tot_errors
        job.counts = per_collection
        job.errors = errors
        job.finished_at = _utcnow()

        # Reflect the outcome on the instance.
        if status == "failed":
            row.status = "offline"
            row.last_error = f"reconcile failed ({tot_errors} errors)"
        else:
            row.last_sync_at = job.finished_at
            if status == "succeeded":
                row.status = "online"
                row.last_connected_at = job.finished_at
                row.last_error = None
        row.updated_at = _utcnow()

        await self.db.commit()
        await self.db.refresh(job)
        return SyncJobPublic.from_row(job)

    async def _reconcile_collection(
        self, instance: Instance, connector, collection: str
    ) -> dict[str, int]:
        """Pull one collection → upsert into mirror + orphan-cleanup (v2 flow)."""
        counts = {"created": 0, "updated": 0, "deleted": 0, "errors": 0}
        try:
            rows = await connector.list_collection(collection)
        except Exception as exc:  # noqa: BLE001 — one bad set never aborts the run
            log.warning("reconcile %s: fetch failed: %s", collection, exc)
            counts["errors"] += 1
            return counts

        seen: set[str] = set()
        for dto in rows:
            remote_uid = connector.uid_of(dto)
            if not remote_uid:
                counts["errors"] += 1
                continue
            remote_uid = str(remote_uid)
            seen.add(remote_uid)
            try:
                existing = await self.db.scalar(
                    select(AccessMirror).where(
                        AccessMirror.instance_id == instance.id,
                        AccessMirror.collection == collection,
                        AccessMirror.remote_uid == remote_uid,
                    )
                )
                if existing is None:
                    self.db.add(
                        AccessMirror(
                            tenant_id=instance.tenant_id,
                            instance_id=instance.id,
                            collection=collection,
                            remote_uid=remote_uid,
                            dto=dto,
                            last_synced_at=_utcnow(),
                        )
                    )
                    counts["created"] += 1
                else:
                    existing.dto = dto
                    existing.last_synced_at = _utcnow()
                    counts["updated"] += 1
            except Exception as exc:  # noqa: BLE001
                log.warning("reconcile %s: upsert failed: %s", collection, exc)
                counts["errors"] += 1

        # Orphan cleanup — delete rows whose remote_uid is no longer present
        # (v2 replace_seen_set). Only when the fetch itself succeeded.
        try:
            del_stmt = sa_delete(AccessMirror).where(
                AccessMirror.instance_id == instance.id,
                AccessMirror.collection == collection,
            )
            if seen:
                del_stmt = del_stmt.where(
                    or_(
                        AccessMirror.remote_uid.is_(None),
                        AccessMirror.remote_uid == "",
                        ~AccessMirror.remote_uid.in_(list(seen)),
                    )
                )
            result = await self.db.execute(del_stmt)
            counts["deleted"] = int(result.rowcount or 0)
        except Exception as exc:  # noqa: BLE001
            log.warning("reconcile %s: orphan cleanup failed: %s", collection, exc)
            counts["errors"] += 1

        await self.db.flush()
        return counts

    # ── Sync-job history ────────────────────────────────────────────────
    async def sync_jobs(self, instance_id: str, *, limit: int = 50) -> SyncJobListResponse:
        await self._row(instance_id)  # ownership gate
        stmt = (
            select(SyncJob)
            .where(SyncJob.instance_id == instance_id)
            .order_by(SyncJob.started_at.desc())
            .limit(limit)
        )
        rows = (await self.db.execute(stmt)).scalars().all()
        return SyncJobListResponse(
            items=[SyncJobPublic.from_row(r) for r in rows], total=len(rows)
        )

    # ── Mirror reads ────────────────────────────────────────────────────
    async def list_mirror(
        self, instance_id: str, collection: str, *, skip: int = 0, limit: int = 50
    ) -> MirrorListResponse:
        await self._row(instance_id)  # ownership gate
        base = select(AccessMirror).where(
            AccessMirror.instance_id == instance_id,
            AccessMirror.collection == collection,
        )
        count_stmt = select(func.count()).select_from(AccessMirror).where(
            AccessMirror.instance_id == instance_id,
            AccessMirror.collection == collection,
        )
        stmt = base.order_by(AccessMirror.last_synced_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count_stmt) or 0)
        return MirrorListResponse(
            items=[MirrorRow.from_row(r) for r in rows], total=total, skip=skip, limit=limit
        )

    # ── Events read API (v2 event/routes + repository.list_) ────────────
    async def list_events(
        self,
        instance_id: str,
        *,
        skip: int = 0,
        limit: int = 100,
        category: str | None = None,
        result: str | None = None,
        door_ref: str | None = None,
        cardholder_ref: str | None = None,
        event_type: str | None = None,
        from_dt: _dt | None = None,
        to_dt: _dt | None = None,
    ) -> AccessEventListResponse:
        """Query persisted access events for an instance (tenant-scoped).

        Served from the ``access_events`` table (populated by the SignalR ingestion
        path). Filters mirror v2's ``AccessEventRepository.list_`` shape plus the
        v3 category/event_type dimensions."""
        await self._row(instance_id)  # ownership gate (404 for another tenant)

        stmt = select(AccessEvent).where(AccessEvent.instance_id == instance_id)
        count_stmt = (
            select(func.count())
            .select_from(AccessEvent)
            .where(AccessEvent.instance_id == instance_id)
        )

        def _apply(s):
            if category:
                s = s.where(AccessEvent.category == category)
            if result:
                s = s.where(AccessEvent.result == result)
            if door_ref:
                s = s.where(AccessEvent.door_ref == door_ref)
            if cardholder_ref:
                s = s.where(AccessEvent.cardholder_ref == cardholder_ref)
            if event_type:
                s = s.where(AccessEvent.event_type == event_type)
            if from_dt:
                s = s.where(AccessEvent.occurred_at >= from_dt)
            if to_dt:
                s = s.where(AccessEvent.occurred_at <= to_dt)
            return s

        stmt = _apply(stmt).order_by(AccessEvent.occurred_at.desc()).offset(skip).limit(limit)
        count_stmt = _apply(count_stmt)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count_stmt) or 0)
        return AccessEventListResponse(
            items=[AccessEventPublic.from_row(r) for r in rows],
            total=total,
            skip=skip,
            limit=limit,
        )
