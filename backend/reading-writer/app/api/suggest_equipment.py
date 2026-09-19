"""WHAT EACH DEVICE IS — suggested from its tags, decided by a person.

`GET /bi/sites/{site_id}/equipment/suggestions` reads every device placed in a
building, and for each one proposes what the equipment registry would need:
the CLASS of machine (chiller, energy meter, UPS…), which of its points goes in
which SLOT, and — for the power chain — what probably FEEDS it. It writes
nothing. The console shows the proposal on the plant drawing; a person saves
it through core, which is the registry's only writer and validates every word.

WHY FROM THE TAGS. The estate's tags follow conventions: a chiller's water in
and out end in `IWT` and `OWT`, a meter's power in `TOT KW` or `TOTKW_kw`, a
UPS's battery is `Batt_Cap_Rem`. Those are good enough to propose from and
never good enough to decide with — `4F-5F UPS DB` is a distribution board, not
a UPS — so every proposal is shown with the values it read and asked.

WHAT IT REFUSES TO GUESS, and says so instead:

  * a class for a device whose tags match nothing (`class: null`);
  * a feeder when more than one could be it — the candidates are listed, the
    choice is the person's;
  * a slot's point when several generations of the same sensor exist: the one
    that reported most recently is proposed and the others are COUNTED, so a
    person can see there was a choice.

AND IT CHECKS what it proposes, on the readings: a power reading of 2,312 kW on
a chiller that is switched off, a device whose every value is zero, a point
tagged for machine 2 inside machine 1. A check is a WARNING beside the slot —
never a silent substitution.

Fragments — a device with one or two points left behind by a gateway rebuild —
are reported as NOT MACHINES so they are kept off the drawing, not proposed.
"""

from __future__ import annotations

import datetime as dt
import re
import uuid
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .queries import LIVE_POINT, RETIRE_AFTER_DAYS, _rows

# ── the conventions ──────────────────────────────────────────────────────────


def norm(tag: str | None) -> str:
    """Lower case, every run of space / underscore / hyphen collapsed to one `_`."""
    return re.sub(r"[\s_\-]+", "_", (tag or "").strip().lower())


#: Each slot, and the tag shapes that fill it, most specific first. Matched
#: against the NORMALISED tag. Order matters inside a slot: the first pattern a
#: point matches is its score, so `total_kw` outranks a bare `kw`.
SLOT_PATTERNS: dict[str, tuple[str, ...]] = {
    "chwr": (r"(^|_)iwt$",),
    "chws": (r"(^|_)owt$",),
    "kw": (
        r"(^|_)total_kw$", r"(^|_)tot_kw$", r"(^|_)totkw(_kw)?$", r"(^|_)em_kw$",
        r"^kw_kw$", r"(^|_)em_total_kw$",
    ),
    "kwh": (r"(^|_)kwh(_kwh)?$", r"(^|_)em_kwh$"),
    "load": (r"(^|_)sys_?load$", r"(^|_)system_?load$", r"^load$"),
    "run_status": (r"(^|_)on_?off(_sts)?$",),
    "battery": (r"(^|_)batt_cap_rem$",),
    "flow_rate": (r"(^|_)flow_rate$",),
    "flow_total": (r"(^|_)cum_flow$",),
}

#: A point that fills one slot must not be offered for another: an energy
#: register is not power, a DC reading is not the AC output, and "this month's
#: kWh" is not the lifetime register.
_NEVER = re.compile(r"(^|_)(dc|kvah|this|last|yest|today|month|year|inheritance)(_|$)")

#: Each class, how it is recognised, and which slots it may carry — kept to the
#: slots core's vocabulary allows, since core refuses any other.
@dataclass(frozen=True)
class ClassRule:
    key: str
    system_kind: str
    slots: tuple[str, ...]


CLASSES: dict[str, ClassRule] = {
    "chiller": ClassRule("chiller", "chw_plant", ("chws", "chwr", "kw", "kwh", "load", "run_status")),
    "energy_meter": ClassRule("energy_meter", "power", ("kw", "kwh")),
    "pv_inverter": ClassRule("pv_inverter", "power", ("kw", "kwh", "run_status")),
    "ups": ClassRule("ups", "power", ("kw", "load", "battery", "run_status")),
    "tfa": ClassRule("tfa", "air_handling", ("kw", "kwh", "run_status")),
    "ahu": ClassRule("ahu", "air_handling", ("kw", "kwh", "run_status")),
    "water_pump": ClassRule("water_pump", "water", ("kw", "kwh", "run_status")),
    "flow_meter": ClassRule("flow_meter", "water", ("flow_rate", "flow_total")),
}


