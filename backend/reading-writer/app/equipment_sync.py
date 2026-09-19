"""Mirror core's EQUIPMENT REGISTRY into the reporting store.

WHAT THIS CLOSES
----------------
A chiller's design ΔT band, its rated TR, and which points are its supply and
return temperatures are facts about a MACHINE, and core now records them: the
infrastructure designer (`app/sites/infrastructure`, core migration 0032) keeps
a site's systems, its equipment with nameplate `design` facts, and each
equipment's point SLOTS bound by gateway tags. Building Intelligence needs all
three — `chw_delta_t_in_band` v2 reads the band off the chiller, kW/TR divides by
its TR, the L3 plant schematic draws the whole tree — and may not open core's
database to get them (contract §1). Pipeline contract §18's answer applies a
third time:

  * core OWNS the registry and is its only writer;
  * core PUBLISHES every write on the sites event spine;
  * this store keeps a local READ-MODEL (`site_systems`, `site_equipment`,
    `equipment_point_slots`, migration 0026).

Its own module and its own durable, beside `placement_sync` and
`site_facts_sync`, for their reason: three questions, and one wedging must not
stop the other two.

THE SUBJECTS — ONE DURABLE, TWO FILTERS
---------------------------------------
    tenant.<t>.sites.site_system.{created,updated,deleted}
    tenant.<t>.sites.equipment.{created,updated,design_updated,slot_set,
                                slot_removed,deleted}

Bound as ONE durable with both filter subjects rather than two durables, so the
two arrive in the order core published them. Core deletes a system by first
publishing `equipment.deleted` for each piece of equipment in it, then
`site_system.deleted`; two consumers could interleave those any way at all.

Every equipment event other than `deleted` carries the WHOLE equipment — system,
class, design facts with their units, every slot with its binding — read back
from the rows core just committed. So every non-delete is an UPSERT of the whole
thing, the slot list is replaced wholesale, and a mirror that misses one message
is corrected by the next edit of any kind. Nothing here ever replays a diff.

An equipment event also states the system's `system_name` and `system_kind`. The
system row is upserted from those two (never its description, which the event
does not carry), so equipment never hangs off a system this mirror has not
heard of because one `site_system.created` was lost.

WHAT RETENTION CANNOT ANSWER
---------------------------
Every write is published once. A consumer down longer than the stream keeps its
messages never sees them again, and no later write repairs the entities nobody
has edited since — the mirror is then silently stale, which reads exactly like a
chiller whose band was never entered. So core has a republish
(`POST /sites/{id}/infrastructure/republish`): `resynced` for every system and
every piece of equipment, carrying the same whole-entity snapshot, then ONE
`site_system.reconciled` naming every id the site really has. The restatements
heal what went missing; the reconcile removes what this mirror kept and core
deleted while the event aged out — the one damage a restatement cannot repair.
A malformed reconcile removes NOTHING; see `_reconcile`.

THE TENANT THAT IS NOT ONE
--------------------------
Exactly `site_facts_sync`'s rule: the subject segment is the literal `platform`
for a super-admin action, so the tenant comes from the message BODY, and a body
with no tenant is ACKED and COUNTED (`equipment_sync_skipped_no_tenant`) — never
stored under a fabricated tenant, never redelivered forever.

WHAT IT DOES NOT DO
-------------------
* **It never invents a fact.** `design` is mirrored as core stated it. A numeric
  fact that arrives as something other than a finite number is DROPPED — not
  coerced, not defaulted — and counted (`design_facts_dropped`), so the metric
  that needs it refuses naming it. Core validates before it writes, so this is
  transit damage and the next edit repairs it.
* **It never resolves a slot.** The binding is mirrored as tags. Which point a
  tag pair means is decided at READ time, over a window of readings, by
  `app/metric_registry/slots.py` — see that module for why storing a point id
  here would be a guess that goes stale on the next gateway rebuild.
* **It never keeps what core deleted.** Unlike a site (soft-deleted, its
  readings still real), a deleted piece of equipment is gone from core, and a
  schematic that kept drawing it would be drawing a machine the registry says
  does not exist.
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import json
import logging
import math
import uuid

import nats
from nats.errors import TimeoutError as NatsTimeoutError
from nats.js.api import AckPolicy, ConsumerConfig
from reporting.db import database
from reporting.models import MirroredEquipment, MirroredSlot, MirroredSystem
from sqlalchemy import delete as sa_delete, true as sa_true
from sqlalchemy.dialects.postgresql import insert

from .shutdown import close_nats, stop_tasks

log = logging.getLogger("reading-writer.equipment-sync")

EVENTS_STREAM = "EVENTS"
SUBJECTS = ("tenant.*.sites.site_system.>", "tenant.*.sites.equipment.>")
DURABLE = "reading-writer-equipment"

_SYSTEM_UPSERTS = {"created", "updated", "resynced"}
_EQUIPMENT_UPSERTS = {"created", "updated", "design_updated", "slot_set", "slot_removed",
                      "resynced"}
_DELETE = "deleted"
#: `site_system.reconciled` — core naming every id a site really has, published
#: last in a republish. See `_reconcile`.
_RECONCILE = "reconciled"

#: Design facts that are NUMBERS in core's vocabulary. Anything else in `design`
#: (make, model) is text and mirrored as stated.
_NUMERIC_FACTS = {"tr", "kw_rated", "kva_rated", "design_dt_min", "design_dt_max"}


class EquipmentStats:
    """Counters, so every skip is visible instead of silent."""

    def __init__(self) -> None:
        self.connected = False
        self.messages = 0
        self.systems_upserted = 0
        self.systems_deleted = 0
        self.equipment_upserted = 0
        self.equipment_deleted = 0
        self.skipped_no_tenant = 0
        self.skipped_malformed = 0
        self.skipped_other_event = 0
        self.reconciles = 0
        self.design_facts_dropped = 0
        self.errors = 0
        self.last_error: str | None = None

    def snapshot(self) -> dict:
        return {
            "equipment_sync_connected": self.connected,
            "equipment_sync_messages": self.messages,
            "equipment_sync_systems_upserted": self.systems_upserted,
            "equipment_sync_systems_deleted": self.systems_deleted,
            "equipment_sync_equipment_upserted": self.equipment_upserted,
            "equipment_sync_equipment_deleted": self.equipment_deleted,
            "equipment_sync_skipped_no_tenant": self.skipped_no_tenant,
            "equipment_sync_skipped_malformed": self.skipped_malformed,
            "equipment_sync_skipped_other_event": self.skipped_other_event,
            "equipment_sync_reconciles": self.reconciles,
            "equipment_sync_design_facts_dropped": self.design_facts_dropped,
            "equipment_sync_errors": self.errors,
            "equipment_sync_last_error": self.last_error,
        }


def _uuid(value) -> uuid.UUID | None:
    if not value:
        return None
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def _text(value, limit: int) -> str | None:
    if value is None:
        return None
    v = str(value).strip()
    return v[:limit] if v else None


def _design(raw) -> tuple[dict, int]:
    """(the design as stated, how many numeric facts were dropped).

    A numeric fact must BE a finite number. `"150"` is dropped, not parsed —
    core refuses it on the way in for the same reason: text where a number was
    meant is a row a human should look at, not one to guess about.
    """
    if not isinstance(raw, dict):
        return {}, 0
    out: dict = {}
    dropped = 0
    for key, value in raw.items():
        if value is None:
            continue  # absent and null are one state: NOT RECORDED
        if key in _NUMERIC_FACTS:
            if isinstance(value, bool) or not isinstance(value, (int, float)) \
                    or not math.isfinite(value):
                dropped += 1
                continue
        out[str(key)] = value
    return out, dropped


def _slot_rows(raw) -> list[dict] | None:
    """The slot list, or None when any slot is malformed.

    All-or-nothing, like `site_facts_sync`'s tariff slabs: a slot list that lost
    one binding in transit would quietly unbind a chiller's supply temperature,
    and the schematic would show a configuration gap nobody made. So a damaged
    list is refused in full and the previous slots kept until the next event
    restates them. Half a binding is damage too — core's own check forbids it.
    """
    if not isinstance(raw, list):
        return None
    out: list[dict] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            return None
        slot = _text(item.get("slot"), 32)
        dtag, ptag = item.get("device_tag"), item.get("point_tag")
        if not slot or slot in seen:
            return None
        if (dtag is None) != (ptag is None):
            return None
        if dtag is not None and not (isinstance(dtag, str) and isinstance(ptag, str)):
            return None
        seen.add(slot)
        # Tags EXACTLY as core stored them — case and inner spaces are how the
        # gateway spells them, and a normalised copy would match no point.
        out.append({"slot": slot,
                    "device_tag": dtag[:255] if dtag else None,
                    "point_tag": ptag[:255] if ptag else None})
    return out


def _entity_event(envelope: dict) -> tuple[str, str]:
    """`("equipment", "slot_set")` from core's `event: "equipment.slot_set"`.

    The entity matters here in a way it does not for the other two mirrors:
    `deleted` means two different things on the two subjects this consumer binds.
    """
    raw = str(envelope.get("event") or "")
    entity, _, event = raw.rpartition(".")
    return entity.rsplit(".", 1)[-1], event


class EquipmentSync:
    def __init__(self, stats: EquipmentStats) -> None:
        self.stats = stats
        self._nc = None
        self._js = None
        self._sub = None
        self._task: asyncio.Task | None = None
        self._running = False

    async def start(self, nats_url: str) -> None:
        if not nats_url:
            log.info("VE_NATS_URL unset — the equipment registry will not reach BI")
            return
        self._running = True
        self._task = asyncio.create_task(self._run(nats_url), name="rw-equipment-sync")

    async def stop(self) -> None:
        self._running = False
        await stop_tasks(self._task)
        self._task = None
        await close_nats(self._nc)
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
                log.warning("equipment sync loop restarting after: %s", exc)
                await asyncio.sleep(5.0)

    async def _connect(self, nats_url: str) -> None:
        if self._nc is None or not self._nc.is_connected:
            self._nc = await nats.connect(
                nats_url, name="neubit-reading-writer-equipment", max_reconnect_attempts=-1
            )
            self._js = self._nc.jetstream()
        cfg = ConsumerConfig(
            durable_name=DURABLE,
            filter_subjects=list(SUBJECTS),
            ack_policy=AckPolicy.EXPLICIT,
            ack_wait=60.0,
            max_deliver=-1,
        )
        self._sub = await self._js.pull_subscribe(
            SUBJECTS[0], durable=DURABLE, stream=EVENTS_STREAM, config=cfg
        )
        self.stats.connected = True
        log.info("bound durable pull consumer %s on %s (filters=%s)",
                 DURABLE, EVENTS_STREAM, ", ".join(SUBJECTS))

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
            entity, event = _entity_event(envelope)
            if not isinstance(payload, dict):
                raise ValueError("payload is not an object")
        except Exception as exc:  # noqa: BLE001
            # Can never become a row; acking it stops an infinite redelivery.
            self.stats.skipped_malformed += 1
            log.warning("dropping unparseable equipment event on %s: %s", msg.subject, exc)
            with contextlib.suppress(Exception):
                await msg.ack()
            return

        try:
            await self._apply(entity, event, payload, msg.subject)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            # A real failure (the store is down): do not ack, let NATS redeliver.
            self.stats.errors += 1
            self.stats.last_error = f"{type(exc).__name__}: {exc}"
            log.warning("equipment event %s failed, will be redelivered: %s", msg.subject, exc)
            with contextlib.suppress(Exception):
                await msg.nak(delay=5)
            return

        with contextlib.suppress(Exception):
            await msg.ack()

    # ── deciding ─────────────────────────────────────────────────────────────

    async def _apply(self, entity: str, event: str, payload: dict, subject: str) -> None:
        if entity == "site_system":
            known = event in _SYSTEM_UPSERTS or event in (_DELETE, _RECONCILE)
        elif entity == "equipment":
            known = event in _EQUIPMENT_UPSERTS or event == _DELETE
        else:
            known = False
        if not known:
            self.stats.skipped_other_event += 1
            return

        # THE TENANT COMES FROM THE BODY. See the module docstring.
        tenant = _uuid(payload.get("tenant_id"))
        if tenant is None:
            self.stats.skipped_no_tenant += 1
            log.info("equipment registry event on %s has no tenant; not mirrored", subject)
            return

        if entity == "site_system":
            await self._apply_system(tenant, event, payload, subject)
        else:
            await self._apply_equipment(tenant, event, payload, subject)

    async def _apply_system(self, tenant, event: str, payload: dict, subject: str) -> None:
        if event == _RECONCILE:
            await self._reconcile(tenant, payload, subject)
            return
        system_id = _uuid(payload.get("system_id"))
        site_id = _uuid(payload.get("site_id"))
        if system_id is None or site_id is None:
            self.stats.skipped_malformed += 1
            return
        if event == _DELETE:
            # Core states which equipment went with it. Its `equipment.deleted`
            # events already removed them; the list is honoured anyway, and so is
            # the system id, because a lost equipment event must not leave a
            # machine hanging off a plant core no longer has.
            doomed = [e for e in (_uuid(x) for x in payload.get("equipment_ids") or []) if e]
            await self._delete_system(tenant, system_id, doomed)
            self.stats.systems_deleted += 1
            log.info("unmirrored system %s (%s)", system_id, payload.get("name"))
            return
        name, kind = _text(payload.get("name"), 100), _text(payload.get("kind"), 32)
        if not name or not kind:
            self.stats.skipped_malformed += 1
            return
        await self._upsert_system(
            {"tenant_id": tenant, "system_id": system_id, "site_id": site_id,
             "name": name, "kind": kind,
             "description": _text(payload.get("description"), 500)},
            with_description=True,
        )
        self.stats.systems_upserted += 1

    async def _apply_equipment(self, tenant, event: str, payload: dict, subject: str) -> None:
        equipment_id = _uuid(payload.get("equipment_id"))
        if equipment_id is None:
            self.stats.skipped_malformed += 1
            return
        if event == _DELETE:
            await self._delete_equipment(tenant, [equipment_id])
            self.stats.equipment_deleted += 1
            log.info("unmirrored equipment %s (%s)", equipment_id, payload.get("tag"))
            return

        site_id = _uuid(payload.get("site_id"))
        system_id = _uuid(payload.get("system_id"))
        tag = _text(payload.get("tag"), 64)
        cls = _text(payload.get("equipment_class"), 32)
        if site_id is None or system_id is None or not tag or not cls:
            self.stats.skipped_malformed += 1
            return

        design, dropped = _design(payload.get("design"))
        if dropped:
            self.stats.design_facts_dropped += dropped
            log.warning("%d design fact(s) on %s were not finite numbers; not mirrored",
                        dropped, tag)
        units = payload.get("design_units")
        units = {str(k): str(v) for k, v in units.items()} if isinstance(units, dict) else {}

        slots = _slot_rows(payload["slots"]) if "slots" in payload else None
        if slots is None:
            # A missing or damaged list: the equipment row is still restated, the
            # previous slots are kept, and the next event restates them in full.
            self.stats.skipped_malformed += 1
            log.warning("slot list on %s malformed or absent; keeping previous slots", subject)

        system = None
        sname, skind = _text(payload.get("system_name"), 100), _text(payload.get("system_kind"), 32)
        if sname and skind:
            system = {"tenant_id": tenant, "system_id": system_id, "site_id": site_id,
                      "name": sname, "kind": skind}

        await self._write_equipment(
            {"tenant_id": tenant, "equipment_id": equipment_id, "site_id": site_id,
             "system_id": system_id, "tag": tag, "name": _text(payload.get("name"), 100),
             "equipment_class": cls, "design": design, "design_units": units,
             # What feeds it, as core stated it. A malformed id is NULL — an
             # unhooked board — never a guess at which one was meant.
             "fed_by_id": _uuid(payload.get("fed_by_id")),
             "source": _text(payload.get("source"), 32)},
            slots,
            system,
        )
        self.stats.equipment_upserted += 1
        log.info("mirrored %s %s (%s): %d design fact(s), slots=%s",
                 cls, tag, event, len(design),
                 "kept" if slots is None else len(slots))

    async def _reconcile(self, tenant, payload: dict, subject: str) -> None:
        """Drop what this site's mirror holds and core's republish did not name.

        THE ONE DAMAGE A RESTATEMENT CANNOT REPAIR. A republish restates every
        entity core still has, so anything missing is filled in. A DELETE whose
        event aged out leaves no trace to restate — the mirror simply keeps a
        machine core no longer has, and a schematic goes on drawing it. Core ends
        a republish by naming every id the site really has, and what is not in
        that list is removed.

        A MALFORMED MESSAGE DELETES NOTHING. Both lists must be present and be
        lists; a body missing one is counted and acked, never read as "this site
        has no plant" — that reading would empty a whole building's registry on
        one damaged message.
        """
        site_id = _uuid(payload.get("site_id"))
        systems, equipment = payload.get("system_ids"), payload.get("equipment_ids")
        if site_id is None or not isinstance(systems, list) or not isinstance(equipment, list):
            self.stats.skipped_malformed += 1
            log.warning("reconcile on %s is malformed; nothing removed", subject)
            return
        keep_systems = [s for s in (_uuid(x) for x in systems) if s]
        keep_equipment = [e for e in (_uuid(x) for x in equipment) if e]

        gone_equipment, gone_systems = await self._reconcile_rows(
            tenant, site_id, keep_systems, keep_equipment)
        self.stats.equipment_deleted += gone_equipment
        self.stats.systems_deleted += gone_systems
        self.stats.reconciles += 1
        log.info("reconciled site %s: removed %d equipment, %d system(s)",
                 site_id, gone_equipment, gone_systems)

    # ── writing — each one transaction, each replaceable in a test ───────────

    @staticmethod
    def _system_stmt(values: dict, *, with_description: bool):
        now = dt.datetime.now(dt.timezone.utc)
        stmt = insert(MirroredSystem).values({**values, "mirrored_at": now})
        cols = ["site_id", "name", "kind", "mirrored_at"]
        if with_description:
            cols.append("description")
        return stmt.on_conflict_do_update(
            index_elements=[MirroredSystem.tenant_id, MirroredSystem.system_id],
            set_={k: stmt.excluded[k] for k in cols},
        )

    async def _upsert_system(self, values: dict, *, with_description: bool) -> None:
        sessionmaker = database.get_sessionmaker()
        async with sessionmaker() as session:
            await session.execute(self._system_stmt(values, with_description=with_description))
            await session.commit()

    async def _write_equipment(self, values: dict, slots: list[dict] | None,
                               system: dict | None) -> None:
        """The equipment row, its system's name/kind and — when stated — its whole
        slot list, in ONE transaction: a slot list replaced without its equipment,
        or the reverse, is a schematic that is briefly a lie."""
        now = dt.datetime.now(dt.timezone.utc)
        stmt = insert(MirroredEquipment).values({**values, "mirrored_at": now})
        stmt = stmt.on_conflict_do_update(
            index_elements=[MirroredEquipment.tenant_id, MirroredEquipment.equipment_id],
            set_={k: stmt.excluded[k] for k in values
                  if k not in ("tenant_id", "equipment_id")} | {"mirrored_at": now},
        )
        tenant, equipment_id = values["tenant_id"], values["equipment_id"]
        sessionmaker = database.get_sessionmaker()
        async with sessionmaker() as session:
            if system is not None:
                await session.execute(self._system_stmt(system, with_description=False))
            await session.execute(stmt)
            if slots is not None:
                await session.execute(
                    sa_delete(MirroredSlot).where(
                        MirroredSlot.tenant_id == tenant,
                        MirroredSlot.equipment_id == equipment_id,
                    )
                )
                for row in slots:
                    session.add(MirroredSlot(tenant_id=tenant, equipment_id=equipment_id,
                                             site_id=values["site_id"], **row))
            await session.commit()

    async def _reconcile_rows(self, tenant, site_id, keep_systems: list,
                              keep_equipment: list) -> tuple[int, int]:
        """Remove this site's mirrored rows whose ids core did not name. One
        transaction: a site half-reconciled is a tree with a machine hanging off
        a plant that has already gone."""
        sessionmaker = database.get_sessionmaker()
        async with sessionmaker() as session:
            stale = (
                await session.execute(
                    MirroredEquipment.__table__.select()
                    .with_only_columns(MirroredEquipment.equipment_id)
                    .where(MirroredEquipment.tenant_id == tenant,
                           MirroredEquipment.site_id == site_id,
                           MirroredEquipment.equipment_id.notin_(keep_equipment)
                           if keep_equipment else sa_true())
                )
            ).scalars().all()
            if stale:
                await session.execute(sa_delete(MirroredSlot).where(
                    MirroredSlot.tenant_id == tenant, MirroredSlot.equipment_id.in_(stale)))
                await session.execute(sa_delete(MirroredEquipment).where(
                    MirroredEquipment.tenant_id == tenant,
                    MirroredEquipment.equipment_id.in_(stale)))
            dropped = await session.execute(sa_delete(MirroredSystem).where(
                MirroredSystem.tenant_id == tenant,
                MirroredSystem.site_id == site_id,
                MirroredSystem.system_id.notin_(keep_systems) if keep_systems else sa_true()))
            await session.commit()
        return len(stale), dropped.rowcount or 0

    async def _delete_equipment(self, tenant, equipment_ids: list) -> None:
        if not equipment_ids:
            return
        sessionmaker = database.get_sessionmaker()
        async with sessionmaker() as session:
            await session.execute(
                sa_delete(MirroredSlot).where(
                    MirroredSlot.tenant_id == tenant,
                    MirroredSlot.equipment_id.in_(equipment_ids),
                )
            )
            await session.execute(
                sa_delete(MirroredEquipment).where(
                    MirroredEquipment.tenant_id == tenant,
                    MirroredEquipment.equipment_id.in_(equipment_ids),
                )
            )
            await session.commit()

    async def _delete_system(self, tenant, system_id, equipment_ids: list) -> None:
        sessionmaker = database.get_sessionmaker()
        async with sessionmaker() as session:
            held = (
                await session.execute(
                    MirroredEquipment.__table__.select()
                    .with_only_columns(MirroredEquipment.equipment_id)
                    .where(MirroredEquipment.tenant_id == tenant,
                           MirroredEquipment.system_id == system_id)
                )
            ).scalars().all()
            doomed = sorted({*equipment_ids, *held}, key=str)
            if doomed:
                await session.execute(
                    sa_delete(MirroredSlot).where(
                        MirroredSlot.tenant_id == tenant,
                        MirroredSlot.equipment_id.in_(doomed),
                    )
                )
                await session.execute(
                    sa_delete(MirroredEquipment).where(
                        MirroredEquipment.tenant_id == tenant,
                        MirroredEquipment.equipment_id.in_(doomed),
                    )
                )
            await session.execute(
                sa_delete(MirroredSystem).where(
                    MirroredSystem.tenant_id == tenant,
                    MirroredSystem.system_id == system_id,
                )
            )
            await session.commit()
