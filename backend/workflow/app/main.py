"""Workflow service — SOP / incident-automation engine.

Boots the FastAPI app on ``kernel`` (config/auth/events/errors), mounts the
workflow REST API (tenant-scoped, ``workflow.*`` permission-gated) under the
service api_prefix, and connects the event bus. The correlation engine
(NATS→incident) + scheduled sweeps run in the Celery worker (``app.worker``);
the API process can optionally host the correlation consumer in-process by
setting ``VE_WORKFLOW_INLINE_CORRELATION=1`` (default off).

Run:   uvicorn app.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI

from kernel.auth import Principal, Scope, get_principal, get_scope
from kernel.config import get_settings
from kernel.errors import register_error_handlers
from kernel.events import subject

from app.workflow.events import bus
from app.workflow.router import routers as workflow_routers

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("workflow")

# The correlation consumer, when hosted in-process (opt-in). Held so lifespan
# shutdown can close it cleanly.
_correlation = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _correlation
    await bus.connect()
    await bus.publish(subject(None, "workflow", "startup"), {"service": "workflow"})
    if os.getenv("VE_WORKFLOW_INLINE_CORRELATION", "").lower() in ("1", "true", "yes"):
        from app.workflow.correlation import CorrelationEngine

        _correlation = CorrelationEngine()
        await _correlation.start()
        log.info("inline correlation consumer started")
    yield
    if _correlation is not None:
        await _correlation.close()
    await bus.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Neubit Workflow", lifespan=lifespan)
    register_error_handlers(app)

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok", "service": "workflow", "env": settings.env}

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

    # Mount the workflow REST API under the service api_prefix.
    for r in workflow_routers:
        app.include_router(r, prefix=settings.api_prefix)

    return app


app = create_app()
