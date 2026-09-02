"""Device / fleet-management router — permission-gated, tenant-scoped (G7).

Mounted under the service api_prefix (``/api/v1``) with the ``/vms`` domain prefix.
Fleet ops on onboarded cameras via the multi-brand driver seam:

  * ``GET  /vms/cameras/{id}/device-info``     → firmware / identity (read).
  * ``POST /vms/cameras/{id}/reboot``          → reboot the device.
  * ``POST /vms/cameras/{id}/ntp`` {server}     → set NTP server.
  * ``POST /vms/cameras/{id}/config-backup``    → download the device config blob.
  * ``POST /vms/cameras/{id}/config-restore``   → restore a config blob (base64 body).
  * ``POST /vms/cameras/{id}/password`` {user,new_password} → change a device account pw.
  * ``POST /vms/cameras/bulk/{action}``         → fan out reboot|ntp|password best-effort.

Reads gate on ``vms.camera.read``; every write gates on ``vms.config.manage`` (the config-
admin permission; the ``*`` wildcard grants either). All run in the caller's tenant scope.

Registration order note: these paths are DEEPER than the camera router's
``/cameras/{camera_id}`` catch-all, EXCEPT ``/cameras/bulk/{action}`` — but the camera
router's own ``POST /cameras/bulk`` is a distinct literal, and this router mounts BEFORE
the camera router (see app.vms.__init__) so ``/cameras/bulk/{action}`` matches here rather
than resolving to ``get_camera("bulk")``.

Graceful: fleet ops return a result envelope (never a driver 502) — ``ok=False`` when the
device is unreachable / the brand doesn't support the op. config-backup 502s only when the
blob is genuinely unavailable (so the download can't be produced). # LIVE-VALIDATE: the
real on-device effect (reboot/restore/password) needs the owner's hardware.
"""

from __future__ import annotations

import base64
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db
from app.vms.groups.acl import enforce_camera_privilege

from .schemas import (
    BULK_ACTIONS,
    BulkOpBody,
    BulkOpResult,
    ConfigRestoreBody,
    DeviceInfoPublic,
    FleetOpPublic,
    NtpBody,
    PasswordBody,
    UserAddBody,
)
from .service import DeviceMgmtService, device_info_dict, fleet_op_dict

from app.vms.cameras.schemas import StreamPolicyBulkBody, StreamPolicyBulkResult
from app.vms.cameras.service import CameraService

PERM_READ = "vms.camera.read"
PERM_MANAGE = "vms.config.manage"

router = APIRouter(prefix="/vms", tags=["VMS Device Management"])


async def get_devicemgmt_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> DeviceMgmtService:
    return DeviceMgmtService(db, scope)


