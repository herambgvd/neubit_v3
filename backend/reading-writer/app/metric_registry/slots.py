"""Equipment slots — which point a slot MEANS, decided over a window of readings.

WHAT A SLOT IS, AND WHAT IT IS NOT
----------------------------------
Core's equipment registry binds a slot (`chws` on CH-01) to a point by the
gateway's TAGS — `device_tag` + `point_tag` — and deliberately not by
`points.point_id`, because the id is minted per gateway connection and every
rebuild mints a new one (core's `infrastructure/models.py` tells the 11 Sept
story). The tags are the durable name. The price, which core states in its own
event contract, is that a tag pair is NOT guaranteed to name one row here: on
this deployment 45 pairs have two `retired_at IS NULL` generations right now,
both of them silent since 11 Sept.

So resolving a slot to a point is a decision with more than one honest outcome,
and a resolver that returned `candidates[0]` would be inventing: it would pick a
generation by row order and average it without ever checking that it is the one
still reporting. This module makes the decision once, for every caller.

THE RULE
--------
Candidates are the points of the SAME TENANT as the equipment with exactly that
tag pair and `retired_at IS NULL`. Retirement is kept as the one coarse filter
because an operator (or the ghost collapse, `/bi/points/ghosts`) saying "this is
gone" is a statement, not a silence. Then, over the WINDOW being asked about:

    no tags on the slot              → UNBOUND     nobody has said which point
    tags, no candidate               → UNRESOLVED  the pair names nothing here
    exactly one candidate REPORTED   → REPORTING   resolved — to that one, even
      in the window                                when silent generations of it
                                                   exist beside it (they are the
                                                   ghosts, and ride back as such)
    more than one reported           → AMBIGUOUS   two live meters, one name
    none reported, one candidate     → SILENT      resolved; the sensor stopped
    none reported, several           → AMBIGUOUS   which generation IS the meter
                                                   cannot be read off silence

"Reported in the window" means a row in `readings` with `ts` inside [start, end)
— NOT `LIVE_POINT`. `LIVE_POINT` is "not retired and seen within 30 days", which
is a statement about the dimension row; `app/api/correlations.py` records what it
cost to read it as "reporting" (chiller ΔT marked satisfied off two sensors that
had produced nothing for eight days). The window is always a parameter, never a
default, because a slot silent over the last hour and reporting over the last
week are two true answers to two questions.

WHY IT LIVES HERE, AND ONLY HERE
--------------------------------
Three alternatives, each refused:

* **Core** cannot do it: it would have to read `points`, and the cross-service
  read ban (contract §1) exists so that it never does.
* **The mirror** (`equipment_sync`) must not do it: resolving at event time and
  storing a point id would freeze a guess made on the day a slot was bound. The
  ghost generation that appears after the next rebuild would never be noticed,
  which is the 11 Sept failure again, one layer down.
* **Each caller** must not do it: the metric evaluator and the plant endpoint
  (`GET /bi/sites/{id}/plant`) both need the answer, and two resolvers are two
  answers — a schematic showing CH-01's chws as reporting beside a ΔT refused as
  ambiguous would be both correct and useless.

So resolution is read-time, in reading-writer (the only service that may read
`points` AND the mirror), in one function both paths call with the same window.

THE READINESS STATES ARE THE PRODUCT
------------------------------------
The L3 plant schematic colours equipment by DATA READINESS, not by equipment
health, so `READINESS` is a closed set a screen can switch on and it is ordered
worst-first: a piece of equipment rolls up to the first state in this order that
any of its slots is in (`rollup`). Growing the set is a code change on purpose.
"""

from __future__ import annotations

import datetime as dt
import math
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .units import Qty


def _rows(result) -> list[dict]:
    # `api.queries._rows`, restated: importing it would pull in the `app.api`
    # package, whose router imports the evaluator that imports THIS module —
    # a cycle for whichever of the two a caller happens to import first.
    return [dict(r) for r in result.mappings().all()]

# ── readiness ────────────────────────────────────────────────────────────────

AMBIGUOUS = "ambiguous"
UNRESOLVED = "unresolved"
SILENT = "silent"
UNBOUND = "unbound"
REPORTING = "reporting"

#: Worst first. `ambiguous` and `unresolved` lead because each is a binding that
#: names the wrong number of points — a configuration fault a human must fix
#: before anything can be read. `silent` is a sensor that stopped; `unbound` is a
#: slot nobody has filled in yet, which is normal on a new registry.
READINESS: tuple[str, ...] = (AMBIGUOUS, UNRESOLVED, SILENT, UNBOUND, REPORTING)


def rollup(states) -> str:
    """The least-ready state present — what a piece of equipment is coloured by.

    Equipment with no slots at all is UNBOUND: nothing about it can be read, and
    showing it green because no slot is red would be the opposite of the truth.
    """
    present = set(states)
    for state in READINESS:
        if state in present:
            return state
    return UNBOUND


