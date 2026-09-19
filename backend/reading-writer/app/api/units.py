"""Units — the one thing on this platform that turns a number into a quantity.

THE PROBLEM, EXACTLY
--------------------
`points.unit` is NULL for 576 of the 766 live points on this deployment and that
is not a bug (contract §11/§12): the source MQTT payloads carry no `env.u`. It
costs nothing for a trend chart — the axis shows the numbers as measured — and it
is fatal for a RATING, because `kWh / m² / year` is a statement about units.
Without one, a sum of `KWH_kwh` registers is a sum of numbers nobody has said are
kilowatt-hours. HVAC is the worst of it: 28 of 176 points carry a confirmed unit,
which is why ΔT, kW/TR and everything above them refuse.

THE TRAP, AND THE RULE
----------------------
The unit is frequently VISIBLE in the tag: `KWH_kwh`, `Freq_Hz`, `VoltL1_V`,
`CurrL1_A`, `PF_pf`, `TOTKW_kw`. It is very tempting to parse that and store it.

**That is forbidden.** It is the same mistake the contract already records about
floor prefixes (§17): `4F_Solar_Panel01` looks like it names a floor until
`4F-3F AC DB` names two, and a floor-wise chart that is silently wrong for one
floor in five is worse than one that says "unplaced". A tag is a naming
convention. A convention is evidence of nothing.

So this module does exactly one thing with a tag: it OFFERS the reading as a
SUGGESTION, labelled with the pattern it matched, for a human to confirm — one
point at a time, or over a NAMED PATTERN whose whole matched set the human can
count and sample before they act. The operator asserting it is fine; the platform
asserting it is not. What nobody confirms keeps a NULL unit and is counted as
UNCONFIRMED.

`suggest()` and `match_pattern()` are therefore pure and are never called from a
write path. Grep for them: the callers are the two read endpoints and the
pattern EXPANSION, which turns a pattern into the id list an operator confirms —
it never turns a pattern into a unit by itself.

WHY BULK BY PATTERN EXISTS AT ALL
---------------------------------
An earlier version of this file said, in as many words, that there must never be
a `pattern` field on the confirm request, because "apply to everything matching
`_kw`" expanded on the server is a guess wearing a human's authority. That
sentence was protecting the right thing and naming the wrong mechanism. 576
points is not 576 decisions — `1FYC1_IWT`, `4FKC2_IWT` and `1FYorkChiller1_IWT`
are one decision about one convention, made three hundred times by hand, and a
backlog that large is never worked, which is its own way of ending up with no
units at all.

What actually protects the fact is not the shape of the request. It is:

  * the pattern's set is COUNTABLE and SAMPLEABLE before the write
    (`GET /units/patterns`) and fully enumerable after it (`dry_run`);
  * the unit a pattern applies is the CATALOGUED one — the operator confirms the
    proposal they were shown, they do not get to aim a pattern at an arbitrary
    unit (see `confirm_by_pattern`);
  * nothing is ever auto-applied. There is no confidence score above which this
    module writes on its own, and there is no place to put one;
  * a pattern NEVER overwrites a confirmed unit (`unit_source = 'operator'`);
    those points are reported back as skipped, not as applied;
  * a pattern that matches a STATE or is AMBIGUOUS proposes nothing and cannot
    be applied at all. `1FYC1_OnOff STS` is not a quantity, and `KWL1_A` names
    power and ends in the amps suffix — one of the two is a typo and this module
    does not get to pick which.
"""

from __future__ import annotations

import datetime as dt
import re
import uuid
from typing import NamedTuple

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .queries import LIVE_POINT, RETIRE_AFTER_DAYS, _rows


