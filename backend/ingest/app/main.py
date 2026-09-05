"""Ingest service — the platform's inbound edge for third-party event producers.

This docstring said "bootable skeleton. No business logic yet ... real ingestion
is ported on top of this later" from the day the service split was proved until
2026-09-05. The porting happened long ago and nobody came back to the header, so
the module that a reader opens FIRST claimed the service was a stub while
``app/ingest/`` held 3.2k lines of pipeline. It is written out here in full
because the cost of that lie is a rebuild of something that already works.

WHAT IT ACTUALLY IS
-------------------

Devices and third-party systems (NVRs, alarm panels, vendor clouds) POST to a
public webhook URL. This service authenticates that POST against per-webhook
credentials, validates and reshapes the vendor's body into a platform event, and
publishes it to NATS. Nothing downstream ever speaks to the vendor: the spine is
the only coupling. Owns ``neubit_ingest``.

THE TWO SURFACES, WHICH IS THE WHOLE DESIGN
-------------------------------------------

They are split by TRUST, not by convenience, and this module mounts them
differently on purpose:

* ``config_router`` — the authed operator API under ``{api_prefix}/ingest``:
  categories, webhooks, event rules, the event log and a replay. JWT-verified
  locally by the kernel, gated on ``ingest.read`` / ``ingest.manage``, tenant
  scoped, and additionally gated below on the tenant's ``workflow`` module plus
  an unexpired licence.

* the PUBLIC receiver — ``GET|POST /ingest/hooks/{slug}``, mounted with NO
  prefix and NO JWT dependency. A device carries no principal, so it CANNOT be
  feature-gated here; the slug identifies the webhook and the webhook's own
  ``auth_type`` authorizes the caller. See the note at the include_router below.

THE PIPELINE (app/ingest/service.py :: ReceiverService)
-------------------------------------------------------

  slug lookup → per-webhook auth → JSON-Schema validation → rule match or
  webhook transform → publish ``tenant.<tid>.<domain>.event.received``

and every stage's verdict is written to ``ingest_event_logs`` BEFORE the request
is answered — including rejections on an unknown slug, which is how an operator
diagnoses a device that "isn't sending anything". A stored raw payload can be
re-run through the whole pipeline by the authed replay endpoint, which is why
this module hands the router the live bus (``bind_event_bus``).

The pieces, each its own module with its own header worth reading:

  * ``security.py``  — per-webhook auth: none / api_key / basic / bearer / hmac.
    Most secrets are stored as a salted SHA-256; HMAC secrets are the exception
    and are stored REVERSIBLY ENCRYPTED, because verifying a vendor signature
    needs the original secret back. Every rejection returns the same bare 401.
  * ``transform.py`` — JSON Schema validation and the JMESPath
    ``{target_field: expr}`` field map. Pure, collects errors instead of raising,
    so a misconfigured webhook is a 422 and not a 500.
  * ``matcher.py``   — the rule engine. Conditions (exists/equals/contains/…)
    over the RAW payload; first rule by priority wins and REPLACES the
    webhook-level transform. A webhook with rules and no match rejects rather
    than publishing an unrouted event.
  * ``bootstrap.py`` — optional idempotent brand seeds (``VE_INGEST_AUTO_SEED``).

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
    from kernel.lifecycle import subscribe_tenant_offboard, subscribe_tenant_provisioned

    from app.db import database

    await subscribe_tenant_provisioned(bus, database, durable="ingest-provision")
    await subscribe_tenant_offboard(bus, database, durable="ingest-offboard")

    # Optional brand seeds (VE_INGEST_AUTO_SEED). No-op when off; never raises.
    from app.ingest.bootstrap import bootstrap_ingest_seeds

    async with database.get_sessionmaker()() as db:
        await bootstrap_ingest_seeds(db)

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
