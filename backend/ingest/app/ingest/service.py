"""Ingest service — tenant-scoped category/webhook CRUD + the receiver pipeline.

Two responsibilities, split by trust boundary:

* ``CategoryService`` / ``WebhookService`` — the authed config API. Scope-aware
  (every read through ``scoped``, every by-id fetch through ``assert_owned``);
  new rows are stamped with the caller's ``tenant_id``. Secrets are hashed here.

* ``ReceiverService`` — the PUBLIC ``POST /ingest/hooks/{token}`` pipeline:
  look up webhook by token (NOT tenant-scoped — the token IS the credential),
  verify per-webhook auth → validate JSON schema → apply JMESPath transform →
  PUBLISH a normalized event to NATS on ``tenant.<tid>.<domain>.event.received``.
  Failures raise the generic kernel errors (401/422) with no info leak.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ConflictError, NotFoundError, UnauthorizedError, ValidationError
from kernel.events import EventBus, subject

from .models import IngestCategory, Webhook
from .schemas import (
    CategoryCreate,
    CategoryPublic,
    CategoryUpdate,
    WebhookCreate,
    WebhookPublic,
    WebhookUpdate,
)
from .security import hash_secret, verify_inbound
from .transform import apply_transform, validate_payload


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


# ── Category CRUD ──────────────────────────────────────────────────────


class CategoryService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _get_row(self, category_id: str) -> IngestCategory:
        row = await self.db.get(IngestCategory, category_id)
        assert_owned(row, self.scope, message="Category not found")
        return row

    async def _webhook_count(self, category_id: str) -> int:
        return int(
            await self.db.scalar(
                select(func.count())
                .select_from(Webhook)
                .where(Webhook.category_id == category_id)
            )
            or 0
        )

    async def create(self, body: CategoryCreate, *, actor) -> CategoryPublic:
        actor_id = _actor_id(actor)
        row = IngestCategory(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            description=body.description,
            target_domain=body.target_domain,
            created_by=actor_id,
            updated_by=actor_id,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return CategoryPublic.from_row(row, webhook_count=0)

    async def list_(
        self, *, skip: int = 0, limit: int = 20, search: str | None = None
    ) -> tuple[list[CategoryPublic], int]:
        stmt = scoped(select(IngestCategory), IngestCategory, self.scope)
        count_stmt = scoped(
            select(func.count()).select_from(IngestCategory), IngestCategory, self.scope
        )
        if search:
            term = f"%{search}%"
            stmt = stmt.where(IngestCategory.name.ilike(term))
            count_stmt = count_stmt.where(IngestCategory.name.ilike(term))
        stmt = stmt.order_by(IngestCategory.created_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count_stmt) or 0)
        out = [
            CategoryPublic.from_row(r, webhook_count=await self._webhook_count(r.id))
            for r in rows
        ]
        return out, total

    async def get(self, category_id: str) -> CategoryPublic:
        row = await self._get_row(category_id)
        return CategoryPublic.from_row(row, webhook_count=await self._webhook_count(row.id))

    async def update(
        self, category_id: str, body: CategoryUpdate, *, actor
    ) -> CategoryPublic:
        row = await self._get_row(category_id)
        update = body.model_dump(exclude_none=True)
        actor_id = _actor_id(actor)
        if actor_id:
            update["updated_by"] = actor_id
        update["updated_at"] = _utcnow()
        for k, v in update.items():
            setattr(row, k, v)
        await self.db.commit()
        await self.db.refresh(row)
        return CategoryPublic.from_row(row, webhook_count=await self._webhook_count(row.id))

    async def delete(self, category_id: str, *, actor) -> None:
        row = await self._get_row(category_id)
        await self.db.delete(row)  # FK ON DELETE CASCADE removes its webhooks
        await self.db.commit()


# ── Webhook CRUD ───────────────────────────────────────────────────────


class WebhookService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _get_row(self, webhook_id: str) -> Webhook:
        row = await self.db.get(Webhook, webhook_id)
        assert_owned(row, self.scope, message="Webhook not found")
        return row

    async def _assert_category(self, category_id: str) -> IngestCategory:
        cat = await self.db.get(IngestCategory, category_id)
        # A category from another tenant is invisible → treated as missing.
        if cat is None or (
            not self.scope.is_platform and cat.tenant_id != self.scope.tenant_id
        ):
            raise ValidationError("category does not exist")
        return cat

    async def create(self, body: WebhookCreate, *, actor) -> WebhookPublic:
        await self._assert_category(body.category_id)
        token = body.token or secrets.token_urlsafe(24)
        # Token is globally unique (it's the public URL credential).
        existing = await self.db.scalar(select(Webhook).where(Webhook.token == token))
        if existing is not None:
            raise ConflictError("token already in use")
        if body.auth_type != "none" and not body.auth_secret and body.auth_type == "api_key":
            raise ValidationError("api_key auth requires auth_secret")
        secret_hash = hash_secret(body.auth_secret) if body.auth_secret else None
        actor_id = _actor_id(actor)
        row = Webhook(
            tenant_id=self.scope.tenant_id,
            category_id=body.category_id,
            name=body.name,
            token=token,
            description=body.description,
            auth_type=body.auth_type.value,
            auth_username=body.auth_username,
            auth_secret_hash=secret_hash,
            payload_schema=body.payload_schema or {},
            transform=body.transform or {},
            event_type=body.event_type,
            is_active=body.is_active,
            created_by=actor_id,
            updated_by=actor_id,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return WebhookPublic.from_row(row)

    async def list_(
        self,
        *,
        skip: int = 0,
        limit: int = 20,
        search: str | None = None,
        category_id: str | None = None,
    ) -> tuple[list[WebhookPublic], int]:
        stmt = scoped(select(Webhook), Webhook, self.scope)
        count_stmt = scoped(select(func.count()).select_from(Webhook), Webhook, self.scope)
        if search:
            term = f"%{search}%"
            stmt = stmt.where(Webhook.name.ilike(term))
            count_stmt = count_stmt.where(Webhook.name.ilike(term))
        if category_id:
            stmt = stmt.where(Webhook.category_id == category_id)
            count_stmt = count_stmt.where(Webhook.category_id == category_id)
        stmt = stmt.order_by(Webhook.created_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count_stmt) or 0)
        return [WebhookPublic.from_row(r) for r in rows], total

    async def get(self, webhook_id: str) -> WebhookPublic:
        row = await self._get_row(webhook_id)
        return WebhookPublic.from_row(row)

    async def update(self, webhook_id: str, body: WebhookUpdate, *, actor) -> WebhookPublic:
        row = await self._get_row(webhook_id)
        if body.category_id and body.category_id != row.category_id:
            await self._assert_category(body.category_id)

        update = body.model_dump(exclude_none=True, exclude={"auth_secret", "auth_type"})
        if body.auth_type is not None:
            update["auth_type"] = body.auth_type.value
        # Rotate the secret only when a new plaintext is supplied.
        if body.auth_secret is not None:
            update["auth_secret_hash"] = hash_secret(body.auth_secret)
        actor_id = _actor_id(actor)
        if actor_id:
            update["updated_by"] = actor_id
        update["updated_at"] = _utcnow()
        for k, v in update.items():
            setattr(row, k, v)
        await self.db.commit()
        await self.db.refresh(row)
        return WebhookPublic.from_row(row)

    async def delete(self, webhook_id: str, *, actor) -> None:
        row = await self._get_row(webhook_id)
        await self.db.delete(row)
        await self.db.commit()


# ── Public receiver pipeline ───────────────────────────────────────────


class ReceiverService:
    """Handles ``POST /ingest/hooks/{token}`` — NO JWT; the token is the lookup key."""

    def __init__(self, db: AsyncSession, bus: EventBus) -> None:
        self.db = db
        self.bus = bus

    async def _lookup(self, token: str) -> Webhook:
        row = await self.db.scalar(select(Webhook).where(Webhook.token == token))
        # Unknown OR disabled → 401, indistinguishable (no info leak on token space).
        if row is None or not row.is_active:
            raise UnauthorizedError("invalid webhook")
        return row

    async def handle(
        self, token: str, request: Request, payload: Any
    ) -> tuple[str, str | None]:
        """Run auth → validate → transform → publish. Returns (event_type, event_id)."""
        webhook = await self._lookup(token)

        # 1. Per-webhook auth (bare 401, generic reason).
        auth = verify_inbound(
            request,
            auth_type=webhook.auth_type,
            auth_username=webhook.auth_username,
            auth_secret_hash=webhook.auth_secret_hash,
        )
        if not auth.ok:
            raise UnauthorizedError("unauthorized")

        # 2. Schema validation (422 with detail — safe: caller owns the payload).
        v = validate_payload(payload, webhook.payload_schema or {})
        if not v.ok:
            raise ValidationError(
                "payload failed schema validation",
                details={"errors": v.errors[:10]},
            )

        # 3. JMESPath transform.
        t = apply_transform(payload, webhook.transform or {})
        if not t.ok:
            raise ValidationError(
                "payload transform failed", details={"errors": t.errors[:10]}
            )
        transformed = t.value or {}

        # 4. Resolve the target subject via the webhook's category, then publish.
        category = await self.db.get(IngestCategory, webhook.category_id)
        domain = (category.target_domain if category else None) or "ingest"
        tenant_id = str(webhook.tenant_id) if webhook.tenant_id else None
        event_id = str(uuid.uuid4())
        event_type = webhook.event_type or "ingest.event"

        subj = subject(tenant_id, domain, "event.received")
        # EventBus wraps this in the canonical envelope
        # {event_id, tenant_id, type, occurred_at, source:"ingest", payload}.
        await self.bus.publish(
            subj,
            {
                "webhook_id": webhook.id,
                "webhook_token": webhook.token,
                "category_id": webhook.category_id,
                "event_type": event_type,
                "ingest_event_id": event_id,
                "data": transformed,
            },
        )
        return event_type, event_id