# ── The catalogue ────────────────────────────────────────────────────────────
#
# ONE ordered list, first match wins, and it is the ONLY tag-shape knowledge in
# this module: the per-point suggestion on `GET /units` and the matched set on
# `GET /units/patterns` are the same function reading the same rows, so the count
# an operator is shown before they confirm cannot drift from the rows they see
# listed. `app/metric_registry/roles.py` is deliberately the same idea applied to
# ROLES, and this file stays its model.
#
# `kind` is the tri-state the whole feature turns on:
#
#   "unit"       — a unit is proposed. `unit=""` is a REAL assertion, not a
#                  missing one: power factor is a ratio and has no unit.
#   "state"      — the tag names a state or a flag. It is not a measurement, so
#                  there is no unit to propose and none may be applied. Putting
#                  `h` on `OnOff STS` because it sits beside `Run Hours` on the
#                  same chiller is exactly the fabrication this product exists to
#                  refuse.
#   "ambiguous"  — the tag says two things at once, or says nothing decidable.
#                  The pattern exists so the estate can SEE the collision; it
#                  proposes nothing. An operator who knows the answer confirms
#                  those points by id, one screen at a time, which is right,
#                  because each one is a separate piece of knowledge.
#
# Every regex matches the WHOLE tag, case-insensitively, so a rule fires on a
# shape and not on a substring that could turn up anywhere. Prefixes are free
# (`.*`) because this estate prefixes device identity onto the measurement —
# `1FYC1_`, `2FYorkChiller1_`, `4FSP3_` — and the measurement is the tail.

KIND_UNIT = "unit"
KIND_STATE = "state"
KIND_AMBIGUOUS = "ambiguous"


class UnitPattern(NamedTuple):
    """One convention on this estate, and what it does or does not license.

    `key` is the stable identifier a client posts back. It is not the label and
    it is not the regex: both of those will be edited as the estate grows, and a
    confirmation request that named either would change meaning underneath an
    operator mid-review.
    """

    key: str
    label: str
    kind: str
    unit: str | None
    regex: re.Pattern[str]
    basis: str

    @property
    def proposes_unit(self) -> bool:
        return self.kind == KIND_UNIT


def _p(key: str, label: str, kind: str, unit: str | None, rx: str, basis: str) -> UnitPattern:
    return UnitPattern(key, label, kind, unit, re.compile(rx, re.I), basis)


