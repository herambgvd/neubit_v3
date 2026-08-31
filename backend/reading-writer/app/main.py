"""Reading-writer service — HTTP surface + process lifecycle.

Two surfaces, and they are deliberately different kinds of thing.

**Operational** — how the pipeline is watched. Not routed through the gateway;
an operator reaches it on the container port.

    GET /health   liveness — 200 while the process is up
    GET /readyz   readiness — 503 when the database is down, NATS is
                  disconnected, or consumer lag is over VE_READINGS_LAG_WARN
    GET /metrics  Prometheus text
    GET /stats    the same numbers as JSON, for a human with curl

``/readyz`` is what a load balancer or an operator should page on. It goes red
for the two conditions that mean readings are not landing, and stays green while
the writer is merely busy.

**Tenant API** — ``{api_prefix}/bi/...``, the Building Intelligence read API
(``app.api``). It is here rather than in a new service because contract §7 gives
the readings schema ONE owner and the platform bans cross-service reads: a
separate analytics container would have to SELECT tables it does not own. It is
JWT-authorized, permission-gated (``bi.read``) and tenant-scoped exactly like
every other satellite, and it is SELECT-only — this service is still the only
thing that WRITES the schema.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from kernel.auth import require_active_license, require_feature
from kernel.config import get_settings
from kernel.errors import register_error_handlers

from .api import bi_router
from .config import WriterConfig
from .metrics import Metrics
from .pipeline import Pipeline
from .placement_sync import PlacementStats, PlacementSync

logging.basicConfig(level=os.getenv("VE_LOG_LEVEL", "INFO").upper(),
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("reading-writer")

metrics = Metrics()
config = WriterConfig()
pipeline = Pipeline(config, metrics)
# The floor-plan → BI mirror. A SEPARATE consumer on a SEPARATE stream: it reads
# core's sites events off EVENTS, while the pipeline reads readings off
# IOT_READINGS. Coupling them would make a placement event able to stall the
# reading path, which is the one thing that must never wait.
placement_stats = PlacementStats()
placement_sync = PlacementSync(placement_stats)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    log.info(
        "starting: stream=%s durable=%s subject=%s batch=%s rows/%s ms buffer=%s batches",
        config.stream, config.durable, config.subject,
        config.batch_rows, config.batch_ms, config.queue_batches,
    )
    try:
        await pipeline.start(getattr(settings, "nats_url", "") or "")
    except Exception as exc:  # noqa: BLE001
        # Do NOT die: a writer that exits on a bus hiccup takes its /metrics and
        # /readyz with it, and then the outage is invisible. Stay up, stay red.
        metrics.note_error(exc)
        log.exception("pipeline failed to start — service is up but NOT consuming")
    try:
        await placement_sync.start(getattr(settings, "nats_url", "") or "")
    except Exception as exc:  # noqa: BLE001
        # Same rule as the pipeline: a placement mirror that cannot start must
        # not take the readings path down with it.
        metrics.note_error(exc)
        log.exception("placement sync failed to start — floor-plan pins will not reach BI")
    yield
    await placement_sync.stop()
    await pipeline.stop()


app = FastAPI(title="Neubit Reading Writer", lifespan=lifespan)
register_error_handlers(app)

_settings = get_settings()

# The operator console may call this satellite directly in dev (:3000 → :8020)
# instead of through the gateway. Mirror ingest's policy (shared kernel settings).
app.add_middleware(
    CORSMiddleware,
    allow_origins=_settings.cors_origins,
    allow_origin_regex=_settings.cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Building Intelligence read API. Gated the way ingest gates its config router:
# the tenant's module (`analytics` — "Dashboards & Reports") plus a tenant that
# is neither suspended nor past its licence grace. Per-route the permission is
# `bi.read`. Super-admins bypass both gates.
app.include_router(
    bi_router,
    prefix=_settings.api_prefix,
    dependencies=[Depends(require_feature("analytics")), Depends(require_active_license())],
)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "reading-writer"}


@app.get("/readyz")
async def readyz() -> JSONResponse:
    lagging = metrics.consumer_pending > config.lag_warn
    # A write that has been in flight past the stall threshold is a stuck
    # database, and it must read as NOT ready even in the instant before the
    # watchdog has flipped db_healthy.
    stalled = metrics.write_stalled_sec()
    stuck = stalled >= config.write_stall_sec
    ready = metrics.db_healthy and not stuck and metrics.nats_connected and not lagging
    reasons = []
    if stuck:
        reasons.append(
            f"database stuck: batch write in flight for {stalled}s "
            f"(threshold {config.write_stall_sec}s)"
        )
    if not metrics.db_healthy:
        reasons.append("database unavailable")
    if not metrics.nats_connected:
        reasons.append("NATS disconnected")
    if lagging:
        reasons.append(f"consumer lag {metrics.consumer_pending} > {config.lag_warn}")
    return JSONResponse(
        status_code=200 if ready else 503,
        content={"ready": ready, "reasons": reasons, **metrics.snapshot()},
    )


@app.get("/stats")
async def stats() -> dict:
    return {**metrics.snapshot(), **placement_stats.snapshot()}


@app.get("/metrics")
async def prometheus() -> PlainTextResponse:
    return PlainTextResponse(metrics.prometheus(), media_type="text/plain; version=0.0.4")
