"""Access-control (gates) service — controller instances + event ingestion.

Boots the FastAPI app on ``kernel`` (config/auth/events/errors), mounts the
tenant-scoped, ``access.*``-gated REST API under the service api_prefix, connects
the NATS event bus, and starts the SignalR event-ingestion supervisor (one
listener per active controller instance).

The listener starts, logs, and RETRIES without crashing the service even when
there is no live controller in dev — see ``app.access.ingestion``. A periodic
reconcile trigger is stubbed here (entrypoint wired, scheduler is a later phase).

Run:   uvicorn app.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from kernel.auth import (
    Principal,
    Scope,
    get_principal,
    get_scope,
    require_active_license,
    require_feature,
)
from kernel.config import get_settings
from kernel.errors import register_error_handlers
from kernel.events import subject

from app.access.events import bus
from app.access.ingestion import SignalRSupervisor
from app.access.router import routers as access_routers

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("access")

# The SignalR ingestion supervisor, held so lifespan shutdown can stop it cleanly.
_supervisor: SignalRSupervisor | None = None


async def _run_reconcile_scheduler() -> None:
    """Periodic reconcile trigger — STUB entrypoint (wired, not yet ticking).

    v2 ran a per-instance cron (``reconciler_cron``, default 0 3 * * *). The v3
    scheduler (Celery-beat or an internal ticker firing InstanceService.reconcile
    for due instances) is a later phase; this function exists so the lifespan wire
    point is in place. Enable with VE_ACCESS_RECONCILE_SCHEDULER=1 once built.
    """
    log.info("reconcile scheduler entrypoint present (disabled — later phase)")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _supervisor
    await bus.connect()
    await bus.publish(subject(None, "access", "startup"), {"service": "access"})
    # DPDP right-to-erase: wipe this service's rows for a tenant core offboards.
    from kernel.lifecycle import subscribe_tenant_offboard

    from app.db import database

    await subscribe_tenant_offboard(bus, database, durable="access-offboard")

    # Start real-time event ingestion (one SignalR listener per active instance).
    # Never blocks/crashes startup — the supervisor swallows discovery + connect
    # failures and retries (no live controller in dev is fine).
    _supervisor = SignalRSupervisor(bus)
    try:
        await _supervisor.start()
    except Exception as exc:  # noqa: BLE001 — belt-and-braces; must not block boot
        log.warning("event ingestion supervisor failed to start: %s", exc)

    # Reconcile scheduler entrypoint (opt-in; stubbed for now).
    if os.getenv("VE_ACCESS_RECONCILE_SCHEDULER", "").lower() in ("1", "true", "yes"):
        await _run_reconcile_scheduler()

    yield

    if _supervisor is not None:
        await _supervisor.stop()
    await bus.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Neubit Access Control", lifespan=lifespan)
    register_error_handlers(app)

    # CORS — the operator UI may call this satellite directly (dev :3000) instead of
    # through the gateway. Mirror core's policy (shared kernel settings).
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
        return {"status": "ok", "service": "access", "env": settings.env}

    # Sample authed route — proves JWT verification + tenant scope work locally.
    @app.get(f"{settings.api_prefix}/access/whoami")
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
        }

    # Mount the access REST API under the service api_prefix, gated by the tenant's
    # "access" module + an unexpired license (super-admins bypass).
    access_gate = [Depends(require_feature("access")), Depends(require_active_license())]
    for r in access_routers:
        app.include_router(r, prefix=settings.api_prefix, dependencies=access_gate)

    return app


app = create_app()