PATTERNS: list[UnitPattern] = [
    # ── Collisions first ─────────────────────────────────────────────────────
    #
    # ORDER IS LOAD-BEARING HERE, and it is the single most important thing in
    # this list. `KWL1_A` ends in the amps suffix, so the plain `_A` rule further
    # down would hand it `A` without hesitating — while the head of the tag says
    # kilowatts. One of the two is a gateway typo. Both readings are plausible,
    # which is precisely why neither may be proposed: a fabricated `A` on a power
    # channel does not fail, it just makes every total quietly wrong.
    #
    # These live at the top so the specific collision always beats the general
    # suffix. The estate has 14 such points today.
    _p(
        "ambiguous_voltage_named_in_amps", "Voltage tag, amps suffix", KIND_AMBIGUOUS, None,
        r"^.*(?:volt|valt)[a-z0-9_ -]*_a$",
        "the tag names a VOLTAGE but ends in the amps suffix `_A` — one of the two is a typo "
        "and nothing here can say which, so no unit is proposed",
    ),
    _p(
        "ambiguous_current_named_in_volts", "Current tag, volts suffix", KIND_AMBIGUOUS, None,
        r"^.*curr[a-z0-9_ -]*_v$",
        "the tag names a CURRENT but ends in the volts suffix `_V` — one of the two is a typo "
        "and nothing here can say which, so no unit is proposed",
    ),
    _p(
        "ambiguous_power_named_in_amps", "Power tag, amps suffix", KIND_AMBIGUOUS, None,
        r"^.*kw[a-z0-9_ -]*_a$",
        "the tag names active POWER but ends in the amps suffix `_A` — one of the two is a "
        "typo and nothing here can say which, so no unit is proposed",
    ),
    _p(
        "ambiguous_energy_register_spelling", "Energy register, unreadable spelling",
        KIND_AMBIGUOUS, None,
        r"^.*(?:kwah|kwvh)$",
        "the tag ends in `kWAh`/`KWVH`, which is neither `kWh` nor `kVAh` — it is one of the "
        "two misspelled, and active energy and apparent energy are different quantities",
    ),
    _p(
        "ambiguous_flow", "Flow, quantity not stated", KIND_AMBIGUOUS, None,
        r"^.*(?:cum[_ ]?flow|flow[_ ]?rate|for[_ ]?flow|rev[_ ]?flow)$",
        "the tag names a flow without saying whether it is a VOLUME (m³) or a volumetric "
        "RATE (m³/h), and the two are not interchangeable — the meter's own datasheet "
        "decides this, not the tag",
    ),

    # ── States and flags: no unit, ever ──────────────────────────────────────
    #
    # These must precede everything, or nearly: `1FYC1_OnOff STS` happens to
    # collide with no suffix rule today, but the next gateway build that spells
    # it `OnOff_S` would, and a boolean wearing a unit is the one failure this
    # subsystem cannot recover from — every rating downstream would compute,
    # plausibly, from a 0/1.
    _p(
        "state_on_off", "On/Off status", KIND_STATE, None,
        r"^.*on[_ ]?off(?:[_ ]?sts)?$",
        "the tag names an ON/OFF STATE, not a measurement — a state has no unit and none "
        "may be confirmed on it in bulk",
    ),
    _p(
        "state_work_mode", "Work mode", KIND_STATE, None,
        r"^.*work[_ ]?mode$",
        "the tag names an operating MODE — an enumeration, not a quantity, so it has no unit",
    ),

    # ── Measurements ─────────────────────────────────────────────────────────
    #
    # Temperatures come before the electrical suffixes because `4FSP1_Inv_Temp`
    # would otherwise fall through to nothing, and because `IWT`/`OWT` are this
    # estate's only naming of the two numbers ΔT is the difference of.
    _p(
        "chilled_water_temp", "Chilled water in/out temperature", KIND_UNIT, "degC",
        r"^(?:.*[_ ])?[io]wt$",
        "the tag ends in `IWT`/`OWT` — entering and leaving water temperature by this "
        "estate's convention, in degrees Celsius",
    ),
    _p(
        "ambient_temp", "Ambient temperature", KIND_UNIT, "degC",
        r"^.*amb[_ ]?temp$",
        "the tag ends in `AmbTemp` — the machine's ambient air temperature, in degrees Celsius",
    ),
    _p(
        "inverter_temp", "Inverter temperature", KIND_UNIT, "degC",
        r"^.*inv[_ ]?temp$",
        "the tag ends in `Inv_Temp` — the inverter's own temperature, in degrees Celsius",
    ),
    # `Run Hours` IS a measurement and `OnOff STS` is not, on the same chiller,
    # two tags apart. That pair is the whole reason `kind` exists.
    _p(
        "run_hours", "Run hours", KIND_UNIT, "h",
        r"^.*run[_ ]?hours?$",
        "the tag ends in `Run Hours` — a cumulative running-time total, in hours",
    ),
    # THE SPELLING DRIFT. One device, three spellings: `SysLoad`, `Sys Load`,
    # `SystemLoad`, plus `SYS Load` on the older profile. `[_ ]?` and an optional
    # `tem` absorb all four WITHOUT loosening into `Load`, which is left
    # deliberately unmatched — a bare `Load` on an energy meter is as likely to
    # be kW as a percentage, and that is a question for a human.
    _p(
        "system_load_percent", "System load", KIND_UNIT, "percent",
        r"^.*sys(?:tem)?[_ ]?load$",
        "the tag ends in `SysLoad`/`Sys Load`/`SystemLoad` — the machine's load as a "
        "percentage of capacity",
    ),
    _p(
        "power_factor", "Power factor", KIND_UNIT, "",
        r"^(?:.*[_ ])?pf$",
        "the tag is `PF`/`_pf` — power factor is a ratio of two powers, so it is "
        "dimensionless. The empty unit is an ASSERTION that it has none, not a missing value",
    ),
    _p(
        "frequency_hz", "Frequency", KIND_UNIT, "Hz",
        r"^(?:.*[_ ])?hz$",
        "the tag ends in `_Hz` — supply frequency, in hertz",
    ),
    # kVAh before kWh and kVA before kW: the longer spelling has to win, or
    # `_kvah` never gets the chance to be apparent energy.
    _p(
        "apparent_energy_kvah", "Apparent energy", KIND_UNIT, "kVAh",
        r"^.*kvah$",
        "the tag ends in `kVAh` — apparent energy, which is NOT the active energy a "
        "consumption is computed from",
    ),
    # Every tag here is genuinely in kWh, INCLUDING `TodayKWH` and
    # `This_MonthKWH`. That a period total resets and a lifetime register does
    # not is a true and important distinction — and it is a ROLE, not a unit:
    # `roles.py` separates `energy_period_total` from `energy_register` for
    # exactly this. Splitting it here as well would put the same judgement in two
    # places and let them disagree.
    _p(
        "active_energy_kwh", "Active energy", KIND_UNIT, "kWh",
        r"^.*kwh$",
        "the tag ends in `kWh` — active energy, in kilowatt-hours. Whether it is a lifetime "
        "register or a period total is a ROLE, not a unit; both are in kWh",
    ),
    _p(
        "apparent_power_kva", "Apparent power", KIND_UNIT, "kVA",
        r"^.*kva$",
        "the tag ends in `kVA` — apparent power, which is not the active power a load is "
        "measured by",
    ),
    _p(
        "active_power_kw", "Active power", KIND_UNIT, "kW",
        r"^.*kw$",
        "the tag ends in `kW` — active power, in kilowatts. `TOT KW`, `1FYC1 EM - Total kW` "
        "and `1FYC1_EM_kW` are the same measurement spelled three ways",
    ),
    # The per-phase spelling puts the phase AFTER the unit (`KW_L1`, `KWL3`), so
    # it cannot be caught by a trailing-`kw` rule and needs its own.
    _p(
        "active_power_phase_kw", "Active power, per phase", KIND_UNIT, "kW",
        r"^.*kw[_ ]?l[123]$",
        "the tag is a per-phase active power (`KW_L1`, `KWL2`) — kilowatts on one phase",
    ),
    _p(
        "voltage_v", "Voltage", KIND_UNIT, "V",
        r"^.*_v$",
        "the tag ends in `_V` — voltage, in volts",
    ),
    _p(
        "current_a", "Current", KIND_UNIT, "A",
        r"^.*_a$",
        "the tag ends in `_A` — current, in amperes",
    ),
]

