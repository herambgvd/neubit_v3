"""Dashboard router (G2) — permission-gated, tenant-scoped.

Mounted under the service api_prefix (``/api/v1``) with the ``/vms`` domain prefix, so
the path is ``GET /api/v1/vms/dashboard/summary``. Gated on ``vms.camera.read`` (the
same read permission the health/cameras surface uses; the tenant-admin ``*`` wildcard
grants it). Runs in the caller's tenant scope. The caller's JWT is forwarded to the Go
``nvr`` for the best-effort node/resilience status (degrades to ``unknown`` if the nvr
is unreachable — never blocks the response).
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, _bearer, get_scope, require_permission

from app.db import get_db

from .schemas import DashboardSummary
from .service import DashboardService

PERM_READ = "vms.camera.read"

router = APIRouter(prefix="/vms", tags=["VMS Dashboard"])


def _bearer_token(
    cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str | None:
    return cred.credentials if cred else None


async def get_dashboard_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    bearer: Annotated[Optional[str], Depends(_bearer_token)] = None,
) -> DashboardService:
    return DashboardService(db, scope, bearer=bearer)


@router.get(
    "/dashboard/summary",
    response_model=DashboardSummary,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def dashboard_summary(
    svc: Annotated[DashboardService, Depends(get_dashboard_service)],
) -> DashboardSummary:
    """One live ops-dashboard rollup: cameras, recording, storage, nodes, alarms, NVRs.

    All sections best-effort; an empty tenant returns zeros and an unreachable nvr marks
    the node section ``unknown`` — never a 5xx.
    """
    return await svc.summary()
