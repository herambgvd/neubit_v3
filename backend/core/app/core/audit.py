"""Audit log — an append-only record of who did what, to what, when.

Services call ``record(...)`` when a meaningful action happens; admins read the
trail through ``GET /api/audit``.

  * Append-only: there is no update or delete endpoint, by design.
  * ``record`` accepts a ``User``, an ``ApiKeyPrincipal``, or None for system
    actions, reading fields via getattr so any user-like object works.
    ``actor_type`` says which — a machine's action must not read as a person's.
  * ``meta`` is free-form JSON context, portable across Postgres and SQLite.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import JSON, DateTime, String, Uuid, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from ..auth.deps import require_permission
from ..auth.permissions import CorePerm
from ..db.base import Base, get_db
from .errors import ValidationError
from .pagination import Page, PageParams, page_params, paginate


class AuditLog(Base):
    """One immutable row per audited action."""

    __tablename__ = "audit_log"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # Actor snapshot: id AND email at the time of the action. The email is stored
    # verbatim so the trail survives a rename or delete. Nullable for system
    # actions.
    actor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    actor_email: Mapped[str | None] = mapped_column(String, nullable=True)
    # Display name, snapshotted for the same reason as the email. NULL for system
    # actions and users with no full name (the UI falls back to email).
    actor_name: Mapped[str | None] = mapped_column(String, nullable=True)
    # "user" | "apikey" | "system". The snapshot columns above cannot carry this —
    # a key has no email, and its name in actor_name reads like an oddly-named
    # person. Non-null with a "user" default so pre-existing rows keep their
    # meaning; migration 0023 backfills the actor-less ones to "system".
    actor_type: Mapped[str] = mapped_column(
        String(16), nullable=False, default="user", server_default="user"
    )
    # --- multi-tenancy -----------------------------------------------------
    # The actor's tenant at the time. NULL = a platform/super-admin/system action.
    # Tenant-admins only see their own rows.
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    # What happened, e.g. "user.delete", "license.replace", "role.update".
    action: Mapped[str] = mapped_column(String, nullable=False)
    # What it happened to (optional): a type name + its id, e.g. ("user", "<uuid>").
    target_type: Mapped[str | None] = mapped_column(String, nullable=True)
    target_id: Mapped[str | None] = mapped_column(String, nullable=True)
    # Free-form structured context for this action (old/new values, ip, etc.).
    meta: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # When it happened. Indexed because the log is almost always queried by time.
    ts: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )


async def record(
    db: AsyncSession,
    *,
    actor: Any | None = None,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    meta: dict | None = None,
) -> AuditLog:
    """Write one audit entry and commit it.

    Fields are read via getattr so any user-like object, or None, is accepted.
    Committed immediately: the record must survive a later failure in the request.
    """
    entry = AuditLog(
        actor_id=getattr(actor, "id", None),
        actor_email=getattr(actor, "email", None),
        actor_name=getattr(actor, "full_name", None) or None,
        # No actor means a system action; anything else declares its own kind and
        # defaults to "user". A ``User`` never sets ``audit_actor_type``, so
        # existing callers keep writing the row they always wrote.
        actor_type=("system" if actor is None else str(getattr(actor, "audit_actor_type", "user"))),
        # Stamp the actor's tenant so the trail is scoped. Super-admins and system
        # actions have no tenant, so NULL means platform scope.
        tenant_id=getattr(actor, "tenant_id", None),
        action=action,
        target_type=target_type,
        target_id=target_id,
        meta=meta or {},
    )
    db.add(entry)
    # The shared session does NOT auto-commit (see db/base.py), so commit here.
    await db.commit()
    await db.refresh(entry)
    return entry


class AuditLogOut(BaseModel):
    """API representation of one audit entry.

    `tenant_id` is exposed for the cross-tenant `GET /admin/audit` view, which
    otherwise returns every tenant's rows with no attribution. It leaks nothing to
    a tenant admin: their listing is already scoped, so they only see their own.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tenant_id: uuid.UUID | None
    actor_id: uuid.UUID | None
    actor_email: str | None
    actor_name: str | None
    actor_type: str
    action: str
    target_type: str | None
    target_id: str | None
    meta: dict
    ts: datetime