PATTERNS_BY_KEY: dict[str, UnitPattern] = {p.key: p for p in PATTERNS}


def match_pattern(point_tag: str | None, kind: str | None) -> UnitPattern | None:
    """The FIRST catalogued pattern this tag matches, or None.

    Text points match nothing at all. A unit on a string is meaningless, and the
    one text point on this estate is a probe.
    """
    if not point_tag or kind != "num":
        return None
    tag = point_tag.strip()
    for pattern in PATTERNS:
        if pattern.regex.match(tag):
            return pattern
    return None


def suggest(point_tag: str | None, kind: str | None) -> dict | None:
    """What the TAG appears to say, as a suggestion — never as a fact.

    Returns ``None`` when no pattern matches, which is a perfectly good outcome:
    the point stays unconfirmed and says so.

    When a pattern DOES match, the caller always learns which one and why, and
    `unit` may still be `None` — a state or an ambiguity matched, the basis says
    so, and there is nothing to confirm. That is a different answer from "no
    pattern matched", and the screen has to be able to tell them apart: one is
    work waiting for a human, the other is a tag the estate should fix.
    """
    pattern = match_pattern(point_tag, kind)
    if pattern is None:
        return None
    return {
        "pattern": pattern.key,
        "unit": pattern.unit,
        "proposes_unit": pattern.proposes_unit,
        "basis": pattern.basis,
    }


# ── Reads ────────────────────────────────────────────────────────────────────

_LIST_SQL = """
    SELECT p.point_id, p.point_tag, p.device_id, p.device_tag, p.category,
           p.device_type, p.type, p.unit, p.unit_source, p.unit_confirmed_at,
           p.unit_confirmed_by, p.site_id, p.site_name, p.last_seen_at
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND {live}
       {filters}
     ORDER BY p.device_tag NULLS LAST, p.point_tag NULLS LAST
     LIMIT :limit OFFSET :offset
"""

_COUNTS_SQL = """
    SELECT count(*)                                                  AS points,
           count(*) FILTER (WHERE p.unit_source = 'operator')         AS confirmed,
           count(*) FILTER (WHERE p.unit_source IS DISTINCT FROM 'operator') AS unconfirmed
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND {live}
       {filters}
"""


def _filters(category: str | None, search: str | None, confirmed: str) -> tuple[str, dict]:
    where = ""
    params: dict = {}
    if category is not None:
        if category == "":
            where += " AND p.category IS NULL"
        else:
            where += " AND p.category = :category"
            params["category"] = category
    if search:
        where += " AND (p.device_tag ILIKE :search OR p.point_tag ILIKE :search)"
        params["search"] = f"%{search}%"
    if confirmed == "confirmed":
        where += " AND p.unit_source = 'operator'"
    elif confirmed == "unconfirmed":
        where += " AND p.unit_source IS DISTINCT FROM 'operator'"
    return where, params


