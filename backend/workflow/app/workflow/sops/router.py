"""SOP / state / transition REST API.

Three routers, mounted in the order SOP → state → transition. States and
transitions are nested under ``/workflow/sops/{sop_id}`` and reuse the SOP's
permission keys (``workflow.sop.read`` to list, ``workflow.sop.update`` to
change the graph) — editing a state IS editing its SOP, and a second permission
family would be one an operator could hold without the first.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db
from . import schemas as S
from .service import SopService, StateService, TransitionService


async def _sop_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return SopService(db, scope)


async def _state_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return StateService(db, scope)


async def _trans_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return TransitionService(db, scope)


# ── SOP router ─────────────────────────────────────────────────────────

sop_router = APIRouter(prefix="/workflow/sops", tags=["Workflow · SOPs"])


@sop_router.get("", response_model=S.SopListResponse,
                dependencies=[Depends(require_permission("workflow.sop.read"))])
async def list_sops(svc: Annotated[SopService, Depends(_sop_svc)],
                    skip: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200),
                    is_active: Optional[bool] = Query(None), tag: Optional[str] = Query(None)):
    items, total = await svc.list_(skip=skip, limit=limit, is_active=is_active, tag=tag)
    return S.SopListResponse(items=[S.SopPublic.from_row(r) for r in items],
                             total=total, skip=skip, limit=limit)


@sop_router.post("", response_model=S.SopPublic, status_code=status.HTTP_201_CREATED)
async def create_sop(body: S.CreateSopRequest, svc: Annotated[SopService, Depends(_sop_svc)],
                     actor: Principal = Depends(require_permission("workflow.sop.create"))):
    return S.SopPublic.from_row(await svc.create(body, actor=actor))


@sop_router.get("/{sop_id}", response_model=S.SopPublic,
                dependencies=[Depends(require_permission("workflow.sop.read"))])
async def get_sop(sop_id: str, svc: Annotated[SopService, Depends(_sop_svc)]):
    return S.SopPublic.from_row(await svc.get(sop_id))


@sop_router.patch("/{sop_id}", response_model=S.SopPublic)
async def update_sop(sop_id: str, body: S.UpdateSopRequest, svc: Annotated[SopService, Depends(_sop_svc)],
                     actor: Principal = Depends(require_permission("workflow.sop.update"))):
    return S.SopPublic.from_row(await svc.update(sop_id, body, actor=actor))


@sop_router.delete("/{sop_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_sop(sop_id: str, svc: Annotated[SopService, Depends(_sop_svc)],
                     actor: Principal = Depends(require_permission("workflow.sop.delete"))):
    await svc.delete(sop_id, actor=actor)


# ── State router (nested under a SOP) ──────────────────────────────────

state_router = APIRouter(prefix="/workflow/sops/{sop_id}/states", tags=["Workflow · States"])


@state_router.get("", response_model=list[S.StatePublic],
                  dependencies=[Depends(require_permission("workflow.sop.read"))])
async def list_states(sop_id: str, svc: Annotated[StateService, Depends(_state_svc)]):
    return [S.StatePublic.from_row(r) for r in await svc.list_(sop_id)]


@state_router.post("", response_model=S.StatePublic, status_code=status.HTTP_201_CREATED)
async def create_state(sop_id: str, body: S.CreateStateRequest, svc: Annotated[StateService, Depends(_state_svc)],
                       actor: Principal = Depends(require_permission("workflow.sop.update"))):
    return S.StatePublic.from_row(await svc.create(sop_id, body, actor=actor))


@state_router.patch("/{state_id}", response_model=S.StatePublic)
async def update_state(sop_id: str, state_id: str, body: S.UpdateStateRequest,
                       svc: Annotated[StateService, Depends(_state_svc)],
                       actor: Principal = Depends(require_permission("workflow.sop.update"))):
    return S.StatePublic.from_row(await svc.update(state_id, body, actor=actor))


@state_router.delete("/{state_id}", status_code=status.HTTP_204_NO_CONTENT,
                     dependencies=[Depends(require_permission("workflow.sop.update"))])
async def delete_state(sop_id: str, state_id: str, svc: Annotated[StateService, Depends(_state_svc)]):
    await svc.delete(state_id)


# ── Transition router (nested under a SOP) ─────────────────────────────

transition_router = APIRouter(prefix="/workflow/sops/{sop_id}/transitions", tags=["Workflow · Transitions"])


@transition_router.get("", response_model=list[S.TransitionPublic],
                       dependencies=[Depends(require_permission("workflow.sop.read"))])
async def list_transitions(sop_id: str, svc: Annotated[TransitionService, Depends(_trans_svc)]):
    return [S.TransitionPublic.from_row(r) for r in await svc.list_(sop_id)]


@transition_router.post("", response_model=S.TransitionPublic, status_code=status.HTTP_201_CREATED)
async def create_transition(sop_id: str, body: S.CreateTransitionRequest,
                            svc: Annotated[TransitionService, Depends(_trans_svc)],
                            actor: Principal = Depends(require_permission("workflow.sop.update"))):
    return S.TransitionPublic.from_row(await svc.create(sop_id, body, actor=actor))


@transition_router.patch("/{transition_id}", response_model=S.TransitionPublic)
async def update_transition(sop_id: str, transition_id: str, body: S.UpdateTransitionRequest,
                            svc: Annotated[TransitionService, Depends(_trans_svc)],
                            actor: Principal = Depends(require_permission("workflow.sop.update"))):
    return S.TransitionPublic.from_row(await svc.update(transition_id, body, actor=actor))


@transition_router.delete("/{transition_id}", status_code=status.HTTP_204_NO_CONTENT,
                          dependencies=[Depends(require_permission("workflow.sop.update"))])
async def delete_transition(sop_id: str, transition_id: str, svc: Annotated[TransitionService, Depends(_trans_svc)]):
    await svc.delete(transition_id)


