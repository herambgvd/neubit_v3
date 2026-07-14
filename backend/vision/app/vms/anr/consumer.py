"""ANR NATS consumer (P6-A) — anr.request → fulfill → anr.result.

The Go ``nvr`` detects a recording gap, opens an ``ANRJob``, and publishes
``tenant.<id>.vms.anr.request`` ``{job_id, camera_id, profile, gap_from, gap_to,
record_path}``. This consumer (wired in ``app.main`` lifespan, like the recording
consumer) subscribes to that subject family across every tenant, runs the
``AnrFulfiller`` (own DB session per message), and publishes
``tenant.<id>.vms.anr.result`` ``{job_id, status, backfilled_segments, error?}`` which
the Go ``nvr`` result-consumer uses to close the job.

Discipline mirrors ``RecordingConsumer``:

  * NOT request-scoped — it trusts the tenant carried in the event envelope (the nvr
    derives it from the tenant-scoped record path). The fulfiller reads + writes strictly
    within that tenant.
  * BOUNDED concurrency (``VE_ANR_CONCURRENCY``, default 2) so several backfills can run
    without saturating the box.
  * IDEMPOTENT per ``job_id``: an in-flight job is de-duped (a duplicate redelivery is a
    no-op while the first is still running); the ffmpeg output path is deterministic
    (gap-start filename) so a completed re-delivery just re-pulls the same segment (the
    segment tracker dedupes on ``path``).
  * GRACEFUL: every fulfil returns an ``AnrResult`` (done|failed) — one bad event / a
    dead device / an ffmpeg error never kills the subscription; a no-op bus (NATS
    disabled) makes ``start`` a no-op.
"""

from __future__ import annotations

import asyncio
import logging
import os

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kernel.events import subject

from .service import AnrFulfiller, AnrRequest, AnrResult, scope_for

log = logging.getLogger("vision.anr_consumer")

# Match every tenant's anr.request events. The envelope carries tenant_id.
_SUBJECT = "tenant.*.vms.anr.request"
_DURABLE = "vision-anr-requests"


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


def concurrency() -> int:
    return max(1, _env_int("VE_ANR_CONCURRENCY", 2))


class AnrConsumer:
    """Subscribes to nvr anr.request events → fulfils → publishes anr.result."""

    def __init__(self, bus, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._bus = bus
        self._sessionmaker = sessionmaker
        self._started = False
        self._sem = asyncio.Semaphore(concurrency())
        # job_ids currently being fulfilled → drop a duplicate redelivery mid-flight.
        self._inflight: set[int] = set()

    async def start(self) -> None:
        if self._started:
            return
        # A durable JetStream consumer → at-least-once + survives restarts. Fulfilment is
        # idempotent (deterministic segment path; the tracker dedupes on path), so
        # redelivery is safe. If NATS is disabled the subscribe is a no-op.
        await self._bus.subscribe(_SUBJECT, self._handle, durable=_DURABLE)
        self._started = True
        log.info(
            "ANR consumer subscribed: %s (durable=%s, concurrency=%s)",
            _SUBJECT, _DURABLE, concurrency(),
        )

    async def _handle(self, env: dict) -> None:
        """Fulfil one anr.request. ``env`` is the decoded kernel envelope."""
        payload = env.get("payload") or {}
        tenant_id = env.get("tenant_id")
        req = AnrRequest.from_event(tenant_id, payload)
        if req is None:
            log.info("ANR request ignored (malformed): %s", payload)
            return

        # Idempotency: drop a duplicate redelivery while the first is still in flight.
        if req.job_id in self._inflight:
            log.info("ANR job %s already in flight — dropping duplicate", req.job_id)
            return
        self._inflight.add(req.job_id)
        try:
            async with self._sem:
                result = await self._fulfill(req)
        finally:
            self._inflight.discard(req.job_id)

        await self._publish_result(req.tenant_id, result)

    async def _fulfill(self, req: AnrRequest) -> AnrResult:
        """Run the fulfiller under its own DB session; any crash → a failed result."""
        try:
            async with self._sessionmaker() as db:
                svc = AnrFulfiller(db, scope_for(req.tenant_id))
                return await svc.fulfill(req)
        except Exception as exc:  # noqa: BLE001 — never let a job crash the subscription
            log.warning("ANR job %s crashed: %s", req.job_id, exc)
            return AnrResult(req.job_id, "failed", error=f"internal error: {exc}")

    async def _publish_result(self, tenant_id: str | None, result: AnrResult) -> None:
        """Publish ``tenant.<id>.vms.anr.result``. Best-effort (no-op when NATS off)."""
        subj = subject(tenant_id, "vms", "anr.result")
        try:
            await self._bus.publish(subj, result.payload())
        except Exception as exc:  # noqa: BLE001 — a down bus must not crash the handler
            log.warning("ANR result publish failed for job %s: %s", result.job_id, exc)
            return
        log.info(
            "ANR result published: job=%s status=%s backfilled=%s",
            result.job_id, result.status, result.backfilled_segments,
        )