async def list_units(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    category: str | None = None,
    search: str | None = None,
    confirmed: str = "all",
    limit: int = 200,
    offset: int = 0,
) -> tuple[dict, list[dict]]:
    where, extra = _filters(category, search, confirmed)
    params = {
        "tenant": str(tenant) if tenant else None,
        "retire_days": RETIRE_AFTER_DAYS,
        "limit": limit,
        "offset": offset,
        **extra,
    }
    counts = _rows(
        await db.execute(text(_COUNTS_SQL.format(live=LIVE_POINT, filters=where)), params)
    )[0]
    rows = _rows(await db.execute(text(_LIST_SQL.format(live=LIVE_POINT, filters=where)), params))
    for r in rows:
        # Computed HERE, at read time, from the tag — and never written anywhere.
        r["suggestion"] = suggest(r["point_tag"], r["type"])
    return {k: int(v or 0) for k, v in counts.items()}, rows


# ── Pattern expansion ────────────────────────────────────────────────────────
#
# WHY THE MATCHING HAPPENS IN PYTHON AND NOT IN SQL.
#
# The obvious implementation is `point_tag ~* :rx` with the regex pushed down to
# Postgres, and it is wrong. Python's `re` and Postgres' ARE are not the same
# dialect, and the ONE property this feature cannot afford to lose is that the
# count an operator is shown by `GET /units/patterns` is exactly the set that
# `POST /units/confirm` will write to and exactly the rows `GET /units` labelled
# with that pattern. Two engines are two chances to disagree, and the disagreement
# would surface as a bulk write that touched a point the operator never saw.
#
# So SQL selects the CANDIDATES — live, this tenant's, numeric, filtered by
# category — and `match_pattern()` decides, once, in one language. The estate is
# eight hundred points; there is no argument for the other design here.

_CANDIDATES_SQL = """
    SELECT p.point_id, p.point_tag, p.device_tag, p.category, p.type,
           p.unit, p.unit_source, p.site_id, p.site_name
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND {live}
       AND p.type = 'num'
       {filters}
     ORDER BY p.device_tag NULLS LAST, p.point_tag NULLS LAST
"""

# Sampled tags per pattern on the catalogue endpoint. Enough to recognise the
# convention and to spot an intruder; not so many that the response becomes the
# list endpoint with worse filters.
SAMPLE_TAGS = 8


def is_confirmed(row: dict) -> bool:
    """Has a HUMAN already said what this point's unit is?

    `unit_source = 'operator'` is the only answer that counts. A unit that
    arrived in `env.u` is not a confirmation — nothing on this estate sends one,
    and if something started to, it would still be the gateway talking.
    """
    return row.get("unit_source") == "operator"


async def _candidates(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    category: str | None,
    site_id: uuid.UUID | None = None,
) -> list[dict]:
    """The rows every pattern is matched against.

    The ONLY place the catalogue's set and the confirm's set are selected, so a
    filter added here narrows both or neither — the preview and the write cannot
    disagree about which points they mean. `site_id` is a plain predicate: a unit
    is confirmed per point and a point has one placement.
    """
    where = ""
    params: dict = {"tenant": str(tenant) if tenant else None, "retire_days": RETIRE_AFTER_DAYS}
    if category is not None:
        if category == "":
            where = " AND p.category IS NULL"
        else:
            where = " AND p.category = :category"
            params["category"] = category
    if site_id is not None:
        where += " AND p.site_id = CAST(:site AS uuid)"
        params["site"] = str(site_id)
    return _rows(
        await db.execute(
            text(_CANDIDATES_SQL.format(live=LIVE_POINT, filters=where)), params
        )
    )


# The LAST KNOWN value per point, for the catalogue's "does this look like a
# volt" check. Off `readings_1h`, not raw `readings`: a unit is judged on what
# the point reads when it reads, and on this estate many points have been quiet
# for hours — the one-hour raw lookback `/bi/points` uses would show most of them
# blank, which is the question left unanswered. Bounded to a month so a point
# silent since spring is not dressed up with a stale value.
LAST_KNOWN_DAYS = 30

_LAST_KNOWN_SQL = text(
    """
    SELECT DISTINCT ON (r.point_id)
           r.point_id, r.bucket AS at, r.num_last AS value
      FROM readings_1h r
     WHERE r.point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
       AND r.bucket >= now() - make_interval(days => :days)
       AND r.num_last IS NOT NULL
     ORDER BY r.point_id, r.bucket DESC
    """
)


