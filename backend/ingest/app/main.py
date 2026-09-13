"""Ingest service — the platform's inbound edge for third-party event producers.

Devices and third-party systems (NVRs, alarm panels, vendor clouds) POST to a
public webhook URL. This service authenticates that POST against per-webhook
credentials, validates and reshapes the vendor's body into a platform event, and
publishes it to NATS. Nothing downstream ever speaks to the vendor. Owns
``neubit_ingest``.

Two surfaces, split by trust and mounted differently:

* ``config_router`` — the authed operator API under ``{api_prefix}/ingest``:
  categories, webhooks, event rules, the event log and replay. JWT-verified
  locally, gated on ``ingest.read`` / ``ingest.manage``, tenant scoped, and gated
  below on the tenant's ``workflow`` module plus an unexpired licence.
* the public receiver — ``GET|POST /ingest/hooks/{slug}``, no prefix and no JWT.
  A device carries no principal, so it cannot be feature-gated here; the slug
  identifies the webhook and the webhook's ``auth_type`` authorizes the caller.

The pipeline (app/ingest/service.py :: ReceiverService):

  slug lookup → per-webhook auth → JSON-Schema validation → rule match or
  webhook transform → publish ``tenant.<tid>.<domain>.event.received``

Every stage's verdict is written to ``ingest_event_logs`` before the request is
answered, including rejections on an unknown slug — that is how an operator
diagnoses a device that "isn't sending anything". A stored raw payload can be
re-run through the pipeline by the authed replay endpoint, which is why this
module hands the router the live bus (``bind_event_bus``).

The pieces, each with its own header:

  * ``security.py``  — per-webhook auth: none / api_key / basic / bearer / hmac.
    Most secrets are stored as a salted SHA-256; HMAC secrets are stored
    reversibly encrypted, since verifying a vendor signature needs the original
    back. Every rejection returns the same bare 401.
  * ``transform.py`` — JSON Schema validation and the JMESPath
    ``{target_field: expr}`` field map. Pure, and collects errors instead of
    raising, so a misconfigured webhook is a 422 and not a 500.
  * ``matcher.py``   — the rule engine. Conditions over the raw payload; the
    first rule by priority wins and replaces the webhook-level transform. A
    webhook with rules and no match rejects rather than publishing unrouted.
  * ``bootstrap.py`` — optional idempotent brand seeds (``VE_INGEST_AUTO_SEED``).

Run:   uvicorn app.main:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import logging
import asyncio
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Response
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
    from kernel.lifecycle import subscribe_tenant_offboard, subscribe_tenant_provisioned

    from app.db import database

    await subscribe_tenant_provisioned(bus, database, durable="ingest-provision")
    await subscribe_tenant_offboard(bus, database, durable="ingest-offboard")

    # Optional brand seeds (VE_INGEST_AUTO_SEED). No-op when off; never raises.
    from app.ingest.bootstrap import bootstrap_ingest_seeds

    async with database.get_sessionmaker()() as db:
        await bootstrap_ingest_seeds(db)

    # Prune old delivery logs. The table grew one row per delivery with nothing
    # ever removing them, and the rows hold verbatim customer payloads.
    from app.retention import sweep_forever

    retention_task = asyncio.create_task(sweep_forever(database.get_sessionmaker()))

    yield

    retention_task.cancel()
    await bus.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Neubit Ingest", lifespan=lifespan)
    register_error_handlers(app)

    # The operator UI may call this satellite directly (dev :3000) rather than
    # through the gateway. Mirrors core's policy via shared kernel settings.
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
        """Liveness only — see app/probes.py."""
        return {"status": "ok", "service": "ingest", "env": settings.env}

    @app.get("/readyz")
    async def ready():
        """Readiness: 503 naming the dependency that failed."""
        from app.probes import readyz

        return await readyz()

    @app.get("/metrics")
    async def metrics() -> Response:
        """Counters for the rejections that deliberately leave no database row.

        The public receiver used to record every unknown-slug attempt as a row,
        which is how an unauthenticated endpoint became an unbounded write.
        """
        from app.ingest.metrics import render

        return Response(content=render(), media_type="text/plain; version=0.0.4")

    # Sample authed route — proves JWT verification + tenant scope work locally.
    @app.get(f"{settings.api_prefix}/ingest/whoami")
    async def whoami(
        principal: Annotated[Principal, Depends(get_principal)],
        scope: Annotated[Scope, Depends(get_scope)],
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
    # Gated on the tenant's "workflow" module — ingest belongs to that context —
    # plus an unexpired license. Super-admins bypass both.
    app.include_router(
        config_router,
        prefix=settings.api_prefix,
        dependencies=[Depends(require_feature("workflow")), Depends(require_active_license())],
    )
    # Public receiver: per-webhook secret auth, no JWT, so no feature gate here —
    # a device POST carries no principal. Entitlement lives on the webhook row.
    app.include_router(build_public_router(bus))

    return app


app = create_app()
