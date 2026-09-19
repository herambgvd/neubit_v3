"""The plant — a site's systems → equipment → slots, as an L3 schematic draws them.

`GET /bi/sites/{site_id}/plant` (bi.read). Everything a schematic needs in one
read: the site's systems from the registry mirror, each system's equipment with
its design facts, each equipment's slots with the point each resolves to — or
the reason it does not — that point's latest value and whether it reported in
the window, and per equipment every equipment-scope metric's value or refusal.

WHAT THE COLOURS MEAN
---------------------
The L3 view colours equipment by DATA READINESS, not by equipment health. A
chiller drawn green here is one whose every slot names exactly one point that
reported inside the window; it may be tripped. So every slot carries one state
from the closed set `slots.READINESS`, and every piece of equipment (and every
system) carries the least-ready state among its parts (`slots.rollup`). Those
states are the product: a registry that is 100% bound and 40% silent is a
different job from one that is 40% bound, and the schematic has to say which.

ONE RESOLVER, ONE WINDOW
------------------------
Slots resolve through `metric_registry.slots` — the same function, over the same
window, that the metric evaluator binds its slot inputs with. So the chws slot
drawn as `ambiguous` and the ΔT refused as `slot_ambiguous` are the same fact
said twice, and they cannot drift apart.

A SLOT A METRIC NEEDS IS DRAWN EVEN WHEN CORE NEVER STATED IT
---------------------------------------------------------------
Core states the slots an operator created. A chiller with only `chwr` would
therefore roll up to `reporting` — every slot it HAS reports — while ΔT, band
occupancy and kW/TR all refuse for want of `chws`. So each slot an effective
metric of the equipment's class reads is drawn whether or not it exists, an
absent one as `unbound` with `declared: false`, and every slot says which
metrics read it (`required_by`). Nothing is invented by this: "no point is
bound to this slot" is exactly as true of a slot nobody created as of one
created empty.

WHICH METRICS
-------------
Every definition EFFECTIVE at the window's end whose scope is `equipment` — read
from the registry, not listed here. A new equipment metric registered tomorrow
appears on the schematic with no release; a window that ends before 0026 ran
shows none, because `chw_delta_t_in_band` was a device metric then, and that is
what the registry says it was.
"""

from __future__ import annotations

import datetime as dt
import uuid

from kernel.errors import NotFoundError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..metric_registry import evaluator, registry
from ..metric_registry import slots as slot_store
from .queries import _rows
from .units import is_confirmed

_SITE_SQL = """
    SELECT f.site_name
      FROM site_facts f
     WHERE f.site_id = CAST(:site AS uuid)
       AND (CAST(:tenant AS uuid) IS NULL OR f.tenant_id = CAST(:tenant AS uuid))
"""

_SYSTEMS_SQL = """
    SELECT sy.system_id, sy.name, sy.kind, sy.description
      FROM site_systems sy
     WHERE sy.site_id = CAST(:site AS uuid)
       AND (CAST(:tenant AS uuid) IS NULL OR sy.tenant_id = CAST(:tenant AS uuid))
     ORDER BY sy.name
"""

#: The most equipment one site's schematic is drawn with. Far above any plant
#: room; a bound so a malformed mirror cannot turn one request into a scan.
MAX_EQUIPMENT = 500

#: Heavy per-bucket detail the evaluator returns and a schematic never draws.
_DROP_FROM_METRIC = ("series",)


def _point_view(point: dict | None) -> dict | None:
    if point is None:
        return None
    return {
        "point_id": str(point["point_id"]),
        "point_tag": point["point_tag"],
        "device_tag": point["device_tag"],
        "unit": point.get("unit"),
        # A number with no operator-confirmed unit is drawn, but it is not a
        # quantity, and a metric will not compute on it. Said per point so the
        # schematic can mark it rather than implying the metric's refusal.
        "unit_confirmed": is_confirmed(point),
        "last_seen_at": point.get("last_seen_at"),
    }


def slot_view(
    slot: dict, resolution: dict, *, declared: bool = True,
    required_by: list[str] | None = None,
) -> dict:
    """One slot as the schematic draws it. `latest` is set only when the slot is
    REPORTING — a silent point's last value is history, not a reading."""
    point = resolution.get("point")
    reporting = resolution["readiness"] == slot_store.REPORTING
    bound = bool(slot.get("device_tag") and slot.get("point_tag"))
    slot_def = slot_store.SLOT_DEFS.get(slot["slot"], {})
    return {
        "slot": slot["slot"],
        "label": slot_def.get("label", slot["slot"]),
        "dimension": slot_def.get("dimension"),
        "binding": (
            {"device_tag": slot["device_tag"], "point_tag": slot["point_tag"]}
            if bound else None
        ),
        "readiness": resolution["readiness"],
        "reason": resolution.get("reason"),
        "point": _point_view(point),
        "latest": (
            {"t": point.get("last_in_window"), "value": point.get("last_num"),
             "text": point.get("last_txt")}
            if reporting and point else None
        ),
        "candidates": resolution.get("candidates") or [],
        "ghosts": resolution.get("ghosts") or [],
        "declared": declared,
        "required_by": sorted(required_by or []),
    }


