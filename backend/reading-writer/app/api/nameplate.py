"""The machine's own plate — the only facts BI cannot read off a sensor.

Everything else about a machine is in the estate's own traffic: what it is, which
point means what, what feeds it. Two things are not, because no sensor sends
them:

  * its RATED CAPACITY — stamped on the plate bolted to the machine;
  * its DESIGN ΔT BAND — how far the chilled water is supposed to drop.

Which facts are actually needed is not a list in this file. It is read from the
metric definitions: a metric whose input says `source: "equipment_fact"` needs
that fact, on the class it applies to, and nothing else is ever asked for. Today
that is `chiller_kw_per_tr` (tr) and `chw_delta_t_in_band` (the band); a metric
seeded tomorrow appears here without an edit, and one retired stops being asked.

The BAND is not really a question for a person at all — the answer is in the
readings. So this OBSERVES it: over the window, the hours where both water
temperatures reported and the machine was actually cooling, as the range HALF of
those hours sat in (p25–p75, the typical hours, not the start-ups and the
part-load tails). The console offers that range and a person confirms it.

A range is only worth offering when it is one: when the whole spread (p05–p95)
is wider than a design band could be, the observation is marked `wide`, and the
console says so rather than letting a number nobody could stand behind be
confirmed with one press.
An observation is never written by itself: `dry_run` is the console's, and the
write is core's (`PUT .../equipment/{id}/design`), as always.

Nothing here writes. It reads the mirror and the rollup, and says what is
missing, what was observed, and which metric stays refused until it is answered.
"""

from __future__ import annotations

import datetime as dt
import math
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..metric_registry import slots as slot_store
from .queries import _rows

#: The window the band is observed over.
DEFAULT_DAYS = 30

#: Fewer hours than this is not a range, it is a coincidence — the observation
#: is withheld and said to be withheld, rather than offered as if it were one.
MIN_HOURS = 24

#: Below this the machine is not cooling, so the hour says nothing about the
#: band it cools to.
COOLING_MIN_DT = 0.3

#: A design band is a few degrees wide. A whole spread wider than this is a
#: machine that ran every which way over the window, and the middle of it is not
#: a design statement — it is offered, and it is MARKED.
WIDE_SPREAD_K = 4.0

#: The two facts that are one answer: half a band is not a band.
BAND = ("design_dt_min", "design_dt_max")

#: The slots the band is observed from — return minus supply.
BAND_SLOTS = ("chwr", "chws")


# ── what the metrics actually need ───────────────────────────────────────────

_DEMANDS_SQL = """
    SELECT d.key, d.version, d.tenant_id,
           d.applies_to->>'equipment_class' AS cls, i.value->>'fact' AS fact
      FROM metric_definitions d
      JOIN LATERAL jsonb_each(d.inputs) i ON TRUE
     -- A platform definition (`tenant_id IS NULL`) is every tenant's, which is
     -- how the seeded metrics reach a building at all; a tenant's own row is
     -- also its own. Anyone else's is not visible here.
     WHERE i.value->>'source' = 'equipment_fact'
       AND (d.tenant_id IS NULL OR CAST(:tenant AS uuid) IS NULL
            OR d.tenant_id = CAST(:tenant AS uuid))
"""


def _effective(rows: list[dict]) -> list[dict]:
    """One definition per key: a tenant's own overrides the platform's, and the
    highest version of whichever wins. A fact an older version wanted is gone
    with it."""
    best: dict[str, tuple[int, int]] = {}
    for r in rows:
        rank = (1 if r["tenant_id"] is not None else 0, int(r["version"]))
        if rank > best.get(r["key"], (-1, -1)):
            best[r["key"]] = rank
    return [
        r for r in rows
        if (1 if r["tenant_id"] is not None else 0, int(r["version"])) == best[r["key"]]
    ]


async def demands(db: AsyncSession, tenant: uuid.UUID | None) -> dict[str, dict[str, set[str]]]:
    """`{equipment_class: {fact: {metric keys}}}` — what the EFFECTIVE metrics
    read off a plate, and nothing else."""
    rows = _rows(await db.execute(text(_DEMANDS_SQL), {"tenant": str(tenant) if tenant else None}))
    out: dict[str, dict[str, set[str]]] = {}
    for r in _effective(rows):
        cls, fact = r["cls"], r["fact"]
        if not cls or fact not in slot_store.EQUIPMENT_FACT_DEFS:
            continue
        out.setdefault(cls, {}).setdefault(fact, set()).add(r["key"])
    return out


# ── what the readings say the band is ────────────────────────────────────────

_OBSERVED_SQL = """
    WITH pair AS (
        SELECT * FROM unnest(CAST(:eq AS text[]), CAST(:ret AS uuid[]), CAST(:sup AS uuid[]))
                        AS t(eq, ret_id, sup_id)
    ),
    hours AS (
        SELECT p.eq, (r.num_avg - s.num_avg) AS dt
          FROM pair p
          JOIN readings_1h r ON r.point_id = p.ret_id AND r.bucket >= :start AND r.num_avg IS NOT NULL
          JOIN readings_1h s ON s.point_id = p.sup_id AND s.bucket = r.bucket AND s.num_avg IS NOT NULL
    )
    SELECT eq,
           count(*)                                              AS hours,
           -- The typical hours: half of them sat between these two.
           percentile_cont(0.25) WITHIN GROUP (ORDER BY dt)       AS low,
           percentile_cont(0.50) WITHIN GROUP (ORDER BY dt)       AS mid,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY dt)       AS high,
           -- The whole spread, to say whether the middle means anything.
           percentile_cont(0.05) WITHIN GROUP (ORDER BY dt)       AS spread_low,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY dt)       AS spread_high
      FROM hours
     WHERE dt >= :min_dt
     GROUP BY eq
"""


