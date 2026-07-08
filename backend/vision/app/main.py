"""Vision — VMS control-plane service (camera + NVR master, onboarding, drivers).

Boots the FastAPI app on ``kernel`` (config/auth/events/errors), connects the NATS
event bus, and exposes a JWT-verified, tenant-scoped API under the service
api_prefix. It is the Python control-plane half of the VMS; the Go ``nvr`` service
is the data-plane half — the two share this exact JWT + NATS + error contract via
the kernel(s) and interoperate over NATS + REST only (D8).

P1-A is a SCAFFOLD: ``/health`` + ``/api/v1/vms/whoami`` prove config/JWT/tenant
scope/NATS work. Camera/NVR CRUD, ONVIF discovery, drivers and health arrive in
the next modules (the routers just mount here alongside whoami).

Run:  uvicorn app.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import logging

from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from kernel.auth import Principal, Scope, get_principal, get_scope
from kernel.config import get_settings
from kernel.errors import register_error_handlers
from kernel.events import subject

# The onboarding service publishes through the shared VMS event bus
# (``app.vms.common.events``) — one process-wide bus that both startup announcements and
# camera lifecycle/status events ride. The VMS subject namespace is
# ``tenant.<id>.vms.*`` (+ ``device.camera.*`` for the Map / core), shared with the
# Go ``nvr`` service.
from app.db import get_sessionmaker
from app.vms import routers as vms_routers
from app.vms.common.events import bus
from app.vms.health import HealthSampler

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("vision")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await bus.connect()
    # Announce startup on the same spine the Python + Go services use.
    await bus.publish(subject(None, "vms", "startup"), {"service": "vision"})
    # Background reachability sampler (all tenants): keeps camera/NVR status live +
    # writes the CameraHealth time-series + auto-purges it. Its own DB session per
    # cycle; bounded concurrency; graceful-on-unreachable (won't crash the app).
    sampler = HealthSampler(get_sessionmaker())
    await sampler.start()
    app.state.health_sampler = sampler
    yield
    await sampler.stop()
    await bus.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Neubit Vision (VMS control-plane)", lifespan=lifespan)
    register_error_handlers(app)

    # CORS — the operator UI may call this satellite directly (dev :3000) instead
    # of through the gateway. Mirror core's policy (shared kernel settings).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=settings.cors_origin_regex,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok", "service": "vision", "env": settings.env}

    # Sample authed route — proves JWT verification + tenant scope work locally
    # (a core-minted token verifies here identically to the Go nvr service).
    @app.get(f"{settings.api_prefix}/vms/whoami")
    async def whoami(
        principal: Principal = Depends(get_principal),
        scope: Scope = Depends(get_scope),
    ) -> dict:
        return {
            "user_id": str(principal.user_id),
            "tenant_id": str(principal.tenant_id) if principal.tenant_id else None,
            "is_superadmin": principal.is_superadmin,
            "permissions": principal.permissions,
            "is_platform": scope.is_platform,
            "service": "vision",
        }

    # VMS REST routers (P1-D: camera onboarding — CRUD, ONVIF discovery/probe/
    # channels/bulk-add/snapshot, config sub-resources, groups + ACL). NVR
    # onboarding mounts alongside in P1-E.
    for r in vms_routers:
        app.include_router(r, prefix=settings.api_prefix)

    return app


app = create_app()
