"""Threat-level REST API."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db
from . import schemas as S
from .service import ThreatLevelService


async def _threat_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return ThreatLevelService(db, scope)


# ── Threat level router ────────────────────────────────────────────────

threat_router = APIRouter(prefix="/workflow/threat-levels", tags=["Workflow · Threat Levels"])


@threat_router.get("", response_model=list[S.ThreatLevelPublic],
                   dependencies=[Depends(require_permission("workflow.threat_level.read"))])
async def list_threat_levels(svc: Annotated[ThreatLevelService, Depends(_threat_svc)]):
    return [S.ThreatLevelPublic.from_row(r) for r in await svc.list_()]


@threat_router.put("", response_model=S.ThreatLevelPublic)
async def set_threat_level(body: S.SetThreatLevelRequest, svc: Annotated[ThreatLevelService, Depends(_threat_svc)],
                           actor: Principal = Depends(require_permission("workflow.threat_level.update"))):
    return S.ThreatLevelPublic.from_row(await svc.set_level(body, actor=actor))


