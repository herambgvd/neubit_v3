"""Linkage NATS consumer (P5-B) — camera + access events → the linkage engine.

Subscribes to TWO subject families and drives the ``LinkageEngine``:

  * ``tenant.*.vms.>``    — camera device events (P5-A) + status. The engine matches the
    payload's ``event_type`` against rules whose ``trigger_event_type`` is a camera type
    (motion|tamper|video_loss|io_input|line_crossing|zone_intrusion|audio|…).
  * ``tenant.*.access.>`` — access controller events (the gates service). The engine maps
    ``access.<category>.<type>`` → ``access_<category>_<type>`` (e.g.
    ``access_door_forced``) and resolves the door→camera(s) for access↔video verification.

Both are DURABLE JetStream consumers (at-least-once + survive restarts). The engine's
cooldown + the fire-audit make redelivery safe (a re-delivered event within cooldown is a
no-op). No-op when NATS is disabled. Wired in ``app.main`` lifespan alongside the
recording consumer.

We deliberately DON'T subscribe our OWN ``tenant.*.vms.popup`` / recording-segment
subjects into rule-matching — a rule triggers on ``event_type`` (a camera device event),
and popup/segment/status envelopes carry no matching ``event_type``, so they're ignored
by the engine (``handle_camera_event`` early-returns when there's no ``event_type`` +
``camera_id``). This keeps the ``vms.>`` wildcard safe without a feedback loop.
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .service import LinkageEngine

log = logging.getLogger("vision.linkage_consumer")

_VMS_SUBJECT = "tenant.*.vms.>"
_VMS_DURABLE = "vision-linkage-vms"
_ACCESS_SUBJECT = "tenant.*.access.>"
_ACCESS_DURABLE = "vision-linkage-access"


class LinkageConsumer:
    """Subscribes to camera + access events → runs matching linkage rules."""

    def __init__(self, bus, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._bus = bus
        self._engine = LinkageEngine(sessionmaker)
        self._started = False

    @property
    def engine(self) -> LinkageEngine:
        return self._engine

    async def start(self) -> None:
        if self._started:
            return
        await self._bus.subscribe(_VMS_SUBJECT, self._on_vms, durable=_VMS_DURABLE)
        await self._bus.subscribe(_ACCESS_SUBJECT, self._on_access, durable=_ACCESS_DURABLE)
        self._started = True
        log.info(
            "linkage consumer subscribed: %s (durable=%s) + %s (durable=%s)",
            _VMS_SUBJECT, _VMS_DURABLE, _ACCESS_SUBJECT, _ACCESS_DURABLE,
        )

    async def _on_vms(self, env: dict) -> None:
        """A camera ``vms.>`` event. Never raises out (the engine is graceful)."""
        try:
            n = await self._engine.handle_camera_event(env)
            if n:
                log.info("linkage: %d rule(s) fired for %s", n, env.get("type"))
        except Exception as exc:  # noqa: BLE001 — one bad event must not kill the sub
            log.warning("linkage vms handler error (%s): %s", env.get("type"), exc)

    async def _on_access(self, env: dict) -> None:
        """An access ``access.>`` event (door forced/held/…). Never raises out."""
        try:
            n = await self._engine.handle_access_event(env)
            if n:
                log.info("linkage: %d rule(s) fired for access %s", n, env.get("type"))
        except Exception as exc:  # noqa: BLE001 — one bad event must not kill the sub
            log.warning("linkage access handler error (%s): %s", env.get("type"), exc)
