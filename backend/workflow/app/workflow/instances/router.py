"""Incident (workflow-instance) REST API.

``available-transitions`` answers with ``sops.schemas.TransitionPublic`` — the
same body the SOP editor returns — so an operator UI can render the buttons from
one model. That import is the only reason this router reaches into another
feature's schemas, and it is one-directional.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db
from ..sops.schemas import TransitionPublic
from . import schemas as S
from .service import InstanceService


async def _inst_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return InstanceService(db, scope)


# ── Instance router (the running incidents) ────────────────────────────

instance_router = APIRouter(prefix="/workflow/instances", tags=["Workflow · Instances"])


@instance_router.get("", response_model=S.InstanceListResponse,
                     dependencies=[Depends(require_permission("workflow.instance.read"))])
async def list_instances(svc: Annotated[InstanceService, Depends(_inst_svc)],
                         skip: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200),
                         status: Optional[str] = Query(None), priority: Optional[str] = Query(None),
                         site_id: Optional[str] = Query(None), sop_id: Optional[str] = Query(None),
                         assigned_to: Optional[str] = Query(None), q: Optional[str] = Query(None),
                         event_id: Optional[str] = Query(
                             None,
                             description="Cross-link: incidents spawned by this originating event id "
                                         "(matches the envelope id OR trigger_data.payload.event_id — "
                                         "so a camera-event id finds the incident it raised).",
                         ),
                         source: Optional[str] = Query(
                             None,
                             description="Originating domain source: 'vision' (camera events), 'access', "
                                         "'ingest', … or 'manual' for operator-raised incidents.",
                         )):
    items, total = await svc.list_(skip=skip, limit=limit, status=status, priority=priority,
                                   site_id=site_id, sop_id=sop_id, assigned_to=assigned_to, q=q,
                                   event_id=event_id, source=source)
    return S.InstanceListResponse(items=[S.InstancePublic.from_row(r) for r in items],
                                  total=total, skip=skip, limit=limit)


@instance_router.post("", response_model=S.InstancePublic, status_code=status.HTTP_201_CREATED)
async def create_instance(body: S.CreateInstanceRequest, svc: Annotated[InstanceService, Depends(_inst_svc)],
                          actor: Principal = Depends(require_permission("workflow.instance.create"))):
    return S.InstancePublic.from_row(await svc.create(body, actor=actor))


@instance_router.get("/stats", response_model=S.InstanceStatsResponse,
                     dependencies=[Depends(require_permission("workflow.instance.read"))])
async def instance_stats(svc: Annotated[InstanceService, Depends(_inst_svc)],
                         site_id: Optional[str] = Query(None)):
    return S.InstanceStatsResponse(**await svc.stats(site_id=site_id))


@instance_router.get("/{instance_id}", response_model=S.InstancePublic,
                     dependencies=[Depends(require_permission("workflow.instance.read"))])
async def get_instance(instance_id: str, svc: Annotated[InstanceService, Depends(_inst_svc)]):
    return S.InstancePublic.from_row(await svc.get(instance_id))


@instance_router.get("/{instance_id}/pdf",
                     dependencies=[Depends(require_permission("workflow.instance.read"))])
async def instance_pdf(instance_id: str, svc: Annotated[InstanceService, Depends(_inst_svc)]):
    pdf_bytes = await svc.render_pdf(instance_id)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="incident-{instance_id}.pdf"'},
    )


@instance_router.get("/{instance_id}/available-transitions", response_model=list[TransitionPublic],
                     dependencies=[Depends(require_permission("workflow.instance.read"))])
async def available_transitions(instance_id: str, svc: Annotated[InstanceService, Depends(_inst_svc)]):
    return [TransitionPublic.from_row(r) for r in await svc.get_available_transitions(instance_id)]


@instance_router.patch("/{instance_id}/transition", response_model=S.InstancePublic)
async def transition_instance(instance_id: str, body: S.TransitionInstanceRequest,
                              svc: Annotated[InstanceService, Depends(_inst_svc)],
                              actor: Principal = Depends(require_permission("workflow.instance.update"))):
    return S.InstancePublic.from_row(await svc.transition(instance_id, body, actor=actor))


@instance_router.patch("/{instance_id}/assign", response_model=S.InstancePublic)
async def assign_instance(instance_id: str, body: S.AssignInstanceRequest,
                          svc: Annotated[InstanceService, Depends(_inst_svc)],
                          actor: Principal = Depends(require_permission("workflow.instance.update"))):
    return S.InstancePublic.from_row(await svc.assign(instance_id, body, actor=actor))


@instance_router.patch("/{instance_id}/status", response_model=S.InstancePublic)
async def change_instance_status(instance_id: str, body: S.StatusChangeRequest,
                                 svc: Annotated[InstanceService, Depends(_inst_svc)],
                                 actor: Principal = Depends(require_permission("workflow.instance.update"))):
    return S.InstancePublic.from_row(await svc.change_status(instance_id, body, actor=actor))


@instance_router.patch("/{instance_id}/escalate", response_model=S.InstancePublic)
async def escalate_instance(instance_id: str, body: S.EscalateInstanceRequest,
                            svc: Annotated[InstanceService, Depends(_inst_svc)],
                            actor: Principal = Depends(require_permission("workflow.instance.update"))):
    return S.InstancePublic.from_row(await svc.escalate(instance_id, body, actor=actor))


