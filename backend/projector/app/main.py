"""Reporting projector — process lifecycle and the operational HTTP surface.

WHAT THIS SERVICE IS
--------------------
The one legal way a domain's data gets into `neubit_reporting`. The platform bans
services from reading each other's databases, and the reporting store is the
documented exception *for querying* — not a licence to reach into
`neubit_access`. So a domain PUBLISHES on the NATS spine and this service
consumes the spine and writes the reporting store. It opens exactly one database
(`neubit_reporting`) and never another.

It is deliberately a sibling of `reading-writer` rather than part of it. The
reading-writer owns the readings schema and serves its reads (pipeline contract
§7, one owner); this owns the relations declared in `reporting_projections`. Two
consumers, two ownership boundaries, one store.

NO TENANT API
-------------
There is no `/api/...` here. Everything the builder reads it reads through the
reading-writer's `/api/v1/bi/...`, against datasets this service registered. A
second query path over the same store is exactly the drift the pipeline contract
warns about.

    GET /health   liveness — 200 while the process is up
    GET /readyz   readiness — 503 when the database is down, NATS is
                  disconnected, a projection was REFUSED, or lag is over
                  VE_PROJECTOR_LAG_WARN
    GET /metrics  Prometheus text
    GET /stats    the same numbers as JSON, for a human with curl

`/readyz` is what an operator should page on. Note that a refused projection goes
red: a domain that believes it is being collected and is not is a silent failure,
and this pipeline has already produced two of those.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse, PlainTextResponse
from kernel.config import get_settings

from .config import ProjectorConfig
from .metrics import Metrics
from .pipeline import Projector

logging.basicConfig(
    level=os.getenv("VE_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("projector")

metrics = Metrics()
config = ProjectorConfig()
projector = Projector(config, metrics)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    log.info(
        "starting: batch=%s rows/%s ms buffer=%s batches reload=%ss ensure_relations=%s",
        config.batch_rows, config.batch_ms, config.queue_batches,
        config.reload_sec, config.ensure_relations,
    )
    try:
        await projector.start(getattr(settings, "nats_url", "") or "")
    except Exception as exc:  # noqa: BLE001
        # Do NOT die: a projector that exits on a bus hiccup takes its /metrics
        # and /readyz with it, and then the outage is invisible. Stay up, stay red.
        metrics.note_error(exc)
        log.exception("projector failed to start — service is up but NOT consuming")
    yield
    await projector.stop()


app = FastAPI(title="Neubit Reporting Projector", lifespan=lifespan)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "reporting-projector"}


@app.get("/readyz")
async def readyz() -> JSONResponse:
    lagging = metrics.max_pending > config.lag_warn
    ready = (
        metrics.db_healthy
        and metrics.nats_connected
        and not lagging
        and not metrics.refused
    )
    reasons = []
    if not metrics.db_healthy:
        reasons.append("database unavailable")
    if not metrics.nats_connected:
        reasons.append("NATS disconnected")
    if lagging:
        reasons.append(f"consumer lag {metrics.max_pending} > {config.lag_warn}")
    for key, why in sorted(metrics.refused.items()):
        reasons.append(f"projection '{key}' refused: {why}")
    return JSONResponse(
        status_code=200 if ready else 503,
        content={"ready": ready, "reasons": reasons, **metrics.snapshot()},
    )


@app.get("/stats")
async def stats() -> dict:
    return metrics.snapshot()


@app.get("/metrics")
async def prometheus() -> PlainTextResponse:
    return PlainTextResponse(metrics.prometheus(), media_type="text/plain; version=0.0.4")
