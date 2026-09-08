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

ONLY ``vms.camera.*`` envelopes reach rule matching, and that is a FEEDBACK-LOOP
GUARD, not tidiness.

This used to rely on "popup/segment envelopes carry no matching ``event_type``, so
the engine ignores them". That was false. The ``popup`` action re-publishes the
originating event's ``event_type`` and ``camera_id`` (an operator has to be told
WHAT popped), so its ``tenant.<id>.vms.popup`` envelope came straight back through
this same ``tenant.*.vms.>`` subscription, matched the same rule, published another
popup, and went round again. One motion event with a popup rule and no cooldown
produced 6,600 fires in seconds — the only brake was the rule's cooldown, which
defaults to zero.

So the filter is explicit here: an event that did not arrive on the camera
device-event subject is not a trigger, whatever its payload happens to carry.
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

#: Envelope ``type`` prefix of a camera DEVICE event (``vms.camera.<event_type>``,
#: derived from the subject by the bus). The only family that may trigger a rule.
_CAMERA_EVENT_PREFIX = "vms.camera."


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
        """A camera device event. Never raises out (the engine is graceful).

        The subscription is the whole ``vms.>`` family (one durable, and the wall /
        popup / segment streams share it), so the TYPE is what decides whether an
        envelope is a trigger. Anything but ``vms.camera.*`` is somebody else's
        stream — including this consumer's own popup output.
        """
        etype = str(env.get("type") or "")
        if not etype.startswith(_CAMERA_EVENT_PREFIX):
            return
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
