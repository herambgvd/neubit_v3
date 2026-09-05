"""Workflow service — SOP / incident-automation engine.

Boots the FastAPI app on ``kernel`` (config/auth/events/errors), mounts the
workflow REST API (tenant-scoped, ``workflow.*`` permission-gated) under the
service api_prefix, and connects the event bus. The correlation engine
(NATS→incident) + scheduled sweeps run in the Celery worker (``app.worker``);
the API process can optionally host the correlation consumer in-process by
setting ``VE_WORKFLOW_INLINE_CORRELATION=1`` (default off).

Three probe endpoints, unauthenticated and outside the api_prefix so an
orchestrator can reach them: ``/health`` (liveness), ``/readyz`` (readiness — 503
naming the failed dependency) and ``/metrics`` (Prometheus text). What each one
means and why the first two are not one endpoint is written in ``app/probes.py``.

Run:   uvicorn app.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse

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

from app import logs
from app.probes import ApiProbes, CONSUMER_LAG_WARN, CONSUMER_SILENCE_SEC
from app.workflow.runtime.consumers import ConsumerWatch
from app.workflow.runtime.events import bus
from app.workflow.router import routers as workflow_routers

logs.configure("api")
log = logging.getLogger("workflow")

# What this process can say about itself. Populated during lifespan with a watch
# per consumer it actually hosts — see ApiProbes for why "not hosted here" and
# "hosted and healthy" are reported differently.
probes = ApiProbes()

# The correlation + notify consumers, when hosted in-process (opt-in). Held so
# lifespan shutdown can close them cleanly.
_correlation = None
_notify = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _correlation, _notify
    await bus.connect()
    await bus.publish(subject(None, "workflow", "startup"), {"service": "workflow"})
    # DPDP right-to-erase: wipe this service's rows for a tenant core offboards.
    from kernel.lifecycle import subscribe_tenant_offboard, subscribe_tenant_provisioned

    from app.db import database

    await subscribe_tenant_provisioned(bus, database, durable="workflow-provision")
    await subscribe_tenant_offboard(bus, database, durable="workflow-offboard")
    inline = os.getenv("VE_WORKFLOW_INLINE_CORRELATION", "").lower() in ("1", "true", "yes")
    if inline:
        from app.workflow.correlation import engine as correlation_engine
        from app.workflow.correlation.engine import CorrelationEngine

        _correlation = CorrelationEngine()
        await _correlation.start()
        # One watch per consumer, each naming its own durables, so /readyz can say
        # WHICH feed stopped rather than that NATS is unhappy in general.
        probes.add(ConsumerWatch(
            _correlation.bus,
            [f"{correlation_engine.DURABLE}-{p.split('.')[2]}"
             for p in correlation_engine.SUBSCRIBE_PATTERNS],
            label="correlation",
            silence_limit_sec=CONSUMER_SILENCE_SEC, lag_warn=CONSUMER_LAG_WARN,
        ))
        log.info("inline correlation consumer started")
    # The notify-request/vms.popup → outbox consumer rides the same inline flag (it
    # feeds the same connector framework). Separate opt-out via VE_WORKFLOW_INLINE_NOTIFY=0.
    if inline and os.getenv("VE_WORKFLOW_INLINE_NOTIFY", "1").lower() in ("1", "true", "yes"):
        from app.workflow.notifications import consumer as notify_consumer
        from app.workflow.notifications.consumer import NotifyConsumer

        _notify = NotifyConsumer()
        await _notify.start()
        probes.add(ConsumerWatch(
            _notify.bus,
            [f"{notify_consumer.DURABLE}-{p.split('.')[-1]}"
             for p in notify_consumer.SUBSCRIBE_PATTERNS],
            label="notify",
            silence_limit_sec=CONSUMER_SILENCE_SEC, lag_warn=CONSUMER_LAG_WARN,
        ))
        log.info("inline notify consumer started")
    await probes.start_watches()
    yield
    await probes.close()
    if _notify is not None:
        await _notify.close()
    if _correlation is not None:
        await _correlation.close()
    await bus.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Neubit Workflow", lifespan=lifespan)
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

    # LIVENESS. Answers "is this process alive and running its own code", and
    # touches NOTHING outside it. It must not consult the database, Redis or NATS:
    # a liveness probe is a RESTART signal, and restarting a healthy API because
    # Postgres blinked turns one outage into a restart loop on top of it.
    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok", "service": "workflow", "env": settings.env, "role": "api"}

    # READINESS. Answers the different question "would work sent here get done",
    # by actually asking the dependencies this process cannot work without, and
    # returns 503 with a reason NAMING the one that failed. The old /health
    # answered ok with all three of them down, which is what this splits apart.
    # Keep them separate: a readiness failure means stop routing here, a liveness
    # failure means restart, and one endpoint cannot mean both.
    @app.get("/readyz")
    async def readyz() -> JSONResponse:
        ok, body = await probes.readiness()
        return JSONResponse(status_code=200 if ok else 503, content=body)

    @app.get("/metrics")
    async def metrics() -> PlainTextResponse:
        # One scrape covers all three parts of the service, each distinguishable:
        # workflow_notifications_* (the outbox), workflow_consumer_*{consumer=,
        # durable=} (the NATS feeds) and workflow_worker_*/workflow_beat_* (read
        # back off the shared broker). A reader can tell WHICH is wedged.
        return PlainTextResponse(
            await probes.metrics(), media_type="text/plain; version=0.0.4"
        )

    # Sample authed route — proves JWT verification + tenant scope work locally.
    @app.get(f"{settings.api_prefix}/workflow/whoami")
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

    # Mount the workflow REST API under the service api_prefix, gated by the tenant's
    # "workflow" module + an unexpired license (super-admins bypass).
    workflow_gate = [Depends(require_feature("workflow")), Depends(require_active_license())]
    for r in workflow_routers:
        app.include_router(r, prefix=settings.api_prefix, dependencies=workflow_gate)

    return app


app = create_app()
