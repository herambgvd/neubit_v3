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

from .matcher import evaluate_rule, match_first
from .models import (
    MAX_RAW_PAYLOAD_CHARS,
    IngestCategory,
    IngestEventLog,
    IngestEventRule,
    Webhook,
)
from .schemas import (
    CategoryCreate,
    CategoryPublic,
    CategoryUpdate,
    EventLogDetail,
    EventLogSummary,
    EventRuleCreate,
    EventRulePublic,
    EventRuleUpdate,
    RotateSecretResponse,
    RuleTestResponse,
    WebhookCreate,
    WebhookPublic,
    WebhookTestResponse,
    WebhookUpdate,
)
from .security import store_secret, verify_inbound
from .transform import apply_transform, validate_payload


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _client_ip(request: Request | None) -> str | None:
    """Best-effort source IP: first X-Forwarded-For hop, else the socket peer."""
    if request is None:
        return None
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()[:64]
    client = request.client
    return client.host[:64] if client else None


def _cap_raw(payload: Any) -> tuple[Any, bool]:
    """Cap a raw payload for storage; return (stored_value, was_truncated)."""
    try:
        import json

        serialized = json.dumps(payload, default=str)
    except Exception:
        return {"_unserializable": str(payload)[:MAX_RAW_PAYLOAD_CHARS]}, True
    if len(serialized) <= MAX_RAW_PAYLOAD_CHARS:
        return payload, False
    return (
        {"_truncated": serialized[:MAX_RAW_PAYLOAD_CHARS], "_original_chars": len(serialized)},
        True,
    )


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