async def _last_known(
    db: AsyncSession, tenant: uuid.UUID | None, point_ids: list
) -> dict:
    """point_id -> {value, at}. A point with no reading in the window is ABSENT,
    never 0: "has not read anything lately" and "reads zero" are different facts,
    and the range check below must not treat the first as the second."""
    if not point_ids:
        return {}
    rows = _rows(
        await db.execute(
            _LAST_KNOWN_SQL,
            {
                "pids": [str(p) for p in point_ids],
                "tenant": str(tenant) if tenant else None,
                "days": LAST_KNOWN_DAYS,
            },
        )
    )
    return {r["point_id"]: {"value": r["value"], "at": r["at"]} for r in rows}


def _point_view(row: dict, known: dict) -> dict:
    """One eligible point as the walk shows it: which point, and what it reads."""
    k = known.get(row["point_id"])
    return {
        "point_id": row["point_id"],
        "point_tag": row.get("point_tag"),
        "device_tag": row.get("device_tag"),
        "value": k["value"] if k else None,
        "at": k["at"] if k else None,
    }


def _classify(rows: list[dict]) -> dict[str, list[dict]]:
    """Every candidate row filed under the one pattern it matches."""
    by_key: dict[str, list[dict]] = {p.key: [] for p in PATTERNS}
    for row in rows:
        pattern = match_pattern(row.get("point_tag"), row.get("type"))
        if pattern is not None:
            by_key[pattern.key].append(row)
    return by_key


def _pattern_summary(pattern: UnitPattern, rows: list[dict], known: dict | None = None) -> dict:
    """One catalogue entry, with the two numbers that decide whether it is work.

    `eligible` and `already_confirmed` are reported SEPARATELY and never summed.
    A pattern showing 40 matched / 40 already confirmed is finished; one showing
    40 matched / 0 confirmed is forty points of work; and a single number could
    not tell those apart.
    """
    confirmed = [r for r in rows if is_confirmed(r)]
    eligible = [r for r in rows if not is_confirmed(r)]
    # Sampled from the ELIGIBLE rows: the operator is about to act on those, and
    # showing them tags that are already settled would misrepresent the set.
    seen: list[str] = []
    for r in eligible:
        tag = r.get("point_tag")
        if tag and tag not in seen:
            seen.append(tag)
        if len(seen) >= SAMPLE_TAGS:
            break
    return {
        "key": pattern.key,
        "label": pattern.label,
        "kind": pattern.kind,
        # None for a state or an ambiguity. Not "", which is power factor's real
        # and confirmable assertion that it has no unit.
        "unit": pattern.unit,
        "proposes_unit": pattern.proposes_unit,
        "basis": pattern.basis,
        "matched": len(rows),
        "eligible": len(eligible),
        "already_confirmed": len(confirmed),
        "sample_tags": seen,
        "categories": sorted({r["category"] for r in rows if r.get("category")}),
        # EVERY eligible point, with what it reads — not a sample. The console
        # checks each reading against the unit's plausible range, and a check run
        # on three of sixty-four would let the sixty-first hide a mis-scaled
        # meter behind a green tick.
        "points": [_point_view(r, known or {}) for r in eligible],
    }


async def pattern_catalogue(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    category: str | None = None,
    site_id: uuid.UUID | None = None,
) -> dict:
    """Every pattern, what it proposes, and how much of this estate it is holding.

    Nothing here writes. This is the screen an operator reads BEFORE they confirm
    anything, and the numbers on it are the numbers the write will act on.
    """
    rows = await _candidates(db, tenant, category, site_id)
    by_key = _classify(rows)
    unmatched = [r for r in rows if match_pattern(r.get("point_tag"), r.get("type")) is None]
    open_rows = [r for r in rows if not is_confirmed(r)]
    known = await _last_known(db, tenant, [r["point_id"] for r in open_rows])
    items = [_pattern_summary(p, by_key[p.key], known) for p in PATTERNS]
    return {
        "patterns": items,
        "totals": {
            "points": len(rows),
            "matched": sum(i["matched"] for i in items),
            # Points no pattern claims. This is NOT a failure of the catalogue —
            # `Batt_Time_Rem`, `Load` and `Point1` are tags nobody here can read,
            # and the honest report is that they are still one-by-one work.
            "unmatched": len(unmatched),
            "eligible": sum(i["eligible"] for i in items),
            "already_confirmed": sum(i["already_confirmed"] for i in items),
        },
        "unmatched_sample": [
            r["point_tag"] for r in unmatched[:SAMPLE_TAGS] if r.get("point_tag")
        ],
        # The names no convention claims, as points: they are still one-by-one
        # work, and the walk asks about them one by one rather than sending the
        # operator to a second screen.
        "unmatched_points": [
            _point_view(r, known) for r in unmatched if not is_confirmed(r)
        ],
    }


