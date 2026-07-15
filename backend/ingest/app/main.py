"""Ingest service — bootable skeleton.

No business logic yet: this exists to prove the split works end-to-end —
kernel config/auth/events/errors wire up, a core-minted JWT authorizes
locally, and tenant scope resolves from the token. Real ingestion (external
webhooks / event normalization → NATS) is ported on top of this later.

Run:   uvicorn app.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import logging
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
from kernel.events import EventBus, subject

from app.ingest.router import bind_event_bus, build_public_router, config_router

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ingest")

# One event bus for the service (no-op if VE_NATS_URL is unset).
bus = EventBus(source="ingest")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await bus.connect()
    # Announce the service came up on the platform namespace (harmless if NATS off).
    await bus.publish(subject(None, "ingest", "startup"), {"service": "ingest"})
    # DPDP right-to-erase: wipe this service's rows for a tenant core offboards.
    from kernel.lifecycle import subscribe_tenant_offboard

    from app.db import database

    await subscribe_tenant_offboard(bus, database, durable="ingest-offboard")
    yield
    await bus.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Neubit Ingest", lifespan=lifespan)
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
        return {"status": "ok", "service": "ingest", "env": settings.env}

    # Sample authed route — proves JWT verification + tenant scope work locally.
    @app.get(f"{settings.api_prefix}/ingest/whoami")
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

    # Give the authed router the live event bus (its replay endpoint re-publishes).
    bind_event_bus(bus)
    # Authed config API (category + webhook CRUD) under the versioned prefix — gated
    # by the tenant's "workflow" module (ingest belongs to the workflow context) + an
    # unexpired license (super-admins bypass).
    app.include_router(
        config_router,
        prefix=settings.api_prefix,
        dependencies=[Depends(require_feature("workflow")), Depends(require_active_license())],
    )
    # PUBLIC receiver — NO JWT (per-webhook secret auth), so it is NOT feature-gated
    # here: a device POST carries no principal. Tenant/entitlement enforcement for
    # inbound events belongs on the webhook row, not this route.
    app.include_router(build_public_router(bus))

    return app


app = create_app()
