"""Trigger / alert-format / event-simulator REST API.

Mounted in the order trigger → alert format → simulator. The simulator lives on
``/workflow/events`` rather than under ``/workflow/triggers`` because a dry run
matches BOTH a trigger and an alert format; it is gated on
``workflow.instance.create`` because a non-dry run really does create incidents.
Alert formats reuse the ``workflow.sop.*`` keys — a format is a SOP mapping, and
it was never given a permission family of its own.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db
from . import schemas as S
from .service import AlertFormatService, SimulatorService, TriggerService


async def _trig_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return TriggerService(db, scope)


async def _format_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return AlertFormatService(db, scope)


async def _sim_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return SimulatorService(db, scope)


# ── Trigger router ─────────────────────────────────────────────────────

trigger_router = APIRouter(prefix="/workflow/triggers", tags=["Workflow · Triggers"])


@trigger_router.get("", response_model=S.TriggerListResponse,
                    dependencies=[Depends(require_permission("workflow.trigger.read"))])
async def list_triggers(svc: Annotated[TriggerService, Depends(_trig_svc)],
                        skip: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200),
                        enabled: Optional[bool] = Query(None), event_type: Optional[str] = Query(None)):
    items, total = await svc.list_(skip=skip, limit=limit, enabled=enabled, event_type=event_type)
    return S.TriggerListResponse(items=[S.TriggerPublic.from_row(r) for r in items],
                                 total=total, skip=skip, limit=limit)


@trigger_router.post("", response_model=S.TriggerPublic, status_code=status.HTTP_201_CREATED)
async def create_trigger(body: S.CreateTriggerRequest, svc: Annotated[TriggerService, Depends(_trig_svc)],
                         actor: Principal = Depends(require_permission("workflow.trigger.create"))):
    return S.TriggerPublic.from_row(await svc.create(body, actor=actor))


@trigger_router.get("/{trigger_id}", response_model=S.TriggerPublic,
                    dependencies=[Depends(require_permission("workflow.trigger.read"))])
async def get_trigger(trigger_id: str, svc: Annotated[TriggerService, Depends(_trig_svc)]):
    return S.TriggerPublic.from_row(await svc.get(trigger_id))


@trigger_router.patch("/{trigger_id}", response_model=S.TriggerPublic)
async def update_trigger(trigger_id: str, body: S.UpdateTriggerRequest,
                         svc: Annotated[TriggerService, Depends(_trig_svc)],
                         actor: Principal = Depends(require_permission("workflow.trigger.update"))):
    return S.TriggerPublic.from_row(await svc.update(trigger_id, body, actor=actor))


@trigger_router.delete("/{trigger_id}", status_code=status.HTTP_204_NO_CONTENT,
                       dependencies=[Depends(require_permission("workflow.trigger.delete"))])
async def delete_trigger(trigger_id: str, svc: Annotated[TriggerService, Depends(_trig_svc)]):
    await svc.delete(trigger_id)


@trigger_router.post("/{trigger_id}/enable", response_model=S.TriggerPublic)
async def enable_trigger(trigger_id: str, svc: Annotated[TriggerService, Depends(_trig_svc)],
                         actor: Principal = Depends(require_permission("workflow.trigger.update"))):
    return S.TriggerPublic.from_row(await svc.set_enabled(trigger_id, True, actor=actor))


@trigger_router.post("/{trigger_id}/disable", response_model=S.TriggerPublic)
async def disable_trigger(trigger_id: str, svc: Annotated[TriggerService, Depends(_trig_svc)],
                          actor: Principal = Depends(require_permission("workflow.trigger.update"))):
    return S.TriggerPublic.from_row(await svc.set_enabled(trigger_id, False, actor=actor))


# ── Alert format router (alert_code → SOP mapping) ─────────────────────

alert_format_router = APIRouter(prefix="/workflow/alert-formats", tags=["Workflow · Alert Formats"])


@alert_format_router.get("", response_model=S.AlertFormatListResponse,
                         dependencies=[Depends(require_permission("workflow.sop.read"))])
async def list_alert_formats(svc: Annotated[AlertFormatService, Depends(_format_svc)],
                             skip: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200),
                             is_active: Optional[bool] = Query(None)):
    items, total = await svc.list_(skip=skip, limit=limit, is_active=is_active)
    return S.AlertFormatListResponse(items=[S.AlertFormatPublic.from_row(r) for r in items],
                                     total=total, skip=skip, limit=limit)


@alert_format_router.post("", response_model=S.AlertFormatPublic, status_code=status.HTTP_201_CREATED)
async def create_alert_format(body: S.CreateAlertFormatRequest,
                              svc: Annotated[AlertFormatService, Depends(_format_svc)],
                              actor: Principal = Depends(require_permission("workflow.sop.create"))):
    return S.AlertFormatPublic.from_row(await svc.create(body, actor=actor))


@alert_format_router.get("/{format_id}", response_model=S.AlertFormatPublic,
                         dependencies=[Depends(require_permission("workflow.sop.read"))])
async def get_alert_format(format_id: str, svc: Annotated[AlertFormatService, Depends(_format_svc)]):
    return S.AlertFormatPublic.from_row(await svc.get(format_id))


@alert_format_router.patch("/{format_id}", response_model=S.AlertFormatPublic)
async def update_alert_format(format_id: str, body: S.UpdateAlertFormatRequest,
                              svc: Annotated[AlertFormatService, Depends(_format_svc)],
                              actor: Principal = Depends(require_permission("workflow.sop.update"))):
    return S.AlertFormatPublic.from_row(await svc.update(format_id, body, actor=actor))


@alert_format_router.delete("/{format_id}", status_code=status.HTTP_204_NO_CONTENT,
                            dependencies=[Depends(require_permission("workflow.sop.delete"))])
async def delete_alert_format(format_id: str, svc: Annotated[AlertFormatService, Depends(_format_svc)]):
    await svc.delete(format_id)


# ── Event simulator router ─────────────────────────────────────────────

event_router = APIRouter(prefix="/workflow/events", tags=["Workflow · Events"])


@event_router.post("/simulate", response_model=S.SimulateEventResponse)
async def simulate_event(body: S.SimulateEventRequest,
                         svc: Annotated[SimulatorService, Depends(_sim_svc)],
                         actor: Principal = Depends(require_permission("workflow.instance.create"))):
    return S.SimulateEventResponse(**await svc.simulate(body, actor=actor))


