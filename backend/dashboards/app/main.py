"""Dashboards service — the dashboard builder's store.

What it is: a small, boring CRUD service over `neubit_dashboards`, holding
dashboards, the widgets on them, and where those widgets sit on the grid.

What it is NOT, and why: it does not query the reading store. A widget carries a
structured query spec, and that spec is executed by the reading-writer's
`POST /api/v1/bi/query` — the service that OWNS the readings schema (contract
§7). Putting the execution here would mean a second service SELECTing tables it
does not own, which is the second place a schema drifts, and would duplicate the
rollup-vs-raw rules that keep query cost independent of ingest rate. So the split
is: this service knows what a dashboard IS, the reading-writer knows what its
widgets MEAN, and the browser joins the two.

Gating, applied once at mount so no route can forget it:
    require_feature("analytics")   the "Dashboards & Reports" module
    require_active_license()       suspended tenant / expired licence
and per route, `dashboards.read` or `dashboards.manage`.

Run:  alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from kernel.auth import require_active_license, require_feature
from kernel.config import get_settings
from kernel.errors import register_error_handlers
from kernel.events import EventBus

from app.dashboards.router import router as dashboards_router

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("dashboards")

# No-op when VE_NATS_URL is unset. This service publishes nothing of its own; the
# bus is here for the tenant-lifecycle subscription below.
bus = EventBus(source="dashboards")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await bus.connect()

    # DPDP right-to-erase. When core offboards a tenant, this service must wipe
    # that tenant's rows from its own database. The kernel helper walks every
    # table carrying a `tenant_id` column in FK-safe order — which is why the
    # widget table carries one too (see `dashboards.models`).
    from kernel.lifecycle import subscribe_tenant_offboard

    from app.db import database

    try:
        await subscribe_tenant_offboard(bus, database, durable="dashboards-offboard")
    except Exception:  # noqa: BLE001
        # A bus hiccup must not stop the API from serving. Stay up, log loudly.
        log.exception("could not subscribe to tenant offboard events")

    yield
    await bus.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Neubit Dashboards", lifespan=lifespan)
    register_error_handlers(app)

    # The operator console may call this satellite directly in dev (:3000 →
    # :8030) instead of through the gateway. Mirror the shared kernel policy.
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
        return {"status": "ok", "service": "dashboards", "env": settings.env}

    app.include_router(
        dashboards_router,
        prefix=settings.api_prefix,
        dependencies=[
            Depends(require_feature("analytics")),
            Depends(require_active_license()),
        ],
    )
    return app


app = create_app()
