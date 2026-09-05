"""Reading-writer service — HTTP surface + process lifecycle.

Two surfaces, and they are deliberately different kinds of thing.

**Operational** — how the pipeline is watched. Not routed through the gateway;
an operator reaches it on the container port.

    GET /health   liveness — 200 while the process is up
    GET /readyz   readiness — 503 when EITHER consumer is wedged (see below)
    GET /metrics  Prometheus text, BOTH consumers, distinguishable
    GET /stats    the same numbers as JSON, for a human with curl

``/readyz`` is what a load balancer or an operator should page on. It goes red
for the conditions that mean data is not landing, and stays green while a writer
is merely busy.

**Tenant API** — ``{api_prefix}/bi/...``, the Building Intelligence read API
(``app.api``). It is here rather than in a new service because contract §7 gives
the readings schema ONE owner and the platform bans cross-service reads: a
separate analytics container would have to SELECT tables it does not own. It is
JWT-authorized, permission-gated (``bi.read``) and tenant-scoped exactly like
every other satellite, and it is SELECT-only — this service is still the only
thing that WRITES the schema. ``app.projections`` adds no route to it and must
not: one query path over this store, contract §8 rule 2.

FIVE CONSUMERS, ONE PROCESS, AND THE ONE THAT MUST NEVER WAIT
--------------------------------------------------------------
This process runs five independent JetStream consumers::

    pipeline        IOT_READINGS  tenant.*.iot.reading.>   → readings / points
    projections     EVENTS + IOT_READINGS, one durable per
                    row of `reporting_projections`         → the projected relations
    placement_sync  EVENTS      tenant.*.sites.device_placement.>
    site_facts_sync EVENTS      tenant.*.sites.site.>
    dlq_watch       EVENTS_DLQ  dlq.>                      (observes; writes nothing)

`pipeline` is the hot path: every device reading in the estate goes through it
and it is the only writer of the readings hypertable. The other four handle
domain events at a completely different rate and shape. The rule is one-way — a
projection backlog, a slow projection, or a projection wedged outright must not
delay a reading being written — and it is held by four things, none of which is
"they are separate containers", because as of 2026-09-05 they are not:

1. **A separate NATS connection each.** Every one of them calls `nats.connect`
   itself, so a pull request that hangs consumes its own client's inflight
   budget and nothing else's. Visible as five rows in `nats server report
   connections`, named apart on purpose.
2. **Separate durables.** `reading-writer` on IOT_READINGS versus one durable per
   projection; the ack/redelivery state of one is not the other's. Unchanged by
   the fold-in — the projection durables are named in registry ROWS, not code.
3. **Separate asyncio tasks and bounded queues.** Each consumer's fetcher and
   writer are their own tasks; every wait is an `await`. The one genuinely shared
   resource left is the event loop, and the only synchronous work on it is
   building one batch's parameter dict — bounded by `batch_rows` (200 for
   projections) and sub-millisecond, which is why this is a statement of fact
   rather than a hope.
4. **A separate connection pool.** The one the merge actually exposed, and the
   only one that was free while these were two processes. See
   `app/projections/db.py`: a shared pool would let a projection block the
   readings write loop in the pool CHECKOUT, before any statement is issued,
   where no statement_timeout applies and neither `db_healthy` nor the stall
   watchdog is armed.

Health is likewise per consumer. `Metrics` (readings) and `ProjectorMetrics`
(projections) are separate objects with separate `db_healthy`, separate lag and
separate stall clocks — a merged surface that reported one healthy number while
the other consumer was wedged is exactly the failure-that-reports-success this
codebase spends its comments preventing.

WHERE THE TWO READINESS DEFINITIONS DISAGREED
----------------------------------------------
They were written a day apart and the projector's was strictly the stronger. It
went red for two conditions the readings pipeline had no concept of: a projection
REFUSED at startup (a domain that believes it is being collected and is not), and
a consumer whose pulls keep failing while it receives nothing (`consuming`). Both
are KEPT, applied to the half that has them, neither weakened to match.

The readings half now has the second of those too, which is what closed the gap
5b69d72 left open in writing. It is the same idea and NOT the same mechanism. The
projections flag is ASSIGNED from the failure branch of each projection's fetch
loop; the readings flag is DERIVED from two clocks, and it has to be, because a
failing pull is not actually observable here:

  * the loop stamps a heartbeat on every ANSWERED pull, so a task that died or
    stopped iterating goes stale — something an assigned flag cannot notice,
    since a dead task assigns nothing;
  * the stats loop stamps a second clock when `consumer_info` confirms the
    durable exists and is OUR pull consumer. Necessary because nats-py reports
    the server's 409 — its answer to a pull against a deleted or push-based
    consumer — as a plain `TimeoutError`, identical to an idle feed. Without this
    second proof a durable deleted out of band is invisible at the fetch call,
    which is exactly the wedge this commit had to be able to see.

A refused-projection equivalent is still not here and should not be: the readings
consumer is one durable named in config, not a table of them, so there is no such
thing as a readings projection that believes it is being collected.

Both flags are exposed apart — `reading_writer_consuming` against
`projector_consuming{projection="..."}` — so a reader can tell WHICH consumer is
wedged rather than only that one of them is.
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
from .projections import DlqWatch, DlqWatchStats, Projector, ProjectorConfig, ProjectorMetrics
from .site_facts_sync import SiteFactsStats, SiteFactsSync

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
# A SECOND durable consumer on the same EVENTS stream, on its own subject and its
# own durable: site facts (area / tariff / occupancy) answer a different question
# from device placements, and one wedging must not stop the other.
site_facts_stats = SiteFactsStats()
site_facts_sync = SiteFactsSync(site_facts_stats)
# The projection consumers (app/projections) — the only writer of the relations
# declared in `reporting_projections`, and never a writer of the readings schema.
# Its OWN metrics object, config, NATS connection and connection pool; see the
# module docstring above for what each of those four is holding up.
projector_metrics = ProjectorMetrics()
projector_config = ProjectorConfig()
projector = Projector(projector_config, projector_metrics)
# The EVENTS_DLQ reader — a consumer on its own connection again, so a wedged
# watch can never stall a projection or a reading.
dlq_stats = DlqWatchStats()
dlq_watch = DlqWatch(dlq_stats)


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
        await site_facts_sync.start(getattr(settings, "nats_url", "") or "")
    except Exception as exc:  # noqa: BLE001
        # Same rule as the pipeline: a placement mirror that cannot start must
        # not take the readings path down with it.
        metrics.note_error(exc)
        log.exception("placement sync failed to start — floor-plan pins will not reach BI")
    log.info(
        "projections: batch=%s rows/%s ms buffer=%s batches reload=%ss ensure_relations=%s",
        projector_config.batch_rows, projector_config.batch_ms,
        projector_config.queue_batches, projector_config.reload_sec,
        projector_config.ensure_relations,
    )
    try:
        await projector.start(getattr(settings, "nats_url", "") or "")
    except Exception as exc:  # noqa: BLE001
        # Its OWN metrics object, deliberately: a projection failure recorded on
        # the readings metrics would turn /readyz red for the hot path over
        # something the hot path is not doing, which is the mirror image of the
        # silence this surface exists to break. Stay up, stay red on the half
        # that is actually broken.
        projector_metrics.note_error(exc)
        log.exception("projections failed to start — service is up but NOT projecting")
    try:
        await dlq_watch.start(getattr(settings, "nats_url", "") or "")
    except Exception as exc:  # noqa: BLE001 — a broken watch must not stop anything
        projector_metrics.note_error(exc)
        log.exception("DLQ watch failed to start — dead letters will not be visible here")
    yield
    await dlq_watch.stop()
    await projector.stop()
    await placement_sync.stop()
    await site_facts_sync.stop()
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


def _readings_reasons() -> list[str]:
    """Why the READINGS consumer is not ready. Empty means it is."""
    reasons: list[str] = []
    # A write that has been in flight past the stall threshold is a stuck
    # database, and it must read as NOT ready even in the instant before the
    # watchdog has flipped db_healthy.
    stalled = metrics.write_stalled_sec()
    if stalled >= config.write_stall_sec:
        reasons.append(
            f"readings: database stuck: batch write in flight for {stalled}s "
            f"(threshold {config.write_stall_sec}s)"
        )
    if not metrics.db_healthy:
        reasons.append("readings: database unavailable")
    if not metrics.nats_connected:
        reasons.append("readings: NATS disconnected")
    # The states none of the three above can see. A connected client, a healthy
    # database and `consumer_pending` at 0 is ALSO what a deleted durable, a dead
    # fetch task and a loop that stopped iterating look like — and this is the hot
    # path, so it is the one place where reading success into silence costs the
    # estate its readings.
    #
    # TWO reasons, not one, because they are two different faults with two
    # different fixes: the loop stopped answering (restart it, look at the task)
    # versus the durable is gone or is not ours (look at who else is using the
    # name). Neither is a traffic gauge — a live loop and a live durable both
    # report fine through a completely idle night.
    if not metrics.fetch_loop_alive:
        reasons.append(
            f"readings: consumer is not consuming: no answer from the fetch loop for "
            f"{metrics.fetch_silence_sec()}s (limit {config.fetch_silence_sec}s)"
        )
    if not metrics.consumer_confirmed:
        reasons.append(
            f"readings: consumer is not consuming: durable {config.stream}/"
            f"{config.durable} unconfirmed for {metrics.consumer_unconfirmed_sec()}s "
            f"(limit {config.fetch_silence_sec}s): {metrics.consumer_missing}"
        )
    if metrics.consumer_pending > config.lag_warn:
        reasons.append(
            f"readings: consumer lag {metrics.consumer_pending} > {config.lag_warn}"
        )
    return reasons


def _projection_reasons() -> list[str]:
    """Why the PROJECTION consumers are not ready. Empty means they are.

    Two conditions here have no counterpart on the readings side and are kept
    exactly as the projector had them: a REFUSED projection (a domain that
    believes it is being collected and is not — this pipeline has produced two of
    those) and a projection whose pulls keep failing while it receives nothing.
    """
    reasons: list[str] = []
    stalled = projector_metrics.write_stalled_sec()
    if stalled >= projector_config.write_stall_sec:
        reasons.append(
            f"projections: database stuck: batch write in flight for {stalled}s "
            f"(threshold {projector_config.write_stall_sec}s)"
        )
    if not projector_metrics.db_healthy:
        reasons.append("projections: database unavailable")
    if not projector_metrics.nats_connected:
        reasons.append("projections: NATS disconnected")
    if projector_metrics.max_pending > projector_config.lag_warn:
        reasons.append(
            f"projections: consumer lag {projector_metrics.max_pending} > "
            f"{projector_config.lag_warn}"
        )
    for key, why in sorted(projector_metrics.refused.items()):
        reasons.append(f"projections: projection '{key}' refused: {why}")
    for key in projector_metrics.not_consuming:
        reasons.append(
            f"projections: projection '{key}' is not consuming (pulls failing; rebinding)"
        )
    return reasons


@app.get("/readyz")
async def readyz() -> JSONResponse:
    """Red when EITHER consumer is wedged, and it says which one.

    The union is the point. Both halves write the same store from the same
    process, so a single verdict is what an operator gets either way — but a
    single verdict computed from one half's numbers would report success while
    the other was silently dead, and every reason string is prefixed so a page
    names the consumer rather than the container.
    """
    reasons = _readings_reasons() + _projection_reasons()
    return JSONResponse(
        status_code=200 if not reasons else 503,
        content={
            "ready": not reasons,
            "reasons": reasons,
            **metrics.snapshot(),
            "projections": projector_metrics.snapshot(),
        },
    )


@app.get("/stats")
async def stats() -> dict:
    return {
        **metrics.snapshot(),
        **placement_stats.snapshot(),
        **site_facts_stats.snapshot(),
        # Nested, not merged: the two halves have counters of the same NAME
        # (rows_inserted, batches_nakd, db_healthy) measuring different things,
        # and flattening them would silently overwrite one with the other.
        "projections": projector_metrics.snapshot(),
        **dlq_stats.snapshot(),
    }


@app.get("/metrics")
async def prometheus() -> PlainTextResponse:
    # Two independent exposition blocks, `reading_writer_*` and `projector_*`.
    # Same reason /stats nests: the counters collide by name and only the prefix
    # keeps "readings are landing" from being read as "projections are landing".
    # The projector's are per-projection (`{projection="..."}`), so a healthy
    # access feed cannot hide a wedged alerts feed either.
    return PlainTextResponse(
        metrics.prometheus() + projector_metrics.prometheus() + dlq_stats.prometheus(),
        media_type="text/plain; version=0.0.4",
    )