async def pattern_targets(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    key: str,
    category: str | None = None,
    site_id: uuid.UUID | None = None,
) -> tuple[UnitPattern, list[dict], list[dict]]:
    """The rows one pattern would write to, and the rows it must not.

    Returns `(pattern, eligible, already_confirmed)`. The second list is the
    guard rule 2 made visible: a point a human has already ruled on is never
    touched by a pattern, and it is reported rather than silently dropped —
    "applied 300" when 40 of them were skipped is a lie about what happened.
    """
    pattern = PATTERNS_BY_KEY[key]
    rows = _classify(await _candidates(db, tenant, category, site_id))[key]
    return pattern, [r for r in rows if not is_confirmed(r)], [r for r in rows if is_confirmed(r)]


_VISIBLE_SQL = text(
    """
    SELECT p.point_id, p.point_tag, p.device_tag, p.category, p.unit, p.unit_source
      FROM points p
     WHERE p.point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
    """
)


async def visible_points(
    db: AsyncSession, tenant: uuid.UUID | None, point_ids: list[uuid.UUID]
) -> list[dict]:
    """Of the ids the caller named, the ones that are actually theirs.

    The write already drops the rest — the UPDATE carries the same `:tenant`
    bind — but a DRY RUN has to reach the same answer without writing, or the
    preview would promise rows the real call would silently not touch. This is
    that read, and it is the same predicate.

    Retired points are NOT excluded here. `point_ids` is a list an operator
    selected, and a deliberate assertion about a retired point is theirs to make;
    the retirement horizon is what keeps a PATTERN from wandering onto one.
    """
    if not point_ids:
        return []
    return _rows(
        await db.execute(
            _VISIBLE_SQL,
            {
                "pids": [str(p) for p in point_ids],
                "tenant": str(tenant) if tenant else None,
            },
        )
    )


# ── The one write ────────────────────────────────────────────────────────────

_CONFIRM_SQL = text(
    """
    UPDATE points p
       SET unit              = CAST(:unit AS varchar),
           unit_source       = CASE WHEN :clear THEN NULL ELSE 'operator' END,
           unit_confirmed_at = CASE WHEN :clear THEN NULL ELSE now() END,
           unit_confirmed_by = CASE WHEN :clear THEN NULL ELSE CAST(:actor AS varchar) END
     WHERE p.point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
    RETURNING p.point_id
    """
)


async def confirm_units(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    point_ids: list[uuid.UUID],
    unit: str | None,
    actor: str | None,
) -> list[uuid.UUID]:
    """Record that a HUMAN says these points are in this unit.

    The ids are EXPLICIT, always — including when a pattern produced them. There
    is exactly one write in this module and it takes a list of point ids; the
    pattern path resolves its set first (`pattern_targets`) and then calls this,
    so the bulk route cannot acquire a second, looser way to update a row.

    `unit=None` CLEARS: the unit, the source and the provenance all go back to
    NULL and the point returns to UNCONFIRMED. That has to be reachable — a
    mis-typed unit an operator cannot take back would silently corrupt every
    rating computed from it.

    A tenant-scoped caller cannot touch another tenant's point: the statement
    carries the same `:tenant` bind every other read does.
    """
    if not point_ids:
        return []
    rows = _rows(
        await db.execute(
            _CONFIRM_SQL,
            {
                "pids": [str(p) for p in point_ids],
                "tenant": str(tenant) if tenant else None,
                "unit": unit,
                "clear": unit is None,
                "actor": (actor or "")[:320] or None,
            },
        )
    )
    await db.commit()
    return [r["point_id"] for r in rows]


# Re-exported so the router can stamp a response without importing datetime.
def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)
