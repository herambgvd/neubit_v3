"""Workflow service — bootable skeleton.

No business logic yet: this proves the split works — kernel config/auth/
events/errors wire up, a core-minted JWT authorizes locally, and tenant scope
resolves from the token. The real SOP/automation engine (rules → actions, driven
by NATS events + Celery jobs) is ported on top of this later.

Run:   uvicorn app.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI

from kernel.auth import Principal, Scope, get_principal, get_scope
from kernel.config import get_settings
from kernel.errors import register_error_handlers
from kernel.events import EventBus, subject

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("workflow")

# One event bus for the API process (no-op if VE_NATS_URL is unset).
bus = EventBus(source="workflow")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await bus.connect()
    await bus.publish(subject(None, "workflow", "startup"), {"service": "workflow"})
    yield
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

    return app


app = create_app()
