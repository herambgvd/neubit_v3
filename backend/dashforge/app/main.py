"""DashForge service — the registry of embedded DashForge dashboards.

What it is: a small, boring CRUD service over `neubit_dashforge`, holding which
DashForge dashboards this platform shows, plus ONE privileged route that mints a
short-lived embed token for a caller who has passed NeuBit's permission check.

What it is NOT, and why:

* It is not a dashboard builder. DashForge is the single dashboarding surface;
  authoring happens there. Nothing here stores a layout, a widget or a query, so
  there is no second definition of a dashboard to drift from the real one.
* It is not a query path. A widget's numbers are fetched by DashForge from its
  own datasource. This service never opens `neubit_reporting`, so the rule that
  gives the readings schema one owner (contract §7) is untouched by the
  integration.
* It was NOT, on the day it landed, the retirement of `backend/dashboards` —
  that service was deliberately left running until this integration had been
  proven, because two dashboard surfaces existing at once is a smaller cost than
  deleting a working one on the day its replacement first boots. That proving is
  done: the builder was removed on 2026-09-03, and this is now the only
  dashboarding surface. Comment kept rather than deleted because the sequencing
  is the reason the changeover was survivable, and the next person tempted to
  land a replacement and a deletion together should see it.

Gating, applied once at mount so no route can forget it:
    require_feature("analytics")   the "Dashboards & Reports" module
    require_active_license()       suspended tenant / expired licence
and per route, `dashforge.read` or `dashforge.manage`.

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

from app.config import get_dashforge_settings
from app.embeds.router import router as embeds_router

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("dashforge")

# No-op when VE_NATS_URL is unset. This service publishes nothing of its own; the
# bus is here for the tenant-lifecycle subscription below.
bus = EventBus(source="dashforge")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await bus.connect()

    # DPDP right-to-erase. When core offboards a tenant, this service must wipe
    # that tenant's rows from its own database. The kernel helper walks every
    # table carrying a `tenant_id` column, which is why `dashforge_embeds` has
    # one (see `embeds.models`).
    from kernel.lifecycle import subscribe_tenant_offboard

    from app.db import database

    try:
        await subscribe_tenant_offboard(bus, database, durable="dashforge-offboard")
    except Exception:  # noqa: BLE001
        # A bus hiccup must not stop the API from serving. Stay up, log loudly.
        log.exception("could not subscribe to tenant offboard events")

    if not get_dashforge_settings().enabled:
        # A warning and not a failure: the registry half of this service works
        # without a peer, and a satellite that refuses to boot on an optional
        # dependency takes every `depends_on` behind it down with it.
        log.warning(
            "DashForge peer not configured (VE_DASHFORGE_BASE_URL / _EMAIL / "
            "_PASSWORD); registrations still work, embed sessions answer 503"
        )

    yield
    await bus.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Neubit DashForge", lifespan=lifespan)
    register_error_handlers(app)

    # The operator console may call this satellite directly in dev instead of
    # through the gateway. Mirror the shared kernel policy.
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
        return {
            "status": "ok",
            "service": "dashforge",
            "env": settings.env,
            # Whether the peer is configured, NOT whether it is up. A health
            # check that probed DashForge would make this container unhealthy
            # whenever the peer restarts, and compose would then restart a
            # service that is working correctly.
            "peer_configured": get_dashforge_settings().enabled,
        }

    app.include_router(
        embeds_router,
        prefix=settings.api_prefix,
        dependencies=[
            Depends(require_feature("analytics")),
            Depends(require_active_license()),
        ],
    )
    return app


app = create_app()
