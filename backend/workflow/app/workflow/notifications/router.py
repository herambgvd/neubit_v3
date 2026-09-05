"""Notification REST API — templates, channels and device tokens on one router.

One ``APIRouter`` for all three because they are one prefix
(``/workflow/notifications``) and one permission family
(``workflow.notification.*``); splitting the router would change the paths, and
the paths are the contract.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db
from . import schemas as S
from .service import DeviceTokenService, NotificationService


async def _notif_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return NotificationService(db, scope)


async def _device_svc(db: Annotated[AsyncSession, Depends(get_db)], scope: Scope = Depends(get_scope)):
    return DeviceTokenService(db, scope)


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


# -- device tokens (mobile push registration; the current user's own devices) --
#
# Reuses the notification-domain permissions: any user who can read notifications
# may register/list/unregister THEIR OWN push device tokens. Registration is
# self-service (the row is stamped with the caller's user_id + tenant), so these
# are the right gate — no new permission catalog entry (that lives in core).


@notification_router.get("/devices", response_model=list[S.DeviceTokenPublic],
                         dependencies=[Depends(require_permission("workflow.notification.read"))])
async def list_device_tokens(svc: Annotated[DeviceTokenService, Depends(_device_svc)],
                             actor: Principal = Depends(require_permission("workflow.notification.read"))):
    return [S.DeviceTokenPublic.from_row(r) for r in await svc.list_mine(actor=actor)]


@notification_router.post("/devices", response_model=S.DeviceTokenPublic,
                          status_code=status.HTTP_201_CREATED)
async def register_device_token(body: S.RegisterDeviceTokenRequest,
                                svc: Annotated[DeviceTokenService, Depends(_device_svc)],
                                actor: Principal = Depends(require_permission("workflow.notification.read"))):
    return S.DeviceTokenPublic.from_row(await svc.register(body, actor=actor))


@notification_router.delete("/devices", status_code=status.HTTP_204_NO_CONTENT)
async def unregister_device_token_by_token(body: S.UnregisterDeviceTokenRequest,
                                           svc: Annotated[DeviceTokenService, Depends(_device_svc)],
                                           actor: Principal = Depends(require_permission("workflow.notification.read"))):
    await svc.unregister_by_token(body.platform, body.token, actor=actor)


@notification_router.delete("/devices/{device_token_id}", status_code=status.HTTP_204_NO_CONTENT)
async def unregister_device_token(device_token_id: str,
                                  svc: Annotated[DeviceTokenService, Depends(_device_svc)],
                                  actor: Principal = Depends(require_permission("workflow.notification.read"))):
    await svc.unregister(device_token_id, actor=actor)


