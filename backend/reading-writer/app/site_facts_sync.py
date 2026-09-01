"""Mirror core's SITE FACTS into the reporting store's `site_facts`.

WHAT THIS CLOSES
----------------
Building Intelligence → Ratings needs a denominator. An energy performance index
is `kWh / m² / year`, and the `m²` is a fact about a building, not about a
reading: it lives in `neubit_control.sites` (core, migration 0018) where an
operator types it beside the address, because that is where this platform already
keeps site facts. Pipeline contract §18 settled the shape of this problem for
device placement and the answer is the same one:

  * core OWNS the fact and is its only writer;
  * core PUBLISHES it on the sites event spine, stating it rather than being
    asked to confirm it;
  * this store keeps a local READ-MODEL, which is what lets `/bi/*` divide a
    measured kWh by an area without opening a database it is banned from opening
    (contract §1 — the cross-service read ban).

This is `placement_sync` for a different subject, deliberately in its own module
and on its own durable: the two answer different questions and one wedging must
not stop the other.

THE SUBJECT, AND THE TENANT THAT IS NOT ONE
--------------------------------------------
`sites/events.py` publishes `tenant.<tenant>.sites.site.<event>` — `created`,
`updated`, `building_facts_updated`, `deleted`, `restored` — captured by the
EVENTS stream. EVERY one of them carries the building facts, read from the row
core just committed, so a mirror that misses one message is corrected by the next
site edit of any kind rather than staying wrong until someone re-types an area.

The `<tenant>` SUBJECT SEGMENT is not always a tenant: a super-admin action
publishes under the reserved literal `platform`, and `site_facts.tenant_id` is a
real uuid. So the tenant is read from the message BODY, and a body with no tenant
is ACKED and COUNTED (`site_facts_sync_skipped_no_tenant`) — never retried
forever, never stored under a fabricated tenant.

WHAT IT DOES NOT DO
-------------------
* **It never invents a fact.** Every value written arrived on an event, having
  been typed by a human into Configurations → Sites. A field absent from the
  event is written as NULL — NOT RECORDED — and `/bi/rating` renders that as
  "cannot rate", not as a default, an estimate or a national average.
* **It does not delete.** A soft-deleted site keeps its row with `is_active`
  false. The readings that were measured there did not stop having been measured.
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import json
import logging
import uuid

import nats
from nats.errors import TimeoutError as NatsTimeoutError
from nats.js.api import AckPolicy, ConsumerConfig
from reporting.db import database
from sqlalchemy.dialects.postgresql import insert

from sqlalchemy import delete as sa_delete

from reporting.models import SiteEmissionFactor, SiteFact, SiteTariffSlab

log = logging.getLogger("reading-writer.site-facts-sync")

EVENTS_STREAM = "EVENTS"
SUBJECT = "tenant.*.sites.site.>"
DURABLE = "reading-writer-site-facts"

# Every site event carries the facts, so all of them are worth applying. A
# `deleted` flips `is_active` rather than removing the row.
_EVENTS = {
    "created",
    "updated",
    "building_facts_updated",
    "tariff_slabs_updated",
    "emission_factors_updated",
    "deleted",
    "restored",
}


class SiteFactsStats:
    def __init__(self) -> None:
        self.connected = False
        self.messages = 0
        self.applied = 0
        self.skipped_no_tenant = 0
        self.skipped_malformed = 0
        self.skipped_other_event = 0
        self.slab_lists_replaced = 0
        self.factor_lists_replaced = 0
        self.errors = 0
        self.last_error: str | None = None

    def snapshot(self) -> dict:
        return {
            "site_facts_sync_connected": self.connected,
            "site_facts_sync_messages": self.messages,
            "site_facts_sync_applied": self.applied,
            "site_facts_sync_skipped_no_tenant": self.skipped_no_tenant,
            "site_facts_sync_skipped_malformed": self.skipped_malformed,
            "site_facts_sync_skipped_other_event": self.skipped_other_event,
            "site_facts_sync_slab_lists_replaced": self.slab_lists_replaced,
            "site_facts_sync_factor_lists_replaced": self.factor_lists_replaced,
            "site_facts_sync_errors": self.errors,
            "site_facts_sync_last_error": self.last_error,
        }


def _uuid(value) -> uuid.UUID | None:
    if not value:
        return None
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def _num(value) -> float | None:
    """A number, or None. An empty string is a publisher with nothing to say."""
    if value is None or value == "":
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if v == v else None  # NaN is not a fact


def _when(value) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _date(value) -> dt.date | None:
    if not value:
        return None
    try:
        return dt.date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _slab_rows(raw) -> list[dict] | None:
    """Parse the event's `tariff_slabs` list. Returns None when ANY row is
    malformed: a partially mirrored tariff would price some hours with another
    hour's rate, so the whole list is refused (and the previous mirror kept —
    the next site edit restates it in full) rather than half-applied."""
    if not isinstance(raw, list):
        return None
    out: list[dict] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            return None
        name = str(item.get("name") or "").strip()
        rate = _num(item.get("rate_per_kwh"))
        currency = str(item.get("currency") or "").strip()
        eff = _date(item.get("effective_from"))
        try:
            start = int(item["start_minute"])
            end = int(item["end_minute"])
        except (KeyError, TypeError, ValueError):
            return None
        if not name or rate is None or not currency or eff is None:
            return None
        if not (0 <= start < 1440 and 0 < end <= 1440):
            return None
        out.append(
            {
                "position": i,
                "name": name[:64],
                "start_minute": start,
                "end_minute": end,
                "rate_per_kwh": rate,
                "currency": currency[:8],
                "effective_from": eff,
            }
        )
    return out


def _factor_rows(raw) -> list[dict] | None:
    """Parse `emission_factors`. Same all-or-nothing rule as the slabs — and a
    factor whose `source` is missing is malformed BY DEFINITION: an uncited
    number must never enter this store, not even by transit damage."""
    if not isinstance(raw, list):
        return None
    out: list[dict] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            return None
        value = _num(item.get("kg_co2_per_kwh"))
        source = str(item.get("source") or "").strip()
        eff = _date(item.get("effective_from"))
        if value is None or not source or eff is None:
            return None
        out.append(
            {
                "position": i,
                "kg_co2_per_kwh": value,
                "source": source[:512],
                "effective_from": eff,
            }
        )
    return out


class SiteFactsSync:
    def __init__(self, stats: SiteFactsStats) -> None:
        self.stats = stats
        self._nc = None
        self._js = None
        self._sub = None
        self._task: asyncio.Task | None = None
        self._running = False

    async def start(self, nats_url: str) -> None:
        if not nats_url:
            log.info("VE_NATS_URL unset — site facts will not reach BI")
            return
        self._running = True
        self._task = asyncio.create_task(self._run(nats_url), name="rw-site-facts-sync")

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None
        if self._nc is not None:
            # Bounded drain, then close. A pull consumer has nothing buffered to
            # flush — every message is acked as it is applied — so an unbounded
            # `drain()` here can only ever make a shutdown hang, which on a
            # reloading dev server looks like the service died.
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._nc.drain(), timeout=2.0)
            with contextlib.suppress(Exception):
                await self._nc.close()
            self._nc = None
        self.stats.connected = False

    async def _run(self, nats_url: str) -> None:
        # Retries forever: core creates EVENTS when IT connects and this service
        # can boot first, so the bind belongs in the loop, not in startup.
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
                log.warning("site facts sync loop restarting after: %s", exc)
                await asyncio.sleep(5.0)

    async def _connect(self, nats_url: str) -> None:
        if self._nc is None or not self._nc.is_connected:
            self._nc = await nats.connect(
                nats_url, name="neubit-reading-writer-site-facts", max_reconnect_attempts=-1
            )
            self._js = self._nc.jetstream()
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
        log.info("bound durable pull consumer %s on %s (filter=%s)", DURABLE, EVENTS_STREAM, SUBJECT)

    async def _consume(self) -> None:
        while self._running:
            try:
                msgs = await self._sub.fetch(10, timeout=5.0)
            except (NatsTimeoutError, asyncio.TimeoutError):
                continue
            for msg in msgs:
                await self._handle(msg)

    async def _handle(self, msg) -> None:
        self.stats.messages += 1
        try:
            envelope = json.loads(msg.data.decode())
            payload = envelope.get("payload") or {}
            event = str(envelope.get("event") or "").rsplit(".", 1)[-1]
        except Exception as exc:  # noqa: BLE001
            self.stats.skipped_malformed += 1
            log.warning("dropping unparseable site event on %s: %s", msg.subject, exc)
            with contextlib.suppress(Exception):
                await msg.ack()
            return

        try:
            await self._apply(event, payload, msg.subject)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            # A real failure (the store is down): do not ack, let NATS redeliver.
            self.stats.errors += 1
            self.stats.last_error = f"{type(exc).__name__}: {exc}"
            log.warning("site event %s failed, will be redelivered: %s", msg.subject, exc)
            with contextlib.suppress(Exception):
                await msg.nak(delay=5)
            return

        with contextlib.suppress(Exception):
            await msg.ack()

    async def _apply(self, event: str, payload: dict, subject: str) -> None:
        if event not in _EVENTS:
            self.stats.skipped_other_event += 1
            return

        tenant = _uuid(payload.get("tenant_id"))
        if tenant is None:
            # Platform-scoped action. `site_facts.tenant_id` is a real uuid;
            # inventing one would be a fabricated fact about a real building.
            self.stats.skipped_no_tenant += 1
            log.info("site event on %s has no tenant; not mirrored", subject)
            return

        site_id = _uuid(payload.get("site_id"))
        if site_id is None:
            self.stats.skipped_malformed += 1
            return

        values = {
            "tenant_id": tenant,
            "site_id": site_id,
            "site_name": payload.get("name"),
            "is_active": bool(payload.get("is_active", True)),
            # Absent → NULL → NOT RECORDED. Nothing is defaulted and nothing is
            # carried over from the previous mirror: core states the whole set on
            # every site event, so the last message is the whole truth.
            "gross_floor_area_sqm": _num(payload.get("gross_floor_area_sqm")),
            "energy_tariff_per_kwh": _num(payload.get("energy_tariff_per_kwh")),
            "tariff_currency": payload.get("tariff_currency") or None,
            "occupancy": (
                int(payload["occupancy"])
                if isinstance(payload.get("occupancy"), (int, float))
                else None
            ),
            "facts_updated_at": _when(payload.get("building_facts_updated_at")),
            "mirrored_at": dt.datetime.now(dt.timezone.utc),
        }
        # `city` (migration 0013) is applied only when the publisher STATED the
        # key. Core has published it on every site event since 0019, so this
        # guard exists for one reason: a pre-0019 message still in flight says
        # nothing about the city, and "missing" must never clobber a value a
        # later message already mirrored. Stated-but-null DOES clear — that is
        # core saying the address has no city, and the portfolio renders "—".
        if "city" in payload:
            city = payload.get("city")
            values["city"] = str(city)[:255] if city else None
        if event == "deleted":
            values["is_active"] = False

        # The INPUT LISTS (tariff slabs, emission factors) follow the same
        # key-presence rule, then are replaced WHOLESALE per site: core states
        # the entire list on every event (an empty list is the statement "no
        # slabs"), so delete+insert needs no COALESCE discipline at all. A list
        # with any malformed row is refused in full and the previous mirror
        # kept — half a tariff prices some hours with another hour's rate.
        slabs = _slab_rows(payload["tariff_slabs"]) if "tariff_slabs" in payload else None
        if "tariff_slabs" in payload and slabs is None:
            self.stats.skipped_malformed += 1
            log.warning("tariff_slabs on %s malformed; keeping previous mirror", subject)
        factors = (
            _factor_rows(payload["emission_factors"]) if "emission_factors" in payload else None
        )
        if "emission_factors" in payload and factors is None:
            self.stats.skipped_malformed += 1
            log.warning("emission_factors on %s malformed; keeping previous mirror", subject)

        stmt = insert(SiteFact).values(values)
        stmt = stmt.on_conflict_do_update(
            index_elements=[SiteFact.tenant_id, SiteFact.site_id],
            set_={k: stmt.excluded[k] for k in values if k not in ("tenant_id", "site_id")},
        )

        sessionmaker = database.get_sessionmaker()
        async with sessionmaker() as session:
            await session.execute(stmt)
            if slabs is not None:
                await session.execute(
                    sa_delete(SiteTariffSlab).where(
                        SiteTariffSlab.tenant_id == tenant, SiteTariffSlab.site_id == site_id
                    )
                )
                for row in slabs:
                    session.add(
                        SiteTariffSlab(tenant_id=tenant, site_id=site_id, **row)
                    )
                self.stats.slab_lists_replaced += 1
            if factors is not None:
                await session.execute(
                    sa_delete(SiteEmissionFactor).where(
                        SiteEmissionFactor.tenant_id == tenant,
                        SiteEmissionFactor.site_id == site_id,
                    )
                )
                for row in factors:
                    session.add(
                        SiteEmissionFactor(tenant_id=tenant, site_id=site_id, **row)
                    )
                self.stats.factor_lists_replaced += 1
            await session.commit()
        self.stats.applied += 1
        log.info(
            "mirrored site facts for %s (%s): area=%s tariff=%s occupancy=%s city=%s "
            "slabs=%s factors=%s",
            site_id,
            values["site_name"],
            values["gross_floor_area_sqm"],
            values["energy_tariff_per_kwh"],
            values["occupancy"],
            values.get("city", "<not stated>"),
            "<not stated>" if slabs is None else len(slabs),
            "<not stated>" if factors is None else len(factors),
        )