def _step(v: float, *, up: bool) -> float:
    """To a tenth of a degree — an offered band is a round number, and rounding
    OUTWARDS never narrows what the readings showed."""
    f = math.ceil(v * 10) if up else math.floor(v * 10)
    return round(f / 10, 1)


def observation(row: dict | None, *, days: int) -> dict | None:
    """The offered band, or None when there is not enough of it to offer."""
    if not row or int(row["hours"]) < MIN_HOURS:
        return None
    low, high = float(row["low"]), float(row["high"])
    if not (math.isfinite(low) and math.isfinite(high)):
        return None
    lo, hi = _step(low, up=False), _step(high, up=True)
    if hi <= lo:  # a flat reading is not a band
        hi = round(lo + 0.1, 1)
    spread = float(row["spread_high"]) - float(row["spread_low"])
    return {
        "low": lo,
        "high": hi,
        "median": round(float(row["mid"]), 1),
        "hours": int(row["hours"]),
        "days": days,
        # True: the machine ran all over the place in the window, so this middle
        # is where it USUALLY sat, not a design band anybody should stand behind.
        "wide": spread > WIDE_SPREAD_K,
        "spread": [_step(float(row["spread_low"]), up=False), _step(float(row["spread_high"]), up=True)],
    }


async def observed_bands(
    db: AsyncSession,
    equipment: list[dict],
    resolutions: dict[tuple[str, str], dict],
    *,
    days: int,
) -> dict[str, dict]:
    """`{equipment_id: row}` from the rollup, for the machines whose BOTH water
    temperatures resolved to a point. A machine missing either is not observed —
    a ΔT needs two ends."""
    eq, ret, sup = [], [], []
    for e in equipment:
        key = str(e["equipment_id"])
        r = (resolutions.get((key, "chwr")) or {}).get("point")
        s = (resolutions.get((key, "chws")) or {}).get("point")
        if not r or not s:
            continue
        eq.append(key)
        ret.append(str(r["point_id"]))
        sup.append(str(s["point_id"]))
    if not eq:
        return {}
    rows = _rows(
        await db.execute(
            text(_OBSERVED_SQL),
            {
                "eq": eq,
                "ret": ret,
                "sup": sup,
                "start": dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days),
                "min_dt": COOLING_MIN_DT,
            },
        )
    )
    return {r["eq"]: dict(r) for r in rows}


# ── one machine's questions ──────────────────────────────────────────────────


def questions_of(
    e: dict,
    wanted: dict[str, set[str]],
    observed: dict | None,
    *,
    days: int,
) -> list[dict]:
    """What is still missing on this machine — nothing when every fact its
    metrics need is on file."""
    design = e.get("design") or {}
    out: list[dict] = []

    band_wanted = [f for f in BAND if f in wanted]
    if band_wanted:
        have = {f: slot_store.fact_value(design, f) for f in BAND}
        # Half a band on file is still a question: the metric refuses on it.
        if any(have[f] is None for f in BAND):
            out.append(
                {
                    "kind": "band",
                    "facts": list(BAND),
                    "unit": "K",
                    "value": None,
                    "observed": observation(observed, days=days) if observed is not None else None,
                    "blocks": sorted({m for f in band_wanted for m in wanted[f]}),
                }
            )

    for fact, metrics in sorted(wanted.items()):
        if fact in BAND or slot_store.fact_value(design, fact) is not None:
            continue
        out.append(
            {
                "kind": "capacity" if fact == "tr" else "number",
                "facts": [fact],
                "unit": slot_store.EQUIPMENT_FACT_DEFS[fact]["qty"].unit,
                "label": slot_store.EQUIPMENT_FACT_DEFS[fact]["label"],
                "value": None,
                "observed": None,
                "blocks": sorted(metrics),
            }
        )
    return out


async def nameplate(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    site_id: uuid.UUID,
    *,
    days: int = DEFAULT_DAYS,
) -> dict:
    """Every saved machine in this building that is still missing a plate fact,
    with the band its own readings show. Writes nothing."""
    equipment = await slot_store.load_equipment(db, tenant, site_id=site_id, limit=500)
    wanted = await demands(db, tenant)
    asked_classes = {e["equipment_class"] for e in equipment} & set(wanted)

    of_interest = [e for e in equipment if e["equipment_class"] in asked_classes]
    bands: dict[str, dict] = {}
    if of_interest:
        end = dt.datetime.now(dt.timezone.utc)
        resolutions = await slot_store.resolve_equipment(
            db, of_interest, start=end - dt.timedelta(days=days), end=end, slot_names=set(BAND_SLOTS)
        )
        bands = await observed_bands(db, of_interest, resolutions, days=days)

    asks = []
    for e in of_interest:
        key = str(e["equipment_id"])
        qs = questions_of(e, wanted[e["equipment_class"]], bands.get(key), days=days)
        if not qs:
            continue
        asks.append(
            {
                "equipment_id": key,
                "tag": e["tag"],
                "name": e.get("name"),
                "equipment_class": e["equipment_class"],
                "questions": qs,
            }
        )

    return {
        "site_id": str(site_id),
        "days": days,
        "asks": asks,
        "totals": {
            "machines": len(equipment),
            # Machines a metric wants a plate fact from, and how many are done.
            "of_interest": len(of_interest),
            "asked": len(asks),
            "answered": len(of_interest) - len(asks),
        },
    }
