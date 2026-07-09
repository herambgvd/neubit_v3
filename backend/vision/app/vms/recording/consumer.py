"""Recording NATS consumer (P3-A) — nvr segment events → Recording rows.

The Go ``nvr`` data-plane emits ``tenant.<id>.vms.recording.segment`` when a
MediaMTX fmp4 segment finalizes on disk. This consumer subscribes to that subject
family, and persists a ``Recording`` row per segment (deduped by ``path``). It is
wired in ``app.main`` lifespan (like the health sampler), runs its own DB session
per message, and is a no-op when NATS is disabled.

The consumer is NOT request-scoped: it trusts the tenant carried in the event
envelope (which the nvr derives from the tenant-scoped record path). Persistence
uses a platform scope purely to write the row under the event's tenant_id.
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kernel.auth import Scope

from app.vms.recording.service import RecordingService

log = logging.getLogger("vision.recording_consumer")

# Match every tenant's recording-segment events. The envelope carries tenant_id.
_SUBJECT = "tenant.*.vms.recording.segment"
_DURABLE = "vision-recording-segments"

# A platform scope for the writer (the consumer authorizes off the event, not a
# caller). Never used to READ another tenant's data — only to stamp the new row.
_PLATFORM_SCOPE = Scope(tenant_id=None, is_superadmin=True)


class RecordingConsumer:
    """Subscribes to nvr segment events → persists Recording rows."""

    def __init__(self, bus, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._bus = bus
        self._sessionmaker = sessionmaker
        self._started = False

    async def start(self) -> None:
        if self._started:
            return
        # A durable JetStream consumer → at-least-once + survives restarts. The
        # persist is deduped by the recordings.path unique index, so redelivery is
        # safe. If NATS is disabled the subscribe is a no-op.
        await self._bus.subscribe(_SUBJECT, self._handle, durable=_DURABLE)
        self._started = True
        log.info("recording consumer subscribed: %s (durable=%s)", _SUBJECT, _DURABLE)

    async def _handle(self, env: dict) -> None:
        """Persist one segment event. ``env`` is the decoded kernel envelope."""
        payload = env.get("payload") or {}
        tenant_id = env.get("tenant_id")
        if not payload.get("path"):
            return
        async with self._sessionmaker() as db:
            svc = RecordingService(db, _PLATFORM_SCOPE, bearer=None)
            try:
                rec_id = await svc.persist_segment(tenant_id, payload)
            except Exception as exc:  # noqa: BLE001 — one bad event must not kill the sub
                log.warning("recording persist failed for %s: %s", payload.get("path"), exc)
                return
            if rec_id:
                log.info(
                    "recording persisted: %s camera=%s (%.0fs)",
                    rec_id, payload.get("camera_id"), float(payload.get("duration") or 0),
                )