# ── vocabulary ───────────────────────────────────────────────────────────────
#
# Mirrors of core's `infrastructure/vocabulary.py`, cut down to what the metric
# registry needs to TYPE-CHECK a definition: what dimension a slot's point
# measures, and what quantity a design fact is. Core stays the authority on
# which slots and facts a class may carry — the mirror only ever holds what core
# validated, so a definition naming a slot a class cannot have type-checks here
# and refuses `slot_unbound` at evaluation, with the slot named.
#
# `dimension` is THIS service's dimension table (`units.py`), not core's word:
# core's `percent` is a dimensionless ratio here, with the unit `%` confirmed on
# the point. A slot with no dimension (a state, a pressure, a CO2 reading) is not
# a quantity the algebra can compose, and a definition may not name it as an
# input — it is still resolved and drawn on the schematic.

SLOT_DEFS: dict[str, dict] = {
    "chws": {"dimension": "temperature", "label": "CHW supply (leaving) temperature"},
    "chwr": {"dimension": "temperature", "label": "CHW return (entering) temperature"},
    "cws": {"dimension": "temperature", "label": "Condenser water supply temperature"},
    "cwr": {"dimension": "temperature", "label": "Condenser water return temperature"},
    "kw": {"dimension": "power", "label": "Active power"},
    "kwh": {"dimension": "energy", "label": "Lifetime energy register"},
    "load": {"dimension": "dimensionless", "label": "Load"},
    "run_status": {"dimension": None, "label": "Run status"},
    "trip": {"dimension": None, "label": "Trip / common fault"},
    "speed": {"dimension": "dimensionless", "label": "VFD speed"},
    "dp": {"dimension": None, "label": "Differential pressure"},
    "sat": {"dimension": "temperature", "label": "Supply air temperature"},
    "rat": {"dimension": "temperature", "label": "Return air temperature"},
    "chw_valve": {"dimension": "dimensionless", "label": "CHW valve position"},
    "filter_dp": {"dimension": None, "label": "Filter differential pressure"},
    "duct_static": {"dimension": None, "label": "Duct static pressure"},
    "co2": {"dimension": None, "label": "CO2"},
    "room_temp": {"dimension": "temperature", "label": "Room temperature"},
    "room_temp_setpoint": {"dimension": "temperature", "label": "Room temperature setpoint"},
    "fuel_level": {"dimension": "dimensionless", "label": "Fuel level"},
}

#: Core's equipment classes, by name only — which slots and facts each may carry
#: is core's to enforce, and it does, before anything reaches the mirror.
EQUIPMENT_CLASSES: tuple[str, ...] = (
    "chiller", "cooling_tower", "chw_primary_pump", "chw_secondary_pump",
    "condenser_pump", "chw_header", "ahu", "tfa", "fcu", "energy_meter", "dg_set",
    "pv_inverter", "water_pump",
)

#: Numeric design facts, each as the QUANTITY it is. The unit is the one core
#: stores the number in and publishes in `design_units`; the evaluator refuses a
#: fact whose published unit is not this one rather than reading it as this one.
#: The ΔT band is a temperature DIFFERENCE in K — `Qty("temperature", "K")` would
#: be an absolute kelvin reading, which a band is not.
EQUIPMENT_FACT_DEFS: dict[str, dict] = {
    "tr": {"qty": Qty("refrigeration", "TR"),
           "label": "Rated capacity (refrigeration tons)"},
    "kw_rated": {"qty": Qty("power", "kW"), "label": "Rated power"},
    "kva_rated": {"qty": Qty("apparent_power", "kVA"), "label": "Rated apparent power"},
    "design_dt_min": {"qty": Qty("temperature_delta", "K"),
                      "label": "Design CHW ΔT, lower bound"},
    "design_dt_max": {"qty": Qty("temperature_delta", "K"),
                      "label": "Design CHW ΔT, upper bound"},
}

#: Where an operator fixes any of this. Printed in every refusal that sends
#: someone to the registry.
RECORDED_AT = "Building Intelligence → Setup → Equipment"


def fact_value(design: dict, fact: str) -> float | None:
    """A stated numeric fact, or None. A bool is not a capacity; NaN is not a band."""
    v = (design or {}).get(fact)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v) if math.isfinite(v) else None


# ── the equipment, from the mirror ───────────────────────────────────────────

