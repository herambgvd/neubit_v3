"""Ingest routers.

Two router objects, split by trust boundary:

* ``config_router`` — the authed config API, mounted under the api_prefix →
  ``{prefix}/ingest/categories`` + ``{prefix}/ingest/webhooks``. JWT + permission
  gated (``ingest.read`` / ``ingest.manage``) and tenant-scoped.

* ``public_router`` — the PUBLIC receiver ``POST /ingest/hooks/{token}``. NO JWT:
  authenticated by the webhook's own per-webhook auth. Returns 202 on accept.
"""

from __future__ import annotations

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
    IngestResponse,
    WebhookCreate,
    WebhookListResponse,
    WebhookPublic,
    WebhookUpdate,
)
from .service import CategoryService, ReceiverService, WebhookService

# Permission keys this service gates on. Kernel grants if the JWT carries the key
# (or "*"/super-admin) — no local permission registry needed on a satellite.
PERM_READ = "ingest.read"
PERM_MANAGE = "ingest.manage"


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


# ── Public receiver ────────────────────────────────────────────────────

public_router = APIRouter(prefix="/ingest", tags=["Ingest (public)"])


def build_public_router(bus: EventBus) -> APIRouter:
    """Bind the receiver to the service's EventBus and return the public router."""

    @public_router.post(
        "/hooks/{token}",
        response_model=IngestResponse,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def receive(  # noqa: D401 — public webhook receiver (NO JWT dependency)
        token: str,
        request: Request,
        db: Annotated[AsyncSession, Depends(get_db)],
    ) -> IngestResponse:
        # Tolerant body parse — an empty body is a valid {} payload.
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        svc = ReceiverService(db, bus)
        _event_type, event_id = await svc.handle(token, request, payload)
        return IngestResponse(accepted=True, event_id=event_id)

    return public_router