async def get_camera_service_dm(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> CameraService:
    return CameraService(db, scope)


# ── bulk stream-codec policy (G8) — registered BEFORE ``/cameras/bulk/{action}`` so the
# literal ``/cameras/bulk/apply-stream-policy`` matches here rather than being captured as
# ``action="apply-stream-policy"`` (which isn't a fleet BULK_ACTION). Mirrors the G7 bulk
# contract (per-camera results, tenant isolation, one failure never aborts the batch).
@router.post("/cameras/bulk/apply-stream-policy", response_model=StreamPolicyBulkResult)
async def bulk_apply_stream_policy(
    body: StreamPolicyBulkBody,
    svc: Annotated[CameraService, Depends(get_camera_service_dm)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> StreamPolicyBulkResult:
    """Fan out the force-H.264-web policy across ``camera_ids`` (best-effort). Push each
    camera's SUB stream to H.264 so browsers play live with zero transcode; per-camera
    result envelope (never aborts the batch, foreign-tenant ids drop out)."""
    return StreamPolicyBulkResult(**await svc.bulk_apply_stream_policy(body.camera_ids, force=body.force))


# ── bulk fan-out (registered BEFORE the {camera_id} paths so /bulk/{action} wins) ──
@router.post("/cameras/bulk/{action}", response_model=BulkOpResult)
async def bulk_fleet_op(
    action: str,
    body: BulkOpBody,
    svc: Annotated[DeviceMgmtService, Depends(get_devicemgmt_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> BulkOpResult:
    if action not in BULK_ACTIONS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"action must be one of {sorted(BULK_ACTIONS)}",
        )
    result = await svc.bulk(
        action,
        body.camera_ids,
        server=body.server,
        user=body.user,
        new_password=body.new_password,
    )
    return BulkOpResult(**result)


# ── per-camera ops ─────────────────────────────────────────────────────
@router.get(
    "/cameras/{camera_id}/device-info",
    response_model=DeviceInfoPublic,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_device_info(
    camera_id: str,
    svc: Annotated[DeviceMgmtService, Depends(get_devicemgmt_service)],
    refresh: bool = False,
) -> DeviceInfoPublic:
    # Served from the identity cached on the camera row; ?refresh=true re-probes the device.
    info = await svc.device_info(camera_id, refresh=refresh)
    return DeviceInfoPublic(**device_info_dict(info))


@router.post("/cameras/{camera_id}/reboot", response_model=FleetOpPublic)
async def reboot_camera(
    camera_id: str,
    svc: Annotated[DeviceMgmtService, Depends(get_devicemgmt_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> FleetOpPublic:
    # Per-camera ACL: device-config WRITE requires the fine-grained config grant (if any).
    await enforce_camera_privilege(
        svc.db, scope=svc.scope, principal=actor, camera_id=camera_id, privilege="config"
    )
    return FleetOpPublic(**fleet_op_dict(await svc.reboot(camera_id)))


@router.post("/cameras/{camera_id}/ntp", response_model=FleetOpPublic)
async def set_ntp(
    camera_id: str,
    body: NtpBody,
    svc: Annotated[DeviceMgmtService, Depends(get_devicemgmt_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> FleetOpPublic:
    await enforce_camera_privilege(
        svc.db, scope=svc.scope, principal=actor, camera_id=camera_id, privilege="config"
    )
    return FleetOpPublic(**fleet_op_dict(await svc.set_ntp(camera_id, body.server)))


@router.post("/cameras/{camera_id}/password", response_model=FleetOpPublic)
async def set_password(
    camera_id: str,
    body: PasswordBody,
    svc: Annotated[DeviceMgmtService, Depends(get_devicemgmt_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> FleetOpPublic:
    await enforce_camera_privilege(
        svc.db, scope=svc.scope, principal=actor, camera_id=camera_id, privilege="config"
    )
    return FleetOpPublic(
        **fleet_op_dict(await svc.set_password(camera_id, user=body.user, new_password=body.new_password))
    )


# ── ONVIF user management (list / add / delete device accounts) ──────────────
@router.get("/cameras/{camera_id}/users", response_model=FleetOpPublic)
async def list_users(
    camera_id: str,
    svc: Annotated[DeviceMgmtService, Depends(get_devicemgmt_service)],
    _actor: Principal = Depends(require_permission(PERM_READ)),
) -> FleetOpPublic:
    return FleetOpPublic(**fleet_op_dict(await svc.list_users(camera_id)))


@router.post("/cameras/{camera_id}/users", response_model=FleetOpPublic)
async def add_user(
    camera_id: str,
    body: UserAddBody,
    svc: Annotated[DeviceMgmtService, Depends(get_devicemgmt_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> FleetOpPublic:
    await enforce_camera_privilege(
        svc.db, scope=svc.scope, principal=actor, camera_id=camera_id, privilege="config"
    )
    return FleetOpPublic(
        **fleet_op_dict(
            await svc.add_user(camera_id, user=body.user, password=body.password, level=body.level)
        )
    )


@router.delete("/cameras/{camera_id}/users/{username}", response_model=FleetOpPublic)
async def delete_user(
    camera_id: str,
    username: str,
    svc: Annotated[DeviceMgmtService, Depends(get_devicemgmt_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> FleetOpPublic:
    await enforce_camera_privilege(
        svc.db, scope=svc.scope, principal=actor, camera_id=camera_id, privilege="config"
    )
    return FleetOpPublic(**fleet_op_dict(await svc.delete_user(camera_id, user=username)))


@router.post("/cameras/{camera_id}/config-backup")
async def config_backup(
    camera_id: str,
    svc: Annotated[DeviceMgmtService, Depends(get_devicemgmt_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    """Export the device config → a binary download. 502 when the blob is unavailable."""
    await enforce_camera_privilege(
        svc.db, scope=svc.scope, principal=actor, camera_id=camera_id, privilege="config"
    )
    backup = await svc.backup_config(camera_id)
    if not backup.supported or not backup.blob:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=backup.detail or "config backup unavailable (device unreachable/unsupported)",
        )
    return Response(
        content=backup.blob,
        media_type=backup.content_type,
        headers={"Content-Disposition": f'attachment; filename="{backup.filename}"'},
    )


@router.post("/cameras/{camera_id}/config-restore", response_model=FleetOpPublic)
async def config_restore(
    camera_id: str,
    body: ConfigRestoreBody,
    svc: Annotated[DeviceMgmtService, Depends(get_devicemgmt_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> FleetOpPublic:
    await enforce_camera_privilege(
        svc.db, scope=svc.scope, principal=actor, camera_id=camera_id, privilege="config"
    )
    try:
        blob = base64.b64decode(body.blob_b64, validate=True)
    except Exception:  # noqa: BLE001 — bad base64 is a client error
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="blob_b64 is not valid base64"
        )
    return FleetOpPublic(**fleet_op_dict(await svc.restore_config(camera_id, blob)))
