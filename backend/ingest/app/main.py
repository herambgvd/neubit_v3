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

from kernel.auth import Principal, Scope, get_principal, get_scope
from kernel.config import get_settings
from kernel.errors import register_error_handlers
from kernel.events import EventBus, subject

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ingest")

# One event bus for the service (no-op if VE_NATS_URL is unset).
bus = EventBus(source="ingest")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await bus.connect()
    # Announce the service came up on the platform namespace (harmless if NATS off).
    await bus.publish(subject(None, "ingest", "startup"), {"service": "ingest"})
    yield
    await bus.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Neubit Ingest", lifespan=lifespan)
    register_error_handlers(app)

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

    return app


app = create_app()
