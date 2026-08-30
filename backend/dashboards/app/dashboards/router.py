"""Dashboards API — `{api_prefix}/dashboards/...`.

Authorisation is the pattern every satellite uses: the core-minted JWT is
verified LOCALLY with the shared secret, the tenant comes from the token claim
(never from the request), and each route declares the permission it needs.

    dashboards.read     list / open a dashboard
    dashboards.manage   create, edit, delete, move, resize

Both keys are registered in core's permission catalog
(`backend/core/app/auth/permissions.py`, group "Dashboards") so a tenant admin
can actually grant them in the role editor. That registration is not optional
book-keeping: `ingest.read` / `ingest.manage` are gated by the ingest service and
were never added to the catalog, with the result that no role can grant them and
only a wildcard admin can reach Ingest at all. A permission the catalog does not
know about is not a permission model.

Module gating (`analytics` — "Dashboards & Reports") and the licence check are
applied where the router is mounted, in `app.main`, so they cannot be forgotten
per route.

**This service serves definitions, not data.** A widget's numbers come from the
reading-writer's `POST /api/v1/bi/query`, which owns the readings schema and is
the only thing that executes a spec (contract §7). Nothing here opens
`neubit_reporting`.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Response, status
from kernel.auth import Principal, Scope, get_principal, get_scope, require_permission
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db

from .schemas import (
    DashboardCreate,
    DashboardDetail,
    DashboardListResponse,
    DashboardUpdate,
    LayoutSave,
    WidgetCreate,
    WidgetPublic,
    WidgetUpdate,
)
from .service import DashboardService

PERM_READ = "dashboards.read"
PERM_MANAGE = "dashboards.manage"

router = APIRouter(prefix="/dashboards", tags=["Dashboards"])


async def _service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> DashboardService:
    return DashboardService(db, scope)


Svc = Annotated[DashboardService, Depends(_service)]


def _detail(row) -> DashboardDetail:
    return DashboardDetail(
        id=row.id,
        name=row.name,
        slug=row.slug,
        description=row.description,
        grid_cols=row.grid_cols,
        row_height=row.row_height,
        widget_count=len(row.widgets),
        created_at=row.created_at,
        updated_at=row.updated_at,
        widgets=[WidgetPublic.model_validate(w) for w in row.widgets],
    )


# ── dashboards ───────────────────────────────────────────────────────────────


@router.get(
    "",
    response_model=DashboardListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_dashboards(
    svc: Svc,
    search: Optional[str] = Query(None, max_length=160),
) -> DashboardListResponse:
    items, total = await svc.list_(search=search)
    return DashboardListResponse(items=items, total=total)


@router.post(
    "",
    response_model=DashboardDetail,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def create_dashboard(
    svc: Svc,
    body: DashboardCreate,
    principal: Principal = Depends(get_principal),
) -> DashboardDetail:
    return _detail(await svc.create(body, created_by=principal.user_id))


@router.get(
    "/{dashboard_id}",
    response_model=DashboardDetail,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_dashboard(svc: Svc, dashboard_id: str) -> DashboardDetail:
    """The whole canvas — definition plus every widget, in one round trip.

    A viewer needs all of it before it can draw anything, and a second request per
    widget would make opening a dashboard N+1 calls before a single number is
    fetched.
    """
    return _detail(await svc.get(dashboard_id))


@router.patch(
    "/{dashboard_id}",
    response_model=DashboardDetail,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def update_dashboard(svc: Svc, dashboard_id: str, body: DashboardUpdate) -> DashboardDetail:
    return _detail(await svc.update(dashboard_id, body))


@router.delete(
    "/{dashboard_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def delete_dashboard(svc: Svc, dashboard_id: str) -> Response:
    await svc.delete(dashboard_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── widgets ──────────────────────────────────────────────────────────────────


@router.post(
    "/{dashboard_id}/widgets",
    response_model=WidgetPublic,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def add_widget(svc: Svc, dashboard_id: str, body: WidgetCreate) -> WidgetPublic:
    return WidgetPublic.model_validate(await svc.add_widget(dashboard_id, body))


@router.patch(
    "/{dashboard_id}/widgets/{widget_id}",
    response_model=WidgetPublic,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def update_widget(
    svc: Svc, dashboard_id: str, widget_id: str, body: WidgetUpdate
) -> WidgetPublic:
    return WidgetPublic.model_validate(await svc.update_widget(dashboard_id, widget_id, body))


@router.delete(
    "/{dashboard_id}/widgets/{widget_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def delete_widget(svc: Svc, dashboard_id: str, widget_id: str) -> Response:
    await svc.delete_widget(dashboard_id, widget_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put(
    "/{dashboard_id}/layout",
    response_model=DashboardDetail,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def save_layout(svc: Svc, dashboard_id: str, body: LayoutSave) -> DashboardDetail:
    """Persist the whole arrangement in one write. See `service.save_layout`."""
    return _detail(await svc.save_layout(dashboard_id, body.items))
