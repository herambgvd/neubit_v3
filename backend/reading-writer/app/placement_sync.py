"""Mirror core's device placements into the reporting store's `device_locations`.

WHAT THIS CLOSES
----------------
`neubit_control.device_placements` is where an operator says where a device is:
Configurations → Sites → floor plan, the editor that already pins cameras and
doors onto a drawing at `{x, y, rotation}`. It has carried `site_id` / `floor_id`
/ `zone_id` since it was ported, and `app/sites/device/service.py` has emitted a
domain event on every write since then — with, in its own words, *"no consumers
yet"*.

`neubit_reporting.device_locations` is the row Building Intelligence derives
`points.site_id` / `floor_id` / `zone_id` from (see `reporting.placement`). Until
now the only thing that wrote it was a second, BI-only placement screen, which
meant the platform had two places to say the same thing and no way to notice when
they disagreed.

This consumer removes the second one. `device_placements` is the source of truth;
`device_locations` is reporting's local READ-MODEL of it, which is the whole
reason BI can answer a floor-wise question without reading a database it is
banned from reading (pipeline contract §1).

THE SUBJECT, AND THE TENANT THAT IS NOT ONE
--------------------------------------------
`sites/events.py` publishes `tenant.<tenant>.sites.device_placement.<event>` with
events `placed`, `placement_updated` and `placement_removed`, captured by the
EVENTS stream (`tenant.*.sites.>`).

The `<tenant>` SUBJECT SEGMENT is not always a tenant. A super-admin action has
`tenant_id = NULL`, and a NULL cannot be a subject token, so it is published under
the reserved literal `platform`. `device_locations.tenant_id` is a real
`uuid NOT NULL`. So:

* the tenant is read from the message BODY (`payload.tenant_id`, `str | None`),
  never from the subject;
* a message whose body tenant is NULL is ACKED and COUNTED, not retried and not
  logged as an error. There is no tenant to mirror it into, inventing one would
  be a fabricated placement, and NAKing it would redeliver a message that can
  never succeed. `skipped_no_tenant` on /stats is where it shows up.

WHAT IT DOES NOT DO
-------------------
* **It never invents a placement.** Every value it writes came from a
  `device_placements` row an operator created, and the site / floor / zone NAMES
  ride on the event from core's own tables — the authority publishes the label
  beside the id it minted, so no name here ever came from a browser.
* **It only mirrors IoT devices.** `service != "iot"` is acked and ignored: a
  camera's id is a VMS id and has no meaning in this store. (The upsert would
  match no `points` row anyway; the filter makes that a decision rather than a
  coincidence.)
* **It only places devices this store has actually seen.** `place_devices`
  selects from `points`, so a device that has never reported writes no row and is
  counted as `skipped_unknown_device`. Unplaced stays unplaced.

INHERITANCE IS UNTOUCHED
------------------------
The write goes through the same `place_devices` / `unplace_devices` the deleted
API used, so it ends in the same `reconcile_placement()`. A point that reports for
the first time tomorrow still inherits its device's placement on the WRITE path
(`app/store.py`), because that property lives in the reconcile and in the writer,
not in whatever wrote `device_locations`.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import uuid

import nats
from nats.errors import TimeoutError as NatsTimeoutError
from nats.js.api import AckPolicy, ConsumerConfig

from reporting.db import database

from .api import placement as pl

log = logging.getLogger("reading-writer.placement-sync")

# The EVENTS stream is core's (and the kernel's). This service binds a consumer on
# it; it never creates or converges it — two services converging one stream onto
# two different subject lists is how a domain quietly stops being captured.
EVENTS_STREAM = "EVENTS"
SUBJECT = "tenant.*.sites.device_placement.>"
DURABLE = "reading-writer-placement"

# Events we act on. Anything else on the filter is acked and ignored, so a new
# sites event cannot wedge this consumer.
_PLACE_EVENTS = {"placed", "placement_updated"}
_REMOVE_EVENT = "placement_removed"

# Written into `device_locations.source`. Not "operator": an operator did make
# this placement, but they made it on a floor plan, and the provenance of the row
# should say which surface it came through.
_SOURCE = "floor_plan"


class PlacementStats:
    """Counters, so every skip is visible instead of silent."""

    def __init__(self) -> None:
        self.connected = False
        self.messages = 0
        self.placed = 0
        self.removed = 0
        self.points_updated = 0
        self.skipped_no_tenant = 0
        self.skipped_not_iot = 0
        self.skipped_unknown_device = 0
        self.skipped_malformed = 0
        self.errors = 0
        self.last_error: str | None = None

    def snapshot(self) -> dict:
        return {
            "placement_sync_connected": self.connected,
            "placement_sync_messages": self.messages,
            "placement_sync_placed": self.placed,
            "placement_sync_removed": self.removed,
            "placement_sync_points_updated": self.points_updated,
            "placement_sync_skipped_no_tenant": self.skipped_no_tenant,
            "placement_sync_skipped_not_iot": self.skipped_not_iot,
            "placement_sync_skipped_unknown_device": self.skipped_unknown_device,
            "placement_sync_skipped_malformed": self.skipped_malformed,
            "placement_sync_errors": self.errors,
            "placement_sync_last_error": self.last_error,
        }


def _uuid(value) -> uuid.UUID | None:
    if not value:
        return None
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


class PlacementSync:
    def __init__(self, stats: PlacementStats) -> None:
        self.stats = stats
        self._nc = None
        self._js = None
        self._sub = None
        self._task: asyncio.Task | None = None
        self._running = False

    async def start(self, nats_url: str) -> None:
        if not nats_url:
            log.info("VE_NATS_URL unset — floor-plan placements will not reach BI")
            return
        self._running = True
        self._task = asyncio.create_task(self._run(nats_url), name="rw-placement-sync")

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None
        if self._nc is not None:
            with contextlib.suppress(Exception):
                await self._nc.drain()
            self._nc = None
        self.stats.connected = False

    # ── loop ─────────────────────────────────────────────────────────────────
    async def _run(self, nats_url: str) -> None:
        """Connect, bind, consume. Retries forever: EVENTS may not exist yet.

        Core creates the EVENTS stream when IT connects, and this service can boot
        first. A one-shot bind would then silently never run, so the bind is part
        of the loop rather than part of startup.
        """
        while self._running:
            try:
                await self._connect(nats_url)
                await self._consume()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — never let the loop die
                self.stats.connected = False
                self.stats.errors += 1
                self.stats.last_error = f"{type(exc).__name__}: {exc}"
                log.warning("placement sync loop restarting after: %s", exc)
                await asyncio.sleep(5.0)

    async def _connect(self, nats_url: str) -> None:
        if self._nc is None or not self._nc.is_connected:
            self._nc = await nats.connect(
                nats_url, name="neubit-reading-writer-placement",
                max_reconnect_attempts=-1,
            )
            self._js = self._nc.jetstream()
        # A durable PULL consumer with the same shape as the readings one: every
        # replica binds the same durable, so NATS distributes the work and a
        # second replica does not double-apply a placement.
        cfg = ConsumerConfig(
            durable_name=DURABLE,
            filter_subject=SUBJECT,
            ack_policy=AckPolicy.EXPLICIT,
            ack_wait=60.0,
            max_deliver=-1,
        )
        self._sub = await self._js.pull_subscribe(
            SUBJECT, durable=DURABLE, stream=EVENTS_STREAM, config=cfg
        )
        self.stats.connected = True
        log.info(
            "bound durable pull consumer %s on %s (filter=%s)",
            DURABLE, EVENTS_STREAM, SUBJECT,
        )

    async def _consume(self) -> None:
        while self._running:
            try:
                msgs = await self._sub.fetch(10, timeout=5.0)
            except (NatsTimeoutError, asyncio.TimeoutError):
                continue
            for msg in msgs:
                await self._handle(msg)

    # ── one message ──────────────────────────────────────────────────────────
    async def _handle(self, msg) -> None:
        self.stats.messages += 1
        try:
            envelope = json.loads(msg.data.decode())
            payload = envelope.get("payload") or {}
            event = str(envelope.get("event") or "").rsplit(".", 1)[-1]
        except Exception as exc:  # noqa: BLE001
            # Can never become a row; acking it stops an infinite redelivery of a
            # message nothing can parse. Counted, not swallowed.
            self.stats.skipped_malformed += 1
            log.warning("dropping unparseable placement event on %s: %s", msg.subject, exc)
            with contextlib.suppress(Exception):
                await msg.ack()
            return

        try:
            await self._apply(event, payload, msg.subject)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            # A real failure (the database is down) — do NOT ack. NATS redelivers
            # and the placement lands when the store comes back.
            self.stats.errors += 1
            self.stats.last_error = f"{type(exc).__name__}: {exc}"
            log.warning("placement event %s failed, will be redelivered: %s", msg.subject, exc)
            with contextlib.suppress(Exception):
                await msg.nak(delay=5)
            return

        with contextlib.suppress(Exception):
            await msg.ack()

    async def _apply(self, event: str, payload: dict, subject: str) -> None:
        if event not in _PLACE_EVENTS and event != _REMOVE_EVENT:
            return

        # Only IoT devices exist in this store. A camera or a door is a real
        # placement on the same floor plan and simply is not ours.
        if (payload.get("service") or "") != "iot":
            self.stats.skipped_not_iot += 1
            return

        # THE TENANT COMES FROM THE BODY. The subject's tenant segment is the
        # literal "platform" for a super-admin action, and that is not a uuid.
        tenant = _uuid(payload.get("tenant_id"))
        if tenant is None:
            self.stats.skipped_no_tenant += 1
            log.info(
                "placement on %s has no tenant (platform-scoped action); "
                "device_locations is keyed on a real tenant, so it is not mirrored",
                subject,
            )
            return

        device_id = _uuid(payload.get("device_id"))
        if device_id is None:
            # A placement whose device id is not a uuid cannot be a reporting
            # device (their ids come from the gateway as uuids). Not an error.
            self.stats.skipped_malformed += 1
            return

        sessionmaker = database.get_sessionmaker()
        async with sessionmaker() as session:
            if event == _REMOVE_EVENT:
                result = await pl.unplace_devices(session, tenant, device_ids=[device_id])
                self.stats.removed += result.get("devices_unplaced", 0)
                self.stats.points_updated += result.get("points_updated", 0)
                log.info("unplaced iot device %s: %s", device_id, result)
                return

            site_id = _uuid(payload.get("site_id"))
            if site_id is None:
                self.stats.skipped_malformed += 1
                log.warning("placement on %s names no site; ignored", subject)
                return

            where = pl.Location(
                site_id=site_id,
                # Names came from core with the event. Never from a browser, and
                # never guessed here — a missing name would be a missing name.
                site_name=payload.get("site_name") or str(site_id),
                floor_id=_uuid(payload.get("floor_id")),
                floor_name=payload.get("floor_name"),
                zone_id=_uuid(payload.get("zone_id")),
                zone_name=payload.get("zone_name"),
            )
            result = await pl.place_devices(
                session,
                tenant,
                device_ids=[device_id],
                where=where,
                placed_by=_uuid(payload.get("actor_id")),
                source=_SOURCE,
            )
            if result.get("unknown_device_ids"):
                # The pin is real, but this store has never received a reading
                # from that device, so there is no `points` row to place. Said
                # out loud rather than reported as a success.
                self.stats.skipped_unknown_device += 1
                log.info(
                    "floor-plan pin for %s has no reporting points yet; "
                    "nothing placed in the reporting store",
                    device_id,
                )
                return
            self.stats.placed += result.get("devices_placed", 0)
            self.stats.points_updated += result.get("points_updated", 0)
            log.info("mirrored floor-plan placement of %s: %s", device_id, result)
