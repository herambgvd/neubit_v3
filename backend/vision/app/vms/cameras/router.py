"""Camera-onboarding router — permission-gated, tenant-scoped.

Mounted under the service api_prefix (``/api/v1``) with a ``/vms`` domain prefix,
so paths are ``/api/v1/vms/...``. Every endpoint is gated by a ``vms.*`` permission
via ``kernel.auth.require_permission`` and runs inside the caller's tenant scope
(``get_scope``) — mirroring the access service's router. The permission keys are
added to core's catalog in P1-G; until then the tenant-admin ``*`` wildcard grants
everything, so testing works.

Camera side only (NVR onboarding = the ``nvr`` package; groups + per-camera ACL =
the ``groups`` package). Discovery / probe / snapshot degrade gracefully against
unreachable hosts — they NEVER 500 (empty result / 502 on a snapshot with no frame).
Explicit operator actions (ptz / imaging / io writes) surface a driver failure as a
clean 502.

Endpoints:
  * Cameras: ``GET/POST /cameras``, ``GET/PATCH/DELETE /cameras/{id}``,
    ``POST /cameras/bulk``, ``POST /cameras/reorder``.
  * Discovery: ``POST /cameras/onvif/{discover|probe|channels|bulk-add|snapshot}``.
  * Config: ``{id}/ptz``, ``{id}/imaging``, ``{id}/io``, ``{id}/motion-config``,
    ``{id}/privacy-masks``, ``{id}/motion-zones``, ``{id}/onvif-events``, ``{id}/snapshot``.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_principal, get_scope, require_permission
from kernel.auth import _bearer  # raw bearer credentials (forwarded to nvr for snapshot ensure)

from app.db import get_db
from app.vms.groups.acl import enforce_camera_privilege

from app.vms.drivers import DriverError, PtzCommand
from .schemas import (
    BulkAddBody,
    BulkResult,
    CameraBulkBody,
    CameraCreate,
    CameraListResponse,
    CameraPublic,
    CameraReorderBody,
    CameraUpdate,
    ChannelsBody,
    ChannelsResponse,
    ConfigResult,
    DiscoverBody,
    DiscoverResponse,
    EncoderBody,
    ImagingBody,
    IoBody,
    OsdBody,
    MotionConfigBody,
    MotionZonesBody,
    OnvifEventsBody,
    PrivacyMasksBody,
    ProbeBody,
    ProbeResponse,
    PtzBody,
    ReorderResult,
    SnapshotBody,
    StreamPolicyResult,
)
from .service import CameraService

# Permission keys this service gates on (added to core's catalog in P1-G; the
# tenant-admin "*" wildcard already grants them today).
PERM_READ = "vms.camera.read"
PERM_MANAGE = "vms.camera.manage"
PERM_CONFIG = "vms.config.manage"
PERM_PTZ = "vms.ptz.control"

router = APIRouter(prefix="/vms", tags=["VMS Cameras"])


def _bearer_token(
    cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> Optional[str]:
    return cred.credentials if cred else None


async def get_camera_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    bearer: Annotated[Optional[str], Depends(_bearer_token)],
    principal: Annotated[Principal, Depends(get_principal)],
) -> CameraService:
    # Confine a site-scoped caller (non-superadmin with a non-empty site list) to
    # their sites; an unrestricted caller / super-admin passes [] (sees everything).
    site_ids = principal.site_ids if principal.site_scoped() else []
    return CameraService(db, scope, bearer=bearer, site_ids=site_ids)


def _driver_err(exc: DriverError) -> HTTPException:
    """Translate a driver failure (an explicit operator action) into a clean 502."""
    return HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))


# ── Camera CRUD ────────────────────────────────────────────────────────


@router.get(
    "/cameras",
    response_model=CameraListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_cameras(
    svc: Annotated[CameraService, Depends(get_camera_service)],
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    status_: str | None = Query(None, alias="status", max_length=16),
    brand: str | None = Query(None, max_length=64),
    site_id: str | None = Query(None, max_length=36),
    group_id: str | None = Query(None, max_length=36),
    q: str | None = Query(None, max_length=255),
) -> CameraListResponse:
    return await svc.list_(
        skip=skip, limit=limit, status=status_, brand=brand,
        site_id=site_id, group_id=group_id, q=q,
    )


@router.post(
    "/cameras",
    response_model=CameraPublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_camera(
    body: CameraCreate,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> CameraPublic:
    return await svc.create(body, actor=actor)


@router.get(
    "/cameras/{camera_id}",
    response_model=CameraPublic,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_camera(
    camera_id: str,
    svc: Annotated[CameraService, Depends(get_camera_service)],
) -> CameraPublic:
    return await svc.get(camera_id)


@router.patch("/cameras/{camera_id}", response_model=CameraPublic)
async def update_camera(
    camera_id: str,
    body: CameraUpdate,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> CameraPublic:
    return await svc.update(camera_id, body, actor=actor)


@router.delete("/cameras/{camera_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_camera(
    camera_id: str,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    await svc.delete(camera_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Bulk + reorder ─────────────────────────────────────────────────────


@router.post("/cameras/bulk", response_model=BulkResult)
async def bulk_cameras(
    body: CameraBulkBody,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> BulkResult:
    result = await svc.bulk(
        body.camera_ids, body.action,
        group_id=body.group_id, retention_days=body.retention_days,
        media_node_id=body.media_node_id, actor=actor,
    )
    return BulkResult(affected=result["affected"])


@router.post("/cameras/reorder", response_model=ReorderResult)
async def reorder_cameras(
    body: CameraReorderBody,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> ReorderResult:
    result = await svc.reorder(body.items)
    return ReorderResult(reordered=result["reordered"])


# ── Snapshot ───────────────────────────────────────────────────────────
#
# The one device read left in this router, and it is a READ: a single JPEG for an
# incident card or a thumbnail.
#
# Everything else that was here is gone — ONVIF discovery, probe, channel
# enumeration and bulk-add (VMS-side ONBOARDING, which single ownership retired: the
# recorder onboards cameras), and the whole config plane (PTZ, stream policy,
# imaging, I/O, encoder, OSD, motion config, privacy masks, motion zones, ONVIF
# event subscription). Every one of those needed the camera's credentials, which the
# recorder holds and this service does not, and every one of them is reachable
# through /vms/federation against the recorder that owns the camera.


@router.get("/cameras/{camera_id}/snapshot")
async def snapshot_camera(
    camera_id: str,
    svc: Annotated[CameraService, Depends(get_camera_service)],
    _actor: Principal = Depends(require_permission(PERM_READ)),
) -> Response:
    jpeg = await svc.snapshot_for(camera_id)
    if jpeg is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="snapshot unavailable (device unreachable)"
        )
    return Response(content=jpeg, media_type="image/jpeg")