audit_router = APIRouter(prefix="/audit", tags=["audit"])


@audit_router.get("")
async def list_audit(
    params: PageParams = Depends(page_params),
    action: str | None = Query(None, max_length=64),
    q: str | None = Query(None, max_length=128),
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(CorePerm.AUDIT_READ)),
) -> Page[AuditLogOut]:
    """List audit entries, newest first. Requires ``audit.read``.

    Tenant-scoped: a tenant-admin sees only their own tenant, a super-admin sees
    the whole trail. ``action`` matches by prefix (``user`` → ``user.*``); ``q`` is
    free text over actor name, email and action.
    """
    from ..tenancy.scope import scope_of, scoped

    stmt = scoped(select(AuditLog).order_by(AuditLog.ts.desc()), AuditLog, scope_of(user))
    if action:
        stmt = stmt.where(AuditLog.action.ilike(f"{action}%"))
    if q:
        term = f"%{q}%"
        stmt = stmt.where(
            or_(
                AuditLog.actor_name.ilike(term),
                AuditLog.actor_email.ilike(term),
                AuditLog.action.ilike(term),
            )
        )
    return await paginate(db, stmt, params, item_model=AuditLogOut)


# --- Data retention ----------------------------------------------------------
async def _retention_days(db: AsyncSession) -> int:
    """The configured audit retention in days (0 = keep forever)."""
    from ..settings.service import SettingsService  # lazy: avoids an import cycle

    try:
        return int(await SettingsService(db).get("audit_retention_days") or 0)
    except (TypeError, ValueError):
        return 0


class RetentionOut(BaseModel):
    retention_days: int
    total: int


class PurgeIn(BaseModel):
    """Purge entries older than this many days. Omit to use the configured policy."""

    older_than_days: int | None = None


@audit_router.get("/retention")
async def audit_retention(
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(CorePerm.AUDIT_READ)),
) -> RetentionOut:
    """Current retention policy + total number of stored audit entries (scoped)."""
    from ..tenancy.scope import scope_of, scoped

    count_stmt = scoped(select(func.count()).select_from(AuditLog), AuditLog, scope_of(user))
    total = int(await db.scalar(count_stmt) or 0)
    return RetentionOut(retention_days=await _retention_days(db), total=total)


@audit_router.post("/purge")
async def purge_audit(
    data: PurgeIn,
    db: AsyncSession = Depends(get_db),
    actor=Depends(require_permission(CorePerm.SETTINGS_MANAGE)),
) -> dict:
    """Delete audit entries older than N days now.

    Uses ``older_than_days`` if given, else ``audit_retention_days``. Gated by
    ``settings.manage`` because it destroys records permanently.
    """
    days = data.older_than_days if data.older_than_days is not None else await _retention_days(db)
    if not days or days <= 0:
        raise ValidationError("Set a positive number of days (or a retention policy) to purge.")
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    from ..tenancy.scope import scope_of

    scope = scope_of(actor)
    stmt = delete(AuditLog).where(AuditLog.ts < cutoff)
    if not scope.is_platform:  # a tenant-admin only purges their own tenant's trail
        stmt = stmt.where(AuditLog.tenant_id == scope.tenant_id)
    result = await db.execute(stmt)
    await db.commit()
    deleted = result.rowcount or 0
    # Leave a trail of the purge itself (this entry is newer than the cutoff).
    await record(
        db, actor=actor, action="audit.purge", target_type="audit", target_id="bulk",
        meta={"older_than_days": days, "deleted": deleted},
    )
    return {"deleted": deleted, "older_than_days": days}
