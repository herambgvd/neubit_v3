"""Linkage-rule router (P5-B) — CRUD + fire-audit, permission-gated, tenant-scoped.

Mounted under the service api_prefix (``/api/v1``) with the ``/vms`` domain prefix →
``/api/v1/vms/linkage-rules`` etc. Writes gate on ``vms.config.manage`` (the same key
camera config gates on; the tenant-admin ``*`` wildcard grants it); reads gate on
``vms.camera.read``. Every endpoint runs inside the caller's tenant scope.

Endpoints:
  * ``POST   /vms/linkage-rules``            — create a rule.
  * ``GET    /vms/linkage-rules``            — list rules (trigger/active filters).
  * ``GET    /vms/linkage-rules/{id}``       — one rule.
  * ``PATCH  /vms/linkage-rules/{id}``       — update a rule.
  * ``DELETE /vms/linkage-rules/{id}``       — delete a rule.
  * ``GET    /vms/linkage-fires``            — the rule-fire audit log (rule/camera filters).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db

from .schemas import (
    LinkageFireListResponse,
    LinkageRuleCreate,
    LinkageRuleListResponse,
    LinkageRulePublic,
    LinkageRuleUpdate,
)
from .service import LinkageRuleService

PERM_READ = "vms.camera.read"
PERM_MANAGE = "vms.config.manage"

router = APIRouter(prefix="/vms", tags=["VMS Linkage"])


async def get_linkage_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> LinkageRuleService:
    return LinkageRuleService(db, scope)


@router.post(
    "/linkage-rules",
    response_model=LinkageRulePublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_rule(
    body: LinkageRuleCreate,
    svc: Annotated[LinkageRuleService, Depends(get_linkage_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> LinkageRulePublic:
    return await svc.create(body, actor=actor)


@router.get(
    "/linkage-rules",
    response_model=LinkageRuleListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_rules(
    svc: Annotated[LinkageRuleService, Depends(get_linkage_service)],
    trigger_event_type: str | None = Query(None, max_length=48),
    is_active: bool | None = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
) -> LinkageRuleListResponse:
    return await svc.list_(
        trigger_event_type=trigger_event_type,
        is_active=is_active,
        skip=skip,
        limit=limit,
    )


@router.get(
    "/linkage-fires",
    response_model=LinkageFireListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_fires(
    svc: Annotated[LinkageRuleService, Depends(get_linkage_service)],
    rule_id: str | None = Query(None, max_length=36),
    camera_id: str | None = Query(None, max_length=36),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
) -> LinkageFireListResponse:
    """The rule-fire audit log (newest first) — which rule fired what, when."""
    return await svc.list_fires(rule_id=rule_id, camera_id=camera_id, skip=skip, limit=limit)


@router.get(
    "/linkage-rules/{rule_id}",
    response_model=LinkageRulePublic,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_rule(
    rule_id: str,
    svc: Annotated[LinkageRuleService, Depends(get_linkage_service)],
) -> LinkageRulePublic:
    return await svc.get(rule_id)


@router.patch(
    "/linkage-rules/{rule_id}",
    response_model=LinkageRulePublic,
)
async def update_rule(
    rule_id: str,
    body: LinkageRuleUpdate,
    svc: Annotated[LinkageRuleService, Depends(get_linkage_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> LinkageRulePublic:
    return await svc.update(rule_id, body, actor=actor)


@router.delete(
    "/linkage-rules/{rule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def delete_rule(
    rule_id: str,
    svc: Annotated[LinkageRuleService, Depends(get_linkage_service)],
) -> None:
    await svc.delete(rule_id)
