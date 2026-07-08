"""Workflow REST API — permission-gated, tenant-scoped.

All routers mount under the service ``api_prefix`` (``/api/v1``) with a
``/workflow`` prefix, so paths are ``/api/v1/workflow/...``. Every endpoint is
gated by a ``workflow.*`` permission via ``kernel.auth.require_permission`` and
runs inside the caller's tenant scope (``get_scope``).

Permission keys used:
    workflow.sop.read/create/update/delete
    workflow.state.*  workflow.transition.*  workflow.trigger.*  workflow.form.*
    workflow.notification.*  workflow.threat_level.read/update
    workflow.instance.read/create/update
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db
from . import schemas as S
from .service import (
    AlertFormatService,
    FormService,
    InstanceService,
    NotificationService,
    SimulatorService,
    SopService,
    StateService,
    ThreatLevelService,
    TransitionService,
    TriggerService,
)


# ── DI helpers ─────────────────────────────────────────────────────────

async def _sop_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return SopService(db, scope)


async def _state_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return StateService(db, scope)


async def _trans_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return TransitionService(db, scope)


async def _trig_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return TriggerService(db, scope)


async def _form_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return FormService(db, scope)


async def _notif_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return NotificationService(db, scope)


async def _threat_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return ThreatLevelService(db, scope)


async def _inst_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return InstanceService(db, scope)


async def _format_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return AlertFormatService(db, scope)


async def _sim_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return SimulatorService(db, scope)


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


# ── Form router ────────────────────────────────────────────────────────

form_router = APIRouter(prefix="/workflow/forms", tags=["Workflow · Forms"])


@form_router.get("", response_model=list[S.FormPublic],
                 dependencies=[Depends(require_permission("workflow.form.read"))])
async def list_forms(svc: Annotated[FormService, Depends(_form_svc)],
                     skip: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200),
                     is_active: Optional[bool] = Query(None)):
    items, _ = await svc.list_(skip=skip, limit=limit, is_active=is_active)
    return [S.FormPublic.from_row(r) for r in items]


@form_router.post("", response_model=S.FormPublic, status_code=status.HTTP_201_CREATED)
async def create_form(body: S.CreateFormRequest, svc: Annotated[FormService, Depends(_form_svc)],
                      actor: Principal = Depends(require_permission("workflow.form.create"))):
    return S.FormPublic.from_row(await svc.create(body, actor=actor))


@form_router.get("/{form_id}", response_model=S.FormPublic,
                 dependencies=[Depends(require_permission("workflow.form.read"))])
async def get_form(form_id: str, svc: Annotated[FormService, Depends(_form_svc)]):
    return S.FormPublic.from_row(await svc.get(form_id))


@form_router.patch("/{form_id}", response_model=S.FormPublic)
async def update_form(form_id: str, body: S.UpdateFormRequest, svc: Annotated[FormService, Depends(_form_svc)],
                      actor: Principal = Depends(require_permission("workflow.form.update"))):
    return S.FormPublic.from_row(await svc.update(form_id, body, actor=actor))


@form_router.delete("/{form_id}", status_code=status.HTTP_204_NO_CONTENT,
                    dependencies=[Depends(require_permission("workflow.form.delete"))])
async def delete_form(form_id: str, svc: Annotated[FormService, Depends(_form_svc)]):
    await svc.delete(form_id)


# ── Notification templates + channels router ───────────────────────────

notification_router = APIRouter(prefix="/workflow/notifications", tags=["Workflow · Notifications"])


@notification_router.get("/templates", response_model=list[S.TemplatePublic],
                         dependencies=[Depends(require_permission("workflow.notification.read"))])
async def list_templates(svc: Annotated[NotificationService, Depends(_notif_svc)],
                         skip: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200)):
    items, _ = await svc.list_templates(skip=skip, limit=limit)
    return [S.TemplatePublic.from_row(r) for r in items]


@notification_router.post("/templates", response_model=S.TemplatePublic, status_code=status.HTTP_201_CREATED)
async def create_template(body: S.CreateTemplateRequest, svc: Annotated[NotificationService, Depends(_notif_svc)],
                          actor: Principal = Depends(require_permission("workflow.notification.create"))):
    return S.TemplatePublic.from_row(await svc.create_template(body, actor=actor))


@notification_router.patch("/templates/{template_id}", response_model=S.TemplatePublic)
async def update_template(template_id: str, body: S.UpdateTemplateRequest,
                          svc: Annotated[NotificationService, Depends(_notif_svc)],
                          actor: Principal = Depends(require_permission("workflow.notification.update"))):
    return S.TemplatePublic.from_row(await svc.update_template(template_id, body, actor=actor))


@notification_router.delete("/templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT,
                            dependencies=[Depends(require_permission("workflow.notification.delete"))])
async def delete_template(template_id: str, svc: Annotated[NotificationService, Depends(_notif_svc)]):
    await svc.delete_template(template_id)


@notification_router.get("/channels", response_model=list[S.ChannelPublic],
                         dependencies=[Depends(require_permission("workflow.notification.read"))])
async def list_channels(svc: Annotated[NotificationService, Depends(_notif_svc)],
                        skip: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200)):
    items, _ = await svc.list_channels(skip=skip, limit=limit)
    return [S.ChannelPublic.from_row(r) for r in items]


@notification_router.post("/channels", response_model=S.ChannelPublic, status_code=status.HTTP_201_CREATED)
async def create_channel(body: S.CreateChannelRequest, svc: Annotated[NotificationService, Depends(_notif_svc)],
                         actor: Principal = Depends(require_permission("workflow.notification.create"))):
    return S.ChannelPublic.from_row(await svc.create_channel(body, actor=actor))


@notification_router.patch("/channels/{channel_id}", response_model=S.ChannelPublic)
async def update_channel(channel_id: str, body: S.UpdateChannelRequest,
                         svc: Annotated[NotificationService, Depends(_notif_svc)],
                         actor: Principal = Depends(require_permission("workflow.notification.update"))):
    return S.ChannelPublic.from_row(await svc.update_channel(channel_id, body, actor=actor))


@notification_router.delete("/channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT,
                            dependencies=[Depends(require_permission("workflow.notification.delete"))])
async def delete_channel(channel_id: str, svc: Annotated[NotificationService, Depends(_notif_svc)]):
    await svc.delete_channel(channel_id)


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


# ── Instance router (the running incidents) ────────────────────────────

instance_router = APIRouter(prefix="/workflow/instances", tags=["Workflow · Instances"])


@instance_router.get("", response_model=S.InstanceListResponse,
                     dependencies=[Depends(require_permission("workflow.instance.read"))])
async def list_instances(svc: Annotated[InstanceService, Depends(_inst_svc)],
                         skip: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200),
                         status: Optional[str] = Query(None), priority: Optional[str] = Query(None),
                         site_id: Optional[str] = Query(None), sop_id: Optional[str] = Query(None),
                         assigned_to: Optional[str] = Query(None), q: Optional[str] = Query(None)):
    items, total = await svc.list_(skip=skip, limit=limit, status=status, priority=priority,
                                   site_id=site_id, sop_id=sop_id, assigned_to=assigned_to, q=q)
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


@instance_router.get("/{instance_id}/available-transitions", response_model=list[S.TransitionPublic],
                     dependencies=[Depends(require_permission("workflow.instance.read"))])
async def available_transitions(instance_id: str, svc: Annotated[InstanceService, Depends(_inst_svc)]):
    return [S.TransitionPublic.from_row(r) for r in await svc.get_available_transitions(instance_id)]


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


# All routers — mounted by app.main under the api_prefix.
routers = [
    sop_router,
    state_router,
    transition_router,
    trigger_router,
    alert_format_router,
    event_router,
    form_router,
    notification_router,
    threat_router,
    instance_router,
]