async def _load_rules(
    db: AsyncSession, webhook_id: str, *, only_enabled: bool = True
) -> list[IngestEventRule]:
    """Rules for a webhook, ordered priority ASC then created_at ASC."""
    stmt = select(IngestEventRule).where(IngestEventRule.webhook_id == webhook_id)
    if only_enabled:
        stmt = stmt.where(IngestEventRule.enabled.is_(True))
    stmt = stmt.order_by(
        IngestEventRule.priority.asc(), IngestEventRule.created_at.asc()
    )
    return list((await db.execute(stmt)).scalars().all())


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
        at = body.auth_type.value
        # api_key / bearer / hmac require a secret on create; basic requires user+secret.
        if at in ("api_key", "bearer", "hmac") and not body.auth_secret:
            raise ValidationError(f"{at} auth requires auth_secret")
        if at == "basic" and not body.auth_username:
            raise ValidationError("basic auth requires auth_username")
        secret_stored = store_secret(at, body.auth_secret) if body.auth_secret else None
        # bearer/hmac never carry a username.
        auth_username = body.auth_username if at == "basic" else None
        actor_id = _actor_id(actor)
        row = Webhook(
            tenant_id=self.scope.tenant_id,
            category_id=body.category_id,
            name=body.name,
            token=token,
            description=body.description,
            request_method=body.request_method.value,
            auth_type=at,
            auth_username=auth_username,
            auth_secret_hash=secret_stored,
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

        update = body.model_dump(
            exclude_none=True, exclude={"auth_secret", "auth_type", "request_method"}
        )
        if body.request_method is not None:
            update["request_method"] = body.request_method.value
        effective_auth = row.auth_type
        if body.auth_type is not None:
            effective_auth = body.auth_type.value
            update["auth_type"] = effective_auth
        # Rotate the secret only when a new plaintext is supplied (stored per auth_type).
        if body.auth_secret is not None:
            update["auth_secret_hash"] = store_secret(effective_auth, body.auth_secret)
        # Canonicalize auth fields when the type changes.
        if effective_auth == "none":
            update["auth_username"] = None
            update["auth_secret_hash"] = None
        elif effective_auth in ("bearer", "hmac", "api_key"):
            update["auth_username"] = None
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

    async def test(self, webhook_id: str, payload: Any) -> WebhookTestResponse:
        """Dry-run: validate + transform a sample payload. No publish, no log.

        Skips actual inbound auth (there's no request) but reports the auth_type
        so the operator knows what the live receiver will require.
        """
        row = await self._get_row(webhook_id)

        v = validate_payload(payload, row.payload_schema or {})
        t = apply_transform(payload, row.transform or {})
        transformed = t.value if t.ok else None

        category = await self.db.get(IngestCategory, row.category_id)
        cat_domain = (category.target_domain if category else None) or "ingest"

        # Resolve which rule (if any) would win, and the emitted event_type.
        resolved_event_type = row.event_type or "ingest.event"
        matched_rule_id: str | None = None
        matched_rule_name: str | None = None
        domain = cat_domain
        if transformed is not None:
            rules = await _load_rules(self.db, row.id, only_enabled=True)
            if rules:
                rule, _results = match_first(transformed, rules)
                if rule is not None:
                    matched_rule_id = rule.id
                    matched_rule_name = rule.name
                    resolved_event_type = rule.event_type or resolved_event_type
                    domain = (rule.target_domain or cat_domain)

        tenant_id = str(row.tenant_id) if row.tenant_id else None
        would_subject = subject(tenant_id, domain, "event.received")

        return WebhookTestResponse(
            schema_valid=v.ok,
            schema_errors=v.errors[:20],
            transformed=transformed,
            transform_errors=t.errors[:20],
            would_publish_subject=would_subject,
            auth_type=row.auth_type,
            resolved_event_type=resolved_event_type,
            matched_rule_id=matched_rule_id,
            matched_rule_name=matched_rule_name,
        )

    async def rotate_secret(
        self, webhook_id: str, *, rotate_auth_secret: bool, actor
    ) -> RotateSecretResponse:
        """Mint a new public token (and optionally a new auth secret).

        The old token stops working immediately. The plaintext token/secret is
        returned ONCE — only the hash is persisted.
        """
        row = await self._get_row(webhook_id)

        # New globally-unique public token; retry on the vanishingly rare collision.
        new_token = secrets.token_urlsafe(24)
        while await self.db.scalar(select(Webhook).where(Webhook.token == new_token)):
            new_token = secrets.token_urlsafe(24)
        row.token = new_token

        new_secret: str | None = None
        if rotate_auth_secret and row.auth_type in ("api_key", "basic", "bearer", "hmac"):
            new_secret = secrets.token_urlsafe(24)
            row.auth_secret_hash = store_secret(row.auth_type, new_secret)

        actor_id = _actor_id(actor)
        if actor_id:
            row.updated_by = actor_id
        row.updated_at = _utcnow()

        await self.db.commit()
        await self.db.refresh(row)
        return RotateSecretResponse(
            id=row.id,
            token=row.token,
            ingest_url=f"/ingest/hooks/{row.token}",
            auth_secret=new_secret,
        )


# ── Event rule CRUD + test ─────────────────────────────────────────────


class RuleService:
    """Tenant-scoped CRUD + dry-run over ``ingest_event_rules`` (per webhook).

    A rule is owned by a webhook; ownership + tenant isolation are enforced by
    walking through the parent webhook (``assert_owned``). New rows inherit the
    webhook's ``tenant_id``.
    """

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _get_webhook(self, webhook_id: str) -> Webhook:
        row = await self.db.get(Webhook, webhook_id)
        assert_owned(row, self.scope, message="Webhook not found")
        return row

    async def _get_rule(self, rule_id: str) -> IngestEventRule:
        rule = await self.db.get(IngestEventRule, rule_id)
        assert_owned(rule, self.scope, message="Rule not found")
        return rule

    async def list_for_webhook(self, webhook_id: str) -> list[EventRulePublic]:
        await self._get_webhook(webhook_id)  # ownership gate
        rows = await _load_rules(self.db, webhook_id, only_enabled=False)
        return [EventRulePublic.from_row(r) for r in rows]

    async def create(
        self, webhook_id: str, body: EventRuleCreate, *, actor
    ) -> EventRulePublic:
        webhook = await self._get_webhook(webhook_id)
        actor_id = _actor_id(actor)
        row = IngestEventRule(
            tenant_id=webhook.tenant_id,
            webhook_id=webhook.id,
            name=body.name,
            description=body.description,
            priority=body.priority,
            match_conditions=[c.model_dump() for c in body.match_conditions],
            field_map=body.field_map or {},
            event_type=body.event_type,
            target_domain=body.target_domain,
            enabled=body.enabled,
            created_by=actor_id,
            updated_by=actor_id,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return EventRulePublic.from_row(row)

    async def get(self, rule_id: str) -> EventRulePublic:
        return EventRulePublic.from_row(await self._get_rule(rule_id))

    async def update(
        self, rule_id: str, body: EventRuleUpdate, *, actor
    ) -> EventRulePublic:
        row = await self._get_rule(rule_id)
        update = body.model_dump(exclude_none=True, exclude={"match_conditions"})
        if body.match_conditions is not None:
            update["match_conditions"] = [c.model_dump() for c in body.match_conditions]
        actor_id = _actor_id(actor)
        if actor_id:
            update["updated_by"] = actor_id
        update["updated_at"] = _utcnow()
        for k, v in update.items():
            setattr(row, k, v)
        await self.db.commit()
        await self.db.refresh(row)
        return EventRulePublic.from_row(row)

    async def delete(self, rule_id: str, *, actor) -> None:
        row = await self._get_rule(rule_id)
        await self.db.delete(row)
        await self.db.commit()

    async def test(
        self,
        rule_id: str,
        payload: Any,
        *,
        match_conditions: list[Any] | None = None,
        field_map: dict[str, str] | None = None,
    ) -> RuleTestResponse:
        """Evaluate the (persisted or proposed) rule against a sample payload."""
        row = await self._get_rule(rule_id)
        conditions = (
            [c.model_dump() for c in match_conditions]
            if match_conditions is not None
            else (row.match_conditions or [])
        )
        fmap = field_map if field_map is not None else (row.field_map or {})
        matched, results = evaluate_rule(payload, conditions)

        extracted: dict[str, Any] | None = None
        if matched and fmap:
            t = apply_transform(payload, fmap)
            extracted = t.value
        return RuleTestResponse(
            matched=matched,
            condition_results=results,
            extracted=extracted,
            event_type=row.event_type if matched else None,
        )


# ── Event log query + replay ───────────────────────────────────────────


class EventLogService:
    """Tenant-scoped read/replay over ``ingest_event_logs``."""

    def __init__(self, db: AsyncSession, scope: Scope, bus: EventBus) -> None:
        self.db = db
        self.scope = scope
        self.bus = bus

    async def _get_row(self, log_id: str) -> IngestEventLog:
        row = await self.db.get(IngestEventLog, log_id)
        assert_owned(row, self.scope, message="Event log not found")
        return row

    async def list_(
        self,
        *,
        skip: int = 0,
        limit: int = 20,
        webhook_id: str | None = None,
        auth_outcome: str | None = None,
        published: bool | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
    ) -> tuple[list[EventLogSummary], int]:
        stmt = scoped(select(IngestEventLog), IngestEventLog, self.scope)
        count_stmt = scoped(
            select(func.count()).select_from(IngestEventLog), IngestEventLog, self.scope
        )

        def _filtered(s):
            if webhook_id:
                s = s.where(IngestEventLog.webhook_id == webhook_id)
            if auth_outcome:
                s = s.where(IngestEventLog.auth_outcome == auth_outcome)
            if published is not None:
                s = s.where(IngestEventLog.published == published)
            if since:
                s = s.where(IngestEventLog.received_at >= since)
            if until:
                s = s.where(IngestEventLog.received_at <= until)
            return s

        stmt = _filtered(stmt)
        count_stmt = _filtered(count_stmt)
        stmt = stmt.order_by(IngestEventLog.received_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count_stmt) or 0)
        return [EventLogSummary.from_row(r) for r in rows], total

    async def get(self, log_id: str) -> EventLogDetail:
        row = await self._get_row(log_id)
        return EventLogDetail.from_row(row)

    async def replay(self, log_id: str) -> IngestEventLog:
        """Re-run a stored raw payload through its webhook's pipeline.

        Writes a NEW log row (``is_replay=True``). Only replays when the webhook
        still exists; a replay of a truncated payload is refused (the raw body
        is no longer faithful).
        """
        src = await self._get_row(log_id)
        if not src.webhook_id:
            raise ValidationError("event log has no webhook to replay against")
        webhook = await self.db.get(Webhook, src.webhook_id)
        # Ownership: webhook must exist AND belong to the caller's tenant.
        if webhook is None or not (
            self.scope.is_platform or webhook.tenant_id == self.scope.tenant_id
        ):
            raise NotFoundError("webhook for this event log no longer exists")
        if src.raw_truncated:
            raise ValidationError("cannot replay a truncated payload")

        receiver = ReceiverService(self.db, self.bus)
        row = await receiver.run_pipeline(
            webhook,
            payload=src.raw_payload,
            source_ip=src.source_ip,
            auth_ok=True,  # already authorized at original receipt; not re-checked
            is_replay=True,
        )
        return row


# ── Public receiver pipeline ───────────────────────────────────────────


class ReceiverService:
    """Handles ``POST /ingest/hooks/{token}`` — NO JWT; the token is the lookup key.

    Every inbound request produces exactly ONE ``IngestEventLog`` row (auth
    failures + unknown tokens included), written in the same session/txn as the
    accept so the audit trail never lags. On a rejected stage the log is
    committed and the corresponding kernel error (401/422) is re-raised.
    """

    def __init__(self, db: AsyncSession, bus: EventBus) -> None:
        self.db = db
        self.bus = bus
        self._resolved_event_type: str | None = None

    async def _record(self, log: IngestEventLog) -> IngestEventLog:
        self.db.add(log)
        await self.db.commit()
        await self.db.refresh(log)
        return log

    async def handle(
        self, token: str, request: Request, payload: Any, raw_body: bytes = b""
    ) -> tuple[str, str | None]:
        """Run lookup → auth → validate → transform → publish, logging the outcome.

        Returns (event_type, event_id) on success; raises 401/422 on rejection
        AFTER recording the log row. ``raw_body`` is the exact bytes received
        (needed to verify an HMAC signature).
        """
        source_ip = _client_ip(request)
        raw_stored, raw_truncated = _cap_raw(payload)

        webhook = await self.db.scalar(select(Webhook).where(Webhook.token == token))
        # Unknown OR disabled → 401, indistinguishable (no info leak on token space).
        if webhook is None or not webhook.is_active:
            await self._record(
                IngestEventLog(
                    tenant_id=webhook.tenant_id if webhook else None,
                    webhook_id=webhook.id if webhook else None,
                    category_id=webhook.category_id if webhook else None,
                    source_ip=source_ip,
                    auth_outcome="failed",
                    schema_outcome="skipped",
                    transform_outcome="skipped",
                    published=False,
                    error="unknown or disabled webhook token",
                    raw_payload=raw_stored,
                    raw_truncated=raw_truncated,
                )
            )
            raise UnauthorizedError("invalid webhook")

        # Enforce the webhook's configured HTTP method (405 on mismatch).
        expected_method = (getattr(webhook, "request_method", "post") or "post").upper()
        if request is not None and request.method.upper() != expected_method:
            await self._record(
                IngestEventLog(
                    tenant_id=webhook.tenant_id,
                    webhook_id=webhook.id,
                    category_id=webhook.category_id,
                    source_ip=source_ip,
                    auth_outcome="failed",
                    schema_outcome="skipped",
                    transform_outcome="skipped",
                    published=False,
                    error=f"method {request.method.upper()} not allowed; expected {expected_method}",
                    raw_payload=raw_stored,
                    raw_truncated=raw_truncated,
                )
            )
            raise ValidationError(
                f"method not allowed; expected {expected_method}",
                details={"expected_method": expected_method},
            )

        # Per-webhook auth (bare 401, generic reason). raw_body feeds HMAC verify.
        auth = verify_inbound(
            request,
            auth_type=webhook.auth_type,
            auth_username=webhook.auth_username,
            auth_secret_hash=webhook.auth_secret_hash,
            raw_body=raw_body,
        )
        if not auth.ok:
            await self._record(
                IngestEventLog(
                    tenant_id=webhook.tenant_id,
                    webhook_id=webhook.id,
                    category_id=webhook.category_id,
                    source_ip=source_ip,
                    auth_outcome="failed",
                    schema_outcome="skipped",
                    transform_outcome="skipped",
                    published=False,
                    error=f"auth failed: {auth.reason}",
                    raw_payload=raw_stored,
                    raw_truncated=raw_truncated,
                )
            )
            raise UnauthorizedError("unauthorized")

        row = await self.run_pipeline(
            webhook,
            payload=payload,
            source_ip=source_ip,
            auth_ok=True,
            is_replay=False,
            raw_stored=raw_stored,
            raw_truncated=raw_truncated,
        )
        if not row.published:
            # run_pipeline recorded the failure; surface the matching 422.
            raise ValidationError(row.error or "ingest failed", details={"log_id": row.id})
        # run_pipeline stashes the resolved (rule-driven) event_type on the service.
        return (getattr(self, "_resolved_event_type", None) or webhook.event_type or "ingest.event"), row.event_id

    async def run_pipeline(
        self,
        webhook: Webhook,
        *,
        payload: Any,
        source_ip: str | None,
        auth_ok: bool,
        is_replay: bool,
        raw_stored: Any = None,
        raw_truncated: bool | None = None,
    ) -> IngestEventLog:
        """Validate → transform → publish for a known, authed webhook.

        Records + returns ONE ``IngestEventLog`` row. Never raises on a
        validation/transform failure — the caller inspects ``row.published`` /
        ``row.error`` and decides the HTTP status. (A publish failure is logged
        with published=False and error set.)
        """
        if raw_stored is None and raw_truncated is None:
            raw_stored, raw_truncated = _cap_raw(payload)

        log = IngestEventLog(
            tenant_id=webhook.tenant_id,
            webhook_id=webhook.id,
            category_id=webhook.category_id,
            source_ip=source_ip,
            auth_outcome="ok" if auth_ok else "failed",
            schema_outcome="skipped",
            transform_outcome="skipped",
            published=False,
            raw_payload=raw_stored,
            raw_truncated=bool(raw_truncated),
            is_replay=is_replay,
        )

        # 1. Schema validation.
        v = validate_payload(payload, webhook.payload_schema or {})
        log.schema_outcome = "ok" if v.ok else "failed"
        if not v.ok:
            log.error = "schema: " + "; ".join(v.errors[:10])
            return await self._record(log)

        # 2. JMESPath transform (webhook-level).
        t = apply_transform(payload, webhook.transform or {})
        log.transform_outcome = "ok" if t.ok else "failed"
        if not t.ok:
            log.error = "transform: " + "; ".join(t.errors[:10])
            return await self._record(log)
        transformed = t.value or {}

        # 3. Payload-driven routing. If the webhook has enabled rules, walk them
        #    by priority; the FIRST match determines the emitted event_type (and
        #    optional target_domain), and its field_map re-extracts the payload.
        #    No rules (or no match) → fall back to the webhook's default.
        category = await self.db.get(IngestCategory, webhook.category_id)
        cat_domain = (category.target_domain if category else None) or "ingest"
        domain = cat_domain
        event_type = webhook.event_type or "ingest.event"

        rules = await _load_rules(self.db, webhook.id, only_enabled=True)
        if rules:
            rule, _results = match_first(transformed, rules)
            if rule is not None:
                log.matched_rule_id = rule.id
                event_type = rule.event_type or event_type
                if rule.target_domain:
                    domain = rule.target_domain
                # Apply the rule's field_map extraction (empty → keep transformed).
                if rule.field_map:
                    rt = apply_transform(transformed, rule.field_map)
                    if rt.ok and rt.value is not None:
                        transformed = rt.value

        log.transformed_payload = transformed
        # Stash the resolved type so handle()/replay callers can read it.
        self._resolved_event_type = event_type

        # 4. Resolve subject, then publish.
        tenant_id = str(webhook.tenant_id) if webhook.tenant_id else None
        event_id = str(uuid.uuid4())
        subj = subject(tenant_id, domain, "event.received")
        log.target_subject = subj

        try:
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
                    "matched_rule_id": log.matched_rule_id,
                    "data": transformed,
                },
            )
        except Exception as exc:  # noqa: BLE001 — publish failure must still be logged
            log.published = False
            log.error = f"publish failed: {exc}"
            return await self._record(log)

        log.published = True
        log.event_id = event_id
        return await self._record(log)