def _counts(states) -> dict[str, int]:
    out = {s: 0 for s in slot_store.READINESS}
    for s in states:
        out[s] += 1
    return out


async def _equipment_metrics(
    db: AsyncSession, tenant, site_id, start: dt.datetime, end: dt.datetime
) -> tuple[list[dict], dict[str, dict]]:
    """(the metrics evaluated, `{equipment_id: {key: outcome}}`).

    Each effective equipment-scope definition is evaluated ONCE over the site
    — the evaluator fans it out over the site's equipment of its class — rather
    than once per piece of equipment, which would re-resolve every slot N times.
    """
    keys = sorted({d["key"] for d in await registry.list_definitions(db, tenant)})
    metrics: list[dict] = []
    by_equipment: dict[str, dict] = {}
    for key in keys:
        defn = await registry.effective(db, tenant, key, end)
        if defn is None or (defn.get("applies_to") or {}).get("scope") != "equipment":
            continue
        result = await evaluator.evaluate(
            db, tenant, key, site_id=site_id, start=start, end=end
        )
        display = result.get("display") or {}
        metrics.append({
            "metric": key, "version": result["version"],
            "label": display.get("label"), "precision": display.get("precision"),
            "equipment_class": (defn.get("applies_to") or {}).get("equipment_class"),
            "slots": sorted({
                spec["slot"] for spec in (defn.get("inputs") or {}).values()
                if spec.get("source") == "slot"
            }),
            "resolution": result["resolution"],
        })
        for item in result["items"]:
            outcome = {k: v for k, v in item.items() if k not in _DROP_FROM_METRIC}
            outcome.update(metric=key, version=result["version"])
            by_equipment.setdefault(item["equipment_id"], {})[key] = outcome
    return metrics, by_equipment


async def plant(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    site_id: uuid.UUID,
    *,
    start: dt.datetime,
    end: dt.datetime,
) -> dict:
    params = {"site": str(site_id), "tenant": str(tenant) if tenant else None}
    site_rows = _rows(await db.execute(text(_SITE_SQL), params))
    systems = _rows(await db.execute(text(_SYSTEMS_SQL), params))
    equipment = await slot_store.load_equipment(
        db, tenant, site_id=site_id, limit=MAX_EQUIPMENT
    )
    if not site_rows and not systems and not equipment:
        # Another tenant's site and no site at all answer identically: whether a
        # site exists elsewhere is not this caller's to learn.
        raise NotFoundError("no such site in this tenant's reporting store")

    resolutions = await slot_store.resolve_equipment(db, equipment, start=start, end=end)
    metrics, outcomes = await _equipment_metrics(db, tenant, site_id, start, end)

    totals = _counts([])
    views_by_system: dict[str, list[dict]] = {}
    for e in equipment:
        eid = str(e["equipment_id"])
        needs: dict[str, list[str]] = {}
        for m in metrics:
            if m["equipment_class"] == e["equipment_class"]:
                for name in m["slots"]:
                    needs.setdefault(name, []).append(m["metric"])
        slots = [
            slot_view(s, resolutions[(eid, s["slot"])], required_by=needs.get(s["slot"]))
            for s in e["slots"]
        ]
        stated = {s["slot"] for s in e["slots"]}
        slots += [
            slot_view(
                {"slot": name}, slot_store.resolve({"slot": name}, None),
                declared=False, required_by=needs[name],
            )
            for name in sorted(needs) if name not in stated
        ]
        states = [s["readiness"] for s in slots]
        for state in states:
            totals[state] += 1
        views_by_system.setdefault(str(e["system_id"]), []).append({
            "equipment_id": eid,
            "tag": e["tag"],
            "name": e.get("name"),
            "equipment_class": e["equipment_class"],
            "system_id": str(e["system_id"]),
            # What feeds it — the power chain's edges, drawn as a single-line.
            "fed_by_id": str(e["fed_by_id"]) if e.get("fed_by_id") else None,
            "design": e["design"],
            "design_units": e["design_units"],
            "readiness": slot_store.rollup(states),
            "readiness_counts": _counts(states),
            "slots": slots,
            "metrics": outcomes.get(eid, {}),
        })

    system_views = []
    for sy in systems:
        members = views_by_system.pop(str(sy["system_id"]), [])
        system_views.append({
            "system_id": str(sy["system_id"]),
            "name": sy["name"],
            "kind": sy["kind"],
            "description": sy.get("description"),
            "readiness": slot_store.rollup(m["readiness"] for m in members),
            "equipment": members,
        })
    # Equipment whose system this mirror has never heard of. Core states the
    # system on every equipment event, so this should stay empty — and if it
    # does not, the machines are listed rather than silently left off the drawing.
    orphans = [m for members in views_by_system.values() for m in members]

    return {
        "site_id": str(site_id),
        "site_name": site_rows[0]["site_name"] if site_rows else None,
        "window": {"start": start, "end": end},
        "readiness_states": list(slot_store.READINESS),
        "totals": totals,
        "metrics": metrics,
        "systems": system_views,
        "unassigned_equipment": orphans,
    }