def classify(device_tag: str, point_tags: list[str]) -> tuple[str | None, str]:
    """(class key or None, the sentence saying why). Name first, then shape.

    The NAME decides where it is unambiguous — "Sump Pump", "TFA Unit",
    "Solar_Panel" — because those devices are metered like any other load and
    their points alone would call them energy meters. Where the name says
    nothing, the SHAPE of the points decides.
    """
    name = norm(device_tag)
    tags = {norm(t) for t in point_tags}

    def has(slot: str) -> bool:
        return any(_slot_score(slot, t) is not None for t in tags)

    if re.search(r"(^|_)ups\d*(_|$)", name) and not re.search(r"(^|_)db(_|$)", name):
        return "ups", "named a UPS"
    if re.search(r"solar|(^|_)pv(_|$)|inverter", name):
        return "pv_inverter", "named a solar panel / inverter"
    if re.search(r"(^|_)tfa(_|$)", name):
        return "tfa", "named a TFA unit"
    if re.search(r"(^|_)ahu\d*(_|$)", name):
        return "ahu", "named an AHU"
    if re.search(r"pump", name):
        return "water_pump", "named a pump"
    if has("flow_rate") or has("flow_total"):
        return "flow_meter", "sends a flow rate / cumulative flow"
    if has("chwr") and has("chws"):
        return "chiller", "sends water in (IWT) and water out (OWT)"
    if has("kw") or has("kwh"):
        return "energy_meter", "sends power and energy (kW, kWh)"
    return None, "its values match no machine this platform knows"


def _slot_score(slot: str, ntag: str) -> int | None:
    """How well a normalised tag fills a slot — lower is better; None = not at all."""
    if slot in ("kw", "kwh") and _NEVER.search(ntag):
        return None
    for i, pat in enumerate(SLOT_PATTERNS.get(slot, ())):
        if re.search(pat, ntag):
            return i
    return None


# ── a device's evidence ──────────────────────────────────────────────────────


@dataclass
class Pt:
    point_id: uuid.UUID
    point_tag: str
    value: float | None
    at: dt.datetime | None


def pick_slots(rule: ClassRule, points: list[Pt]) -> list[dict]:
    """For each slot the class carries, the point that fills it best.

    Several generations of one sensor (`IWT`, `1FYC1_IWT`, `1FYorkChiller1_IWT`)
    match equally well; the one that READ most recently is proposed, and the
    rest are counted in `alternatives` so the choice is visible.
    """
    out: list[dict] = []
    used: set[uuid.UUID] = set()
    for slot in rule.slots:
        cands = []
        for p in points:
            if p.point_id in used:
                continue
            s = _slot_score(slot, norm(p.point_tag))
            if s is not None:
                cands.append((s, p))
        if not cands:
            continue
        best_score = min(s for s, _ in cands)
        tied = [p for s, p in cands if s == best_score]
        epoch = dt.datetime.min.replace(tzinfo=dt.timezone.utc)
        tied.sort(key=lambda p: (p.at or epoch, len(p.point_tag)), reverse=True)
        chosen = tied[0]
        used.add(chosen.point_id)
        out.append({
            "slot": slot,
            "point_tag": chosen.point_tag,
            "value": chosen.value,
            "at": chosen.at,
            "alternatives": len(cands) - 1,
            "warning": None,
        })
    return out


_MACHINE_NO = re.compile(r"(?:yc|kc|chiller|ch)_?(\d)(?:_|$)")


