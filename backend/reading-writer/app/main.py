"""Reading-writer service — HTTP surface + process lifecycle.

The HTTP server exists only so the pipeline can be *watched*. It serves no
business API: this service's job is on the bus.

    GET /health   liveness — 200 while the process is up
    GET /readyz   readiness — 503 when the database is down, NATS is
                  disconnected, or consumer lag is over VE_READINGS_LAG_WARN
    GET /metrics  Prometheus text
    GET /stats    the same numbers as JSON, for a human with curl

``/readyz`` is what a load balancer or an operator should page on. It goes red
for the two conditions that mean readings are not landing, and stays green while
the writer is merely busy.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse, PlainTextResponse
from kernel.config import get_settings

from .config import WriterConfig
from .metrics import Metrics
from .pipeline import Pipeline

logging.basicConfig(level=os.getenv("VE_LOG_LEVEL", "INFO").upper(),
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("reading-writer")

metrics = Metrics()
config = WriterConfig()
pipeline = Pipeline(config, metrics)


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
    yield
    await pipeline.stop()


app = FastAPI(title="Neubit Reading Writer", lifespan=lifespan)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "reading-writer"}


@app.get("/readyz")
async def readyz() -> JSONResponse:
    lagging = metrics.consumer_pending > config.lag_warn
    ready = metrics.db_healthy and metrics.nats_connected and not lagging
    reasons = []
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
    return metrics.snapshot()


@app.get("/metrics")
async def prometheus() -> PlainTextResponse:
    return PlainTextResponse(metrics.prometheus(), media_type="text/plain; version=0.0.4")