_EQUIPMENT_SQL = """
    SELECT e.tenant_id, e.equipment_id, e.site_id, e.system_id, e.tag, e.name,
           e.equipment_class, e.design, e.design_units
      FROM site_equipment e
     WHERE (CAST(:tenant AS uuid) IS NULL OR e.tenant_id = CAST(:tenant AS uuid))
       AND (CAST(:site AS uuid) IS NULL OR e.site_id = CAST(:site AS uuid))
       AND (CAST(:equipment AS uuid) IS NULL OR e.equipment_id = CAST(:equipment AS uuid))
       AND (CAST(:cls AS varchar) IS NULL OR e.equipment_class = CAST(:cls AS varchar))
     ORDER BY e.tag
     LIMIT :limit
"""

_SLOTS_SQL = """
    SELECT s.tenant_id, s.equipment_id, s.slot, s.device_tag, s.point_tag
      FROM equipment_point_slots s
     WHERE s.tenant_id = ANY(CAST(:tenants AS uuid[]))
       AND s.equipment_id = ANY(CAST(:equipment AS uuid[]))
     ORDER BY s.slot
"""


async def load_equipment(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    site_id=None,
    equipment_id=None,
    equipment_class: str | None = None,
    limit: int = 200,
) -> list[dict]:
    """The mirrored equipment in scope, each with its `slots` list attached.

    Two queries whatever the size of the site. Slots are fetched by (tenant,
    equipment) pairs taken from the equipment rows themselves, so a platform
    caller (tenant None) still never pairs one tenant's equipment with another
    tenant's slot rows.
    """
    rows = _rows(
        await db.execute(
            text(_EQUIPMENT_SQL),
            {
                "tenant": str(tenant) if tenant else None,
                "site": str(site_id) if site_id else None,
                "equipment": str(equipment_id) if equipment_id else None,
                "cls": equipment_class,
                "limit": limit,
            },
        )
    )
    if not rows:
        return []
    slot_rows = _rows(
        await db.execute(
            text(_SLOTS_SQL),
            {
                "tenants": sorted({str(r["tenant_id"]) for r in rows}),
                "equipment": [str(r["equipment_id"]) for r in rows],
            },
        )
    )
    by_key: dict[tuple[str, str], list[dict]] = {}
    for s in slot_rows:
        by_key.setdefault((str(s["tenant_id"]), str(s["equipment_id"])), []).append(s)
    out = []
    for r in rows:
        e = dict(r)
        e["design"] = dict(r.get("design") or {})
        e["design_units"] = dict(r.get("design_units") or {})
        e["slots"] = by_key.get((str(r["tenant_id"]), str(r["equipment_id"])), [])
        out.append(e)
    return out


# ── resolution ───────────────────────────────────────────────────────────────

# One statement for every binding in scope. The LATERAL is an index seek on
# `readings (point_id, ts)` and a backward scan that stops at the first row, so
# the freshest reading in the window costs the same as knowing there was one —
# and the plant endpoint needs both. Tenant is joined from the BINDING, not from
# the caller, for the reason `load_equipment` gives.
_CANDIDATES_SQL = """
    WITH wanted(tenant_id, device_tag, point_tag) AS (
        SELECT DISTINCT * FROM unnest(
            CAST(:tenants AS uuid[]),
            CAST(:device_tags AS text[]),
            CAST(:point_tags AS text[])
        )
    )
    SELECT w.tenant_id AS want_tenant, w.device_tag AS want_device_tag,
           w.point_tag AS want_point_tag,
           p.point_id, p.point_tag, p.device_id, p.device_tag, p.unit,
           p.unit_source, p.last_seen_at,
           lr.ts AS last_in_window, lr.num AS last_num, lr.txt AS last_txt
      FROM wanted w
      JOIN points p
        ON p.tenant_id = w.tenant_id
       AND p.device_tag = w.device_tag
       AND p.point_tag = w.point_tag
      LEFT JOIN LATERAL (
          SELECT rd.ts, rd.num, rd.txt
            FROM readings rd
           WHERE rd.point_id = p.point_id
             AND rd.tenant_id = p.tenant_id
             AND rd.ts >= :start
             AND rd.ts < :end
           ORDER BY rd.ts DESC
           LIMIT 1
      ) lr ON TRUE
     WHERE p.retired_at IS NULL
     ORDER BY p.last_seen_at DESC
"""


def binding_key(tenant_id, device_tag, point_tag) -> tuple[str, str, str]:
    return (str(tenant_id), device_tag, point_tag)


async def fetch_candidates(
    db: AsyncSession, slots: list[dict], *, start: dt.datetime, end: dt.datetime
) -> dict[tuple[str, str, str], list[dict]]:
    """Every non-retired point each BOUND slot's tag pair names, with whether —
    and what — it reported inside [start, end). An empty list is a real answer."""
    bound = [s for s in slots if s.get("device_tag") and s.get("point_tag")]
    if not bound:
        return {}
    rows = _rows(
        await db.execute(
            text(_CANDIDATES_SQL),
            {
                "tenants": [str(s["tenant_id"]) for s in bound],
                "device_tags": [s["device_tag"] for s in bound],
                "point_tags": [s["point_tag"] for s in bound],
                "start": start,
                "end": end,
            },
        )
    )
    out: dict[tuple[str, str, str], list[dict]] = {}
    for r in rows:
        key = binding_key(r["want_tenant"], r["want_device_tag"], r["want_point_tag"])
        out.setdefault(key, []).append(r)
    return out