def check(device_tag: str, slots: list[dict], values: list[float | None]) -> list[str]:
    """Warnings about what is proposed, from the readings. Also fills the
    per-slot `warning` where the doubt is about one slot."""
    warnings: list[str] = []
    by_slot = {s["slot"]: s for s in slots}

    known = [v for v in values if v is not None]
    if known and all(v == 0 for v in known):
        warnings.append("every value it sends is zero")

    run = by_slot.get("run_status")
    kw = by_slot.get("kw")
    load = by_slot.get("load")
    if run and kw and run["value"] == 0 and (kw["value"] or 0) > 100:
        kw["warning"] = (
            f"reads {kw['value']:,.0f} kW while the machine is off — this looks like "
            "an energy counter, not power"
        )
    if run and load and run["value"] == 0 and (load["value"] or 0) > 50:
        load["warning"] = f"reads {load['value']:,.0f}% load while the machine is off"

    # A point tagged for another machine than the device carries it.
    dev_no = re.search(r"(\d+)\s*$", device_tag or "")
    if dev_no:
        want = str(int(dev_no.group(1)))
        for s in slots:
            m = _MACHINE_NO.search(norm(s["point_tag"]))
            if m and m.group(1) != want and s["warning"] is None:
                s["warning"] = f"the tag names machine {m.group(1)}, on a device numbered {want}"
    return warnings


# ── the power chain: what probably feeds what ────────────────────────────────


def _floor(tag: str) -> str | None:
    """The floor prefix a name starts with: `4F`, `B1`, `B2`."""
    m = re.match(r"\s*(b\d|\d+f)", (tag or "").lower())
    return m.group(1) if m else None


def _tier(tag: str) -> int:
    """0 main incomer · 1 incomer · 2 sub-incomer · 3 everything else."""
    n = norm(tag)
    if "main" in n and "incomer" in n:
        return 0
    if "sub_incomer" in n or "subincomer" in n:
        return 2
    if "incomer" in n:
        return 1
    return 3


def feeders(power: list[str]) -> dict[str, dict]:
    """device_tag -> {suggested, candidates, reason} for every power device.

    A device's feeder is proposed from the tier ABOVE it on the same floor
    prefix (a main incomer feeds incomers, incomers feed sub-incomers, a floor's
    sub-incomers feed that floor's boards). One candidate is a suggestion; more
    than one is a SHORTLIST and the person picks; none is said.
    """
    out: dict[str, dict] = {}
    for tag in power:
        tier = _tier(tag)
        if tier == 0:
            out[tag] = {"suggested": None, "candidates": [], "reason": "the main incomer is fed by the grid"}
            continue
        floor = _floor(tag)
        found: list[str] = []
        for above in range(tier - 1, -1, -1):
            pool = [t for t in power if t != tag and _tier(t) == above]
            if above > 0 and floor:
                pool = [t for t in pool if _floor(t) == floor]
            if pool:
                found = sorted(pool)
                break
        if len(found) == 1:
            out[tag] = {"suggested": found[0], "candidates": found,
                        "reason": "the only feeder above it" + (f" on {floor.upper()}" if floor else "")}
        elif found:
            out[tag] = {"suggested": None, "candidates": found,
                        "reason": f"{len(found)} could feed it — choose one"}
        else:
            out[tag] = {"suggested": None, "candidates": [], "reason": "nothing above it to suggest"}
    return out


# ── the reads ────────────────────────────────────────────────────────────────

_POINTS_SQL = f"""
    SELECT p.point_id, p.device_tag, p.point_tag, p.last_seen_at
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND p.site_id = CAST(:site AS uuid)
       AND p.device_tag IS NOT NULL AND p.point_tag IS NOT NULL
       AND p.type = 'num'
       AND {LIVE_POINT}
"""

_VALUES_SQL = """
    SELECT DISTINCT ON (r.point_id) r.point_id, r.bucket AS at, r.num_last AS value
      FROM readings_1h r
     WHERE r.point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
       AND r.bucket >= now() - make_interval(days => 30)
       AND r.num_last IS NOT NULL
     ORDER BY r.point_id, r.bucket DESC
"""

#: Devices in NO building. They cannot be registered here until they are placed,
#: and a screen that did not say so would look like an estate with less in it.
_UNPLACED_SQL = f"""
    SELECT count(DISTINCT p.device_tag) AS n
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND p.site_id IS NULL
       AND p.device_tag IS NOT NULL
       AND {LIVE_POINT}
"""

