"""Ingest routers.

Two router objects, split by trust boundary:

* ``config_router`` — the authed config API, mounted under the api_prefix →
  ``{prefix}/ingest/categories`` + ``{prefix}/ingest/webhooks``. JWT + permission
  gated (``ingest.read`` / ``ingest.manage``) and tenant-scoped.

* ``public_router`` — the PUBLIC receiver ``POST /ingest/hooks/{slug}``. NO JWT:
  authenticated by the webhook's own per-webhook auth. Returns 202 on accept.
  The slug identifies the webhook; ``auth_type`` is what authorizes the caller.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_principal, get_scope, require_permission
from kernel.events import EventBus

from app.db import get_db

from .schemas import (
    CategoryCreate,
    CategoryListResponse,
    CategoryPublic,
    CategoryUpdate,
    EventLogDetail,
    EventLogListResponse,
    EventRuleCreate,
    EventRuleListResponse,
    EventRulePublic,
    EventRuleUpdate,
    EventStatus,
    IngestResponse,
    ReplayResponse,
    RotateSecretRequest,
    RotateSecretResponse,
    RuleTestRequest,
    RuleTestResponse,
    WebhookCreate,
    WebhookListResponse,
    WebhookPublic,
    WebhookTestRequest,
    WebhookTestResponse,
    WebhookUpdate,
)
from .service import (
    CategoryService,
    EventLogService,
    ReceiverService,
    RuleService,
    WebhookService,
)

# Permission keys this service gates on. Kernel grants if the JWT carries the key
# (or "*"/super-admin) — no local permission registry needed on a satellite.
PERM_READ = "ingest.read"
PERM_MANAGE = "ingest.manage"

# The service-wide EventBus, injected by main via ``bind_event_bus`` at app build.
# Used by the authed replay endpoint (which re-publishes to NATS). Falls back to a
# fresh, unconnected bus so imports never fail if binding is skipped (tests).
_bus: EventBus = EventBus(source="ingest")


def bind_event_bus(bus: EventBus) -> None:
    """Wire the live (connected) EventBus into the authed router (for replay)."""
    global _bus
    _bus = bus


# ── Authed config API ──────────────────────────────────────────────────

config_router = APIRouter(prefix="/ingest", tags=["Ingest"])


async def _category_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> CategoryService:
    return CategoryService(db, scope)


async def _webhook_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> WebhookService:
    return WebhookService(db, scope)


async def _rule_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> RuleService:
    return RuleService(db, scope)


# --- Categories ---


@config_router.get(
    "/categories",
    response_model=CategoryListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_categories(
    svc: Annotated[CategoryService, Depends(_category_service)],
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=500),
    search: Optional[str] = Query(None, max_length=100),
) -> CategoryListResponse:
    items, total = await svc.list_(skip=skip, limit=limit, search=search)
    return CategoryListResponse(items=items, total=total, skip=skip, limit=limit)


@config_router.post(
    "/categories",
    response_model=CategoryPublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_category(
    body: CategoryCreate,
    svc: Annotated[CategoryService, Depends(_category_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> CategoryPublic:
    return await svc.create(body, actor=actor)


@config_router.get(
    "/categories/{category_id}",
    response_model=CategoryPublic,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_category(
    category_id: str,
    svc: Annotated[CategoryService, Depends(_category_service)],
) -> CategoryPublic:
    return await svc.get(category_id)


@config_router.patch("/categories/{category_id}", response_model=CategoryPublic)
async def update_category(
    category_id: str,
    body: CategoryUpdate,
    svc: Annotated[CategoryService, Depends(_category_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> CategoryPublic:
    return await svc.update(category_id, body, actor=actor)


@config_router.delete(
    "/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_category(
    category_id: str,
    svc: Annotated[CategoryService, Depends(_category_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    await svc.delete(category_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Webhooks ---


@config_router.get(
    "/webhooks",
    response_model=WebhookListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_webhooks(
    svc: Annotated[WebhookService, Depends(_webhook_service)],
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=500),
    search: Optional[str] = Query(None, max_length=100),
    category_id: Optional[str] = Query(None, max_length=36),
) -> WebhookListResponse:
    items, total = await svc.list_(
        skip=skip, limit=limit, search=search, category_id=category_id
    )
    return WebhookListResponse(items=items, total=total, skip=skip, limit=limit)


@config_router.post(
    "/webhooks",
    response_model=WebhookPublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_webhook(
    body: WebhookCreate,
    svc: Annotated[WebhookService, Depends(_webhook_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> WebhookPublic:
    return await svc.create(body, actor=actor)


@config_router.get(
    "/webhooks/{webhook_id}",
    response_model=WebhookPublic,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_webhook(
    webhook_id: str,
    svc: Annotated[WebhookService, Depends(_webhook_service)],
) -> WebhookPublic:
    return await svc.get(webhook_id)


@config_router.patch("/webhooks/{webhook_id}", response_model=WebhookPublic)
async def update_webhook(
    webhook_id: str,
    body: WebhookUpdate,
    svc: Annotated[WebhookService, Depends(_webhook_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> WebhookPublic:
    return await svc.update(webhook_id, body, actor=actor)


@config_router.delete("/webhooks/{webhook_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_webhook(
    webhook_id: str,
    svc: Annotated[WebhookService, Depends(_webhook_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    await svc.delete(webhook_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@config_router.post(
    "/webhooks/{webhook_id}/test",
    response_model=WebhookTestResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def test_webhook(
    webhook_id: str,
    body: WebhookTestRequest,
    svc: Annotated[WebhookService, Depends(_webhook_service)],
) -> WebhookTestResponse:
    """Dry-run a sample payload through validate+transform. Nothing published/logged."""
    return await svc.test(webhook_id, body.payload)


@config_router.post(
    "/webhooks/{webhook_id}/rotate-secret",
    response_model=RotateSecretResponse,
)
async def rotate_webhook_secret(
    webhook_id: str,
    body: RotateSecretRequest,
    svc: Annotated[WebhookService, Depends(_webhook_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> RotateSecretResponse:
    """Mint a fresh auth secret, returned once. The URL/slug is not changed."""
    return await svc.rotate_secret(webhook_id, actor=actor)


# --- Event rules (payload-driven routing) ---


@config_router.get(
    "/webhooks/{webhook_id}/rules",
    response_model=EventRuleListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_rules(
    webhook_id: str,
    svc: Annotated[RuleService, Depends(_rule_service)],
) -> EventRuleListResponse:
    items = await svc.list_for_webhook(webhook_id)
    return EventRuleListResponse(items=items, total=len(items))


@config_router.post(
    "/webhooks/{webhook_id}/rules",
    response_model=EventRulePublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_rule(
    webhook_id: str,
    body: EventRuleCreate,
    svc: Annotated[RuleService, Depends(_rule_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> EventRulePublic:
    return await svc.create(webhook_id, body, actor=actor)


@config_router.get(
    "/event-rules/{rule_id}",
    response_model=EventRulePublic,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_rule(
    rule_id: str,
    svc: Annotated[RuleService, Depends(_rule_service)],
) -> EventRulePublic:
    return await svc.get(rule_id)


@config_router.patch("/event-rules/{rule_id}", response_model=EventRulePublic)
async def update_rule(
    rule_id: str,
    body: EventRuleUpdate,
    svc: Annotated[RuleService, Depends(_rule_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> EventRulePublic:
    return await svc.update(rule_id, body, actor=actor)


@config_router.delete(
    "/event-rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_rule(
    rule_id: str,
    svc: Annotated[RuleService, Depends(_rule_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    await svc.delete(rule_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@config_router.post(
    "/event-rules/{rule_id}/test",
    response_model=RuleTestResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def test_rule(
    rule_id: str,
    body: RuleTestRequest,
    svc: Annotated[RuleService, Depends(_rule_service)],
) -> RuleTestResponse:
    """Dry-run: evaluate the rule (or a proposed shape) against a sample payload."""
    return await svc.test(
        rule_id,
        body.payload,
        match_conditions=body.match_conditions,
        field_map=body.field_map,
    )


# --- Event logs ---


async def _event_log_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> EventLogService:
    return EventLogService(db, scope, _bus)


@config_router.get(
    "/event-logs",
    response_model=EventLogListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_event_logs(
    svc: Annotated[EventLogService, Depends(_event_log_service)],
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=500),
    webhook_id: Optional[str] = Query(None, max_length=36),
    # The single-value verdict the operator UI filters on (EventStatus).
    status: Optional[EventStatus] = Query(None),
    auth_outcome: Optional[str] = Query(None, pattern="^(ok|failed)$"),
    published: Optional[bool] = Query(None),
    since: Optional[datetime] = Query(None),
    until: Optional[datetime] = Query(None),
) -> EventLogListResponse:
    items, total = await svc.list_(
        skip=skip,
        limit=limit,
        webhook_id=webhook_id,
        status=status.value if status else None,
        auth_outcome=auth_outcome,
        published=published,
        since=since,
        until=until,
    )
    return EventLogListResponse(items=items, total=total, skip=skip, limit=limit)


@config_router.get(
    "/event-logs/{log_id}",
    response_model=EventLogDetail,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_event_log(
    log_id: str,
    svc: Annotated[EventLogService, Depends(_event_log_service)],
) -> EventLogDetail:
    return await svc.get(log_id)


@config_router.post(
    "/event-logs/{log_id}/replay",
    response_model=ReplayResponse,
)
async def replay_event_log(
    log_id: str,
    svc: Annotated[EventLogService, Depends(_event_log_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> ReplayResponse:
    """Re-run the stored raw payload through the webhook pipeline (new log row)."""
    row = await svc.replay(log_id)
    return ReplayResponse(
        replay_log_id=row.id,
        published=row.published,
        event_id=row.event_id,
        target_subject=row.target_subject,
        schema_outcome=row.schema_outcome,
        transform_outcome=row.transform_outcome,
        error=row.error,
    )


# ── Public receiver ────────────────────────────────────────────────────

public_router = APIRouter(prefix="/ingest", tags=["Ingest (public)"])


def build_public_router(bus: EventBus) -> APIRouter:
    """Bind the receiver to the service's EventBus and return the public router.

    Mounted for BOTH GET and POST: the service enforces the webhook's configured
    ``request_method``. For GET the payload is read from query params (repeated
    keys become arrays); for POST from the JSON body.
    """

    @public_router.api_route(
        "/hooks/{slug}",
        methods=["GET", "POST"],
        response_model=IngestResponse,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def receive(  # noqa: D401 — public webhook receiver (NO JWT dependency)
        slug: str,
        request: Request,
        db: Annotated[AsyncSession, Depends(get_db)],
    ) -> IngestResponse:
        raw_body = await request.body()
        if request.method.upper() == "GET":
            # Query params → payload. Repeated keys become arrays.
            payload: dict = {}
            for key, val in request.query_params.multi_items():
                if key in payload:
                    if isinstance(payload[key], list):
                        payload[key].append(val)
                    else:
                        payload[key] = [payload[key], val]
                else:
                    payload[key] = val
        else:
            # Tolerant body parse — an empty body is a valid {} payload.
            try:
                payload = await request.json() if raw_body else {}
            except Exception:
                payload = {}
        svc = ReceiverService(db, bus)
        _event_type, event_id = await svc.handle(slug, request, payload, raw_body)
        return IngestResponse(accepted=True, event_id=event_id)

    return public_router