def _candidate_view(c: dict) -> dict:
    """A candidate as it travels on a response: enough to find it and to see
    that it is a generation, never the whole row."""
    return {
        "point_id": str(c["point_id"]),
        "point_tag": c["point_tag"],
        "device_tag": c["device_tag"],
        "reported_in_window": c.get("last_in_window") is not None,
        "last_in_window": c.get("last_in_window"),
        "last_seen_at": c.get("last_seen_at"),
    }


def resolve(slot: dict, candidates: list[dict] | None) -> dict:
    """One slot's resolution: `{readiness, point, reason, candidates, ghosts}`.

    PURE — every rule in the module docstring's table is here and nowhere else,
    reached with rows already fetched. `point` is set exactly when the slot names
    ONE point (REPORTING or SILENT); for every other state it is None and the
    `reason` says, in the operator's terms, what would make it one.
    """
    label = SLOT_DEFS.get(slot["slot"], {}).get("label", slot["slot"])
    dtag, ptag = slot.get("device_tag"), slot.get("point_tag")
    out = {"readiness": None, "point": None, "reason": None,
           "candidates": [], "ghosts": []}
    if not dtag or not ptag:
        out["readiness"] = UNBOUND
        out["reason"] = (
            f"slot `{slot['slot']}` ({label}) is not bound to a point — bind it on "
            f"the equipment in {RECORDED_AT}"
        )
        return out
    candidates = list(candidates or [])
    if not candidates:
        out["readiness"] = UNRESOLVED
        out["reason"] = (
            f"slot `{slot['slot']}` is bound to `{dtag}` / `{ptag}` and no point in "
            f"the reporting store carries that pair (retired points excluded) — "
            f"the gateway has never published it, or the tags are misspelt"
        )
        return out
    fresh = [c for c in candidates if c.get("last_in_window") is not None]
    if len(fresh) == 1:
        out["readiness"] = REPORTING
        out["point"] = fresh[0]
        # The silent generations beside the one that reports: the ghosts a
        # rebuild left behind. Shown, never averaged.
        out["ghosts"] = [_candidate_view(c) for c in candidates if c is not fresh[0]]
        return out
    if len(fresh) > 1:
        out["readiness"] = AMBIGUOUS
        out["candidates"] = [_candidate_view(c) for c in candidates]
        out["reason"] = (
            f"slot `{slot['slot']}` is bound to `{dtag}` / `{ptag}` and {len(fresh)} "
            f"points carrying that pair reported in the window — a slot names one "
            f"point and nothing here may pick between live meters; retire the "
            f"wrong one"
        )
        return out
    if len(candidates) == 1:
        out["readiness"] = SILENT
        out["point"] = candidates[0]
        out["reason"] = (
            f"slot `{slot['slot']}` → `{ptag}` produced no reading in the window — "
            f"the binding is fine and the signal stopped (last seen "
            f"{_when(candidates[0].get('last_seen_at'))})"
        )
        return out
    out["readiness"] = AMBIGUOUS
    out["candidates"] = [_candidate_view(c) for c in candidates]
    out["reason"] = (
        f"slot `{slot['slot']}` is bound to `{dtag}` / `{ptag}`, {len(candidates)} "
        f"generations of that point exist and none reported in the window — which "
        f"one IS the meter cannot be read off silence; collapse the ghosts on "
        f"/bi/points/ghosts"
    )
    return out


def _when(v) -> str:
    if isinstance(v, dt.datetime):
        return v.isoformat()
    return str(v) if v else "never"


async def resolve_equipment(
    db: AsyncSession,
    equipment: list[dict],
    *,
    start: dt.datetime,
    end: dt.datetime,
    slot_names: set[str] | None = None,
) -> dict[tuple[str, str], dict]:
    """`{(equipment_id, slot): resolution}` for every slot of every equipment
    given — or only the named slots, when a caller needs just those."""
    slots = [
        {**s, "tenant_id": e["tenant_id"]}
        for e in equipment
        for s in e["slots"]
        if slot_names is None or s["slot"] in slot_names
    ]
    candidates = await fetch_candidates(db, slots, start=start, end=end)
    return {
        (str(s["equipment_id"]), s["slot"]): resolve(
            s, candidates.get(binding_key(s["tenant_id"], s.get("device_tag"), s.get("point_tag")))
        )
        for s in slots
    }