#: Devices already in the registry: any slot of this site bound to the device.
_REGISTERED_SQL = """
    SELECT s.device_tag, e.tag AS equipment_tag, e.equipment_id
      FROM equipment_point_slots s
      JOIN site_equipment e ON e.tenant_id = s.tenant_id AND e.equipment_id = s.equipment_id
     WHERE (CAST(:tenant AS uuid) IS NULL OR s.tenant_id = CAST(:tenant AS uuid))
       AND e.site_id = CAST(:site AS uuid)
       AND s.device_tag IS NOT NULL
"""

#: A device this small, all of it quiet or nearly so, is the leftover of a
#: rebuild rather than a machine.
FRAGMENT_POINTS = 2
QUIET_AFTER = dt.timedelta(days=1)


async def suggestions(db: AsyncSession, tenant: uuid.UUID | None, site_id: uuid.UUID) -> dict:
    params = {"tenant": str(tenant) if tenant else None, "site": str(site_id),
              "retire_days": RETIRE_AFTER_DAYS}
    rows = _rows(await db.execute(text(_POINTS_SQL), params))
    values = {
        r["point_id"]: r
        for r in _rows(await db.execute(text(_VALUES_SQL), {
            "pids": [str(r["point_id"]) for r in rows], "tenant": params["tenant"]}))
    } if rows else {}
    registered: dict[str, dict] = {}
    for r in _rows(await db.execute(text(_REGISTERED_SQL), params)):
        registered.setdefault(r["device_tag"], {"equipment_tag": r["equipment_tag"],
                                                "equipment_id": str(r["equipment_id"])})

    by_device: dict[str, list[Pt]] = {}
    seen_at: dict[str, dt.datetime | None] = {}
    for r in rows:
        v = values.get(r["point_id"]) or {}
        by_device.setdefault(r["device_tag"], []).append(
            Pt(r["point_id"], r["point_tag"], v.get("value"), v.get("at")))
        last = r.get("last_seen_at")
        if last and (seen_at.get(r["device_tag"]) is None or last > seen_at[r["device_tag"]]):
            seen_at[r["device_tag"]] = last
    newest = max((t for t in seen_at.values() if t), default=None)

    unplaced = (await db.execute(text(_UNPLACED_SQL), params)).scalar() or 0
    out = assemble(by_device, seen_at, newest, registered)
    out["totals"]["unplaced_elsewhere"] = int(unplaced)
    return out


def assemble(
    by_device: dict[str, list[Pt]],
    seen_at: dict[str, dt.datetime | None],
    newest: dt.datetime | None,
    registered: dict[str, dict],
) -> dict:
    """The pure part: every device, what it is, and what goes where."""
    devices: list[dict] = []
    for tag in sorted(by_device):
        pts = by_device[tag]
        last = seen_at.get(tag)
        quiet = bool(newest and last and newest - last > QUIET_AFTER)
        fragment = len(pts) <= FRAGMENT_POINTS and (quiet or norm(tag) == "gateway")
        if norm(tag) == "gateway":
            fragment = True
        cls, why = classify(tag, [p.point_tag for p in pts])
        rule = CLASSES.get(cls or "")
        slots = pick_slots(rule, pts) if rule and not fragment else []
        warnings = check(tag, slots, [p.value for p in pts]) if not fragment else []
        devices.append({
            "device_tag": tag,
            "points": len(pts),
            "last_seen_at": last,
            "quiet": quiet,
            "fragment": fragment,
            "equipment_class": None if fragment else cls,
            "system_kind": rule.system_kind if rule and not fragment else None,
            "why": "a leftover of an old copy, not a machine" if fragment else why,
            "slots": slots,
            "warnings": warnings,
            "registered": registered.get(tag),
            "feeder": None,
        })

    power = [d["device_tag"] for d in devices
             if d["system_kind"] == "power" and d["equipment_class"] == "energy_meter"]
    chain = feeders(power)
    for d in devices:
        if d["device_tag"] in chain:
            d["feeder"] = chain[d["device_tag"]]

    return {
        "devices": devices,
        "totals": {
            "devices": len(devices),
            "machines": sum(1 for d in devices if not d["fragment"] and d["equipment_class"]),
            "unknown": sum(1 for d in devices if not d["fragment"] and not d["equipment_class"]),
            "fragments": sum(1 for d in devices if d["fragment"]),
            "registered": sum(1 for d in devices if d["registered"]),
        },
    }
