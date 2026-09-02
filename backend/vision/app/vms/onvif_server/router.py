"""ONVIF-server routers (P6-C).

Two routers:
  * ``config_router`` — the OnvifServerConfig CRUD under the service api_prefix +
    ``/vms`` domain prefix (JWT-gated, tenant-scoped). Gate: ``vms.config.manage``.
      * ``GET   /vms/onvif-server/config`` → the config (or a transient default).
      * ``PUT   /vms/onvif-server/config`` → upsert (enable + cameras + creds + hosts).
  * ``soap_router`` — the ONVIF SOAP endpoints under ``/onvif/*`` (NO JWT; WS-Security
    UsernameToken authentication resolves the tenant). The gateway routes ``/onvif`` to
    the vision service.

The SOAP router is returned so ``app.main`` can mount it at the app ROOT (not under
api_prefix) — external ONVIF clients hit ``http://<host>/onvif/device_service`` etc.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db

from .schemas import OnvifServerConfigPublic, OnvifServerConfigUpdate
from .service import OnvifServerService
from .soap import SERVICE_PATHS, handle_soap

PERM_MANAGE = "vms.config.manage"

# ── config CRUD (JWT-gated, tenant-scoped) ────────────────────────────────────
config_router = APIRouter(prefix="/vms", tags=["VMS ONVIF Server"])


async def _get_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> OnvifServerService:
    return OnvifServerService(db, scope)


def require_superadmin(scope: Annotated[Scope, Depends(get_scope)]) -> Scope:
    """External Access (ONVIF server) is VENDOR-ONLY: exposing a tenant's cameras
    outward to a third-party VMS is a platform decision, so a client's own admin
    (has vms.config.manage but is NOT superadmin) must not be able to enable or view
    it. Only the platform super-admin (the vendor) may."""
    if not scope.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="External Access is managed by the platform administrator only.",
        )
    return scope


@config_router.get(
    "/onvif-server/config",
    response_model=OnvifServerConfigPublic,
    dependencies=[Depends(require_permission(PERM_MANAGE)), Depends(require_superadmin)],
)
async def get_config(
    svc: Annotated[OnvifServerService, Depends(_get_service)],
) -> OnvifServerConfigPublic:
    return OnvifServerConfigPublic.from_row(await svc.get())


@config_router.put(
    "/onvif-server/config",
    response_model=OnvifServerConfigPublic,
    dependencies=[Depends(require_superadmin)],
)
async def upsert_config(
    body: OnvifServerConfigUpdate,
    svc: Annotated[OnvifServerService, Depends(_get_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> OnvifServerConfigPublic:
    return OnvifServerConfigPublic.from_row(await svc.upsert(body, actor=actor))


# ── ONVIF SOAP endpoints (NO JWT — WS-Security UsernameToken) ──────────────────
soap_router = APIRouter(tags=["ONVIF SOAP"])

_SOAP_MEDIA_TYPE = "application/soap+xml; charset=utf-8"


def _make_soap_handler(service: str):
    async def handler(
        request: Request,
        db: Annotated[AsyncSession, Depends(get_db)],
    ) -> Response:
        from .auth import authenticate, fault_response

        body_bytes = await request.body()
        config = await authenticate(body_bytes, db)
        if config is None:
            return Response(
                content=fault_response("ter:NotAuthorized", "authentication failed"),
                media_type=_SOAP_MEDIA_TYPE,
                status_code=401,
            )
        xml = await handle_soap(
            service,
            body_bytes,
            config=config,
            headers=request.headers,
            url_hostname=request.url.hostname,
            scheme=request.headers.get("x-forwarded-proto", request.url.scheme),
            soapaction=request.headers.get("soapaction"),
            db=db,
        )
        return Response(content=xml, media_type=_SOAP_MEDIA_TYPE)

    return handler


for _svc in SERVICE_PATHS:
    soap_router.post(f"/onvif/{_svc}")(_make_soap_handler(_svc))
