"""Cross-domain correlations — resolving what a question NEEDS against the estate.

WHAT THIS ANSWERS, AND WHY IT IS THE PRODUCT
--------------------------------------------
`correlation_defs` (migration 0025) holds seven questions that need two domains
at once. A BMS cannot ask them — not because its vendor is careless but because
it owns HVAC and the badge is in a different product. This module takes each
question's declared needs and resolves them against THIS estate, and its whole
job is to answer a very specific follow-up honestly:

    the question is not being asked today — WHY, and what would it cost to fix?

"Buy a people-counting camera" and "confirm that the number called AmbTemp is in
degrees" are both "a gap". They are not remotely the same sentence, and a screen
that renders them identically has thrown away the only interesting thing about
the answer. So a gap here always carries a KIND, and every kind carries
`needs_new_hardware`.

THE GAP KINDS ARE THE POINT
----------------------------
`GAP_KINDS` below is closed. Read it as the set of sentences this platform is
willing to say about why a question is unanswerable, and note that exactly one of
them costs money.

`needs_new_hardware` is a TRI-STATE, and the third state is the one that keeps
this honest. `None` means undetermined — not "no". An aggregate that folded
undetermined into "no" would let the console print "nothing to buy" on the
strength of a thing it does not know, which is precisely the failure this
codebase spends its comments preventing everywhere else. Two kinds carry it, and
for the same reason in both cases: the fact that would settle it is not in this
store (`module_population_unknown`, `signal_silent`).

A SIGNAL IS PRESENT IN THE WINDOW OR IT IS NOT PRESENT
-------------------------------------------------------
The single most important rule here, and the one an earlier version of this file
got wrong in a way that took eight days of dead sensors to surface. A point
counts toward a signal when it produced READINGS INSIDE THE REQUESTED WINDOW —
not when it is un-retired, not when it spoke sometime this month, and not when
somebody bound a role to it. The window a signal has to be present in is the
window the answer would be computed over; anything looser reports a question as
answerable off data that does not exist inside it. The long note above `_PROBE_SQL`
has the full account of what was there before and what it cost.

A point that carries a correct assertion and has stopped measuring is its own gap
kind (`signal_silent`) precisely because it is the most misleading state an estate
can be in: every screen that reads configuration says it is fine.

WHAT THIS MODULE MAY NOT DO
----------------------------
Read another service's database. `reading-writer` owns `neubit_reporting`; the
door inventory is in `neubit_access` and the camera inventory is in
`neubit_vision`, and opening either is the cross-service read the pipeline
contract bans (§1) and that `placement_sync.py`'s header exists to explain. The
honest instruments available here are the READ-MODELS this store already keeps —
`reporting_projections` for which domains publish into it at all, and the
projected relations themselves for what those domains have actually said. Where
that is not enough, this module says UNKNOWN. See `_resolve_projection`, which is
where the whole argument lives.

EVERY RESOLVER IS SPLIT IN TWO
-------------------------------
A query that fetches rows, and a PURE function that decides what those rows mean.
The rules are the part that decides whether an operator is told to buy a sensor,
and they are reachable in a test with rows a test chose — the same shape
`metric_registry.evaluator` uses and for the same reason.
"""

from __future__ import annotations

import datetime as dt
import re
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..metric_registry.roles import ROLE_DEFS
from ..metric_registry.units import UNIT_DIMENSION
from .queries import _rows

# The default analysis window. 168 hours = 7 days, the same default
# `GET /bi/correlation` uses for the coefficient it computes, deliberately: the
# window a signal has to be PRESENT in and the window a coefficient is computed
# over must be the same window, or this endpoint would report a signal as
# available and the one that draws the chart would find nothing.
DEFAULT_WINDOW_HOURS = 168

# Identifier allowlist for anything read out of a projection spec and quoted into
# SQL. Deliberately identical to `registry.IDENT_RE` and `projections.spec`'s —
# the three places a registered name reaches a statement must agree.
IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class SpecError(ValueError):
    """A seeded correlation that this resolver cannot make sense of.

    Raised at resolution rather than swallowed. A signal whose source is not in
    the closed vocabulary would otherwise resolve to "unsatisfied, reason
    unknown" forever, which looks exactly like a real gap and is not one.
    """


# ── The gap kinds ────────────────────────────────────────────────────────────
#
# `needs_new_hardware` is the field the punchline rests on:
#
#   True   somebody has to buy and install something.
#   False  the customer already owns everything required; what is missing is an
#          assertion, a binding, a switched-on module or a typed fact.
#   None   UNDETERMINED from this service. Not "no".
#
# `remedy` is written for the operator, `where` names the console surface that
# does it, and `gate` (built per signal at resolution time) says what is
# currently standing in the way in the estate's own terms.


@dataclass(frozen=True)
class GapKind:
    key: str
    needs_new_hardware: bool | None
    summary: str
    remedy: str
    where: str | None


GAP_KINDS: dict[str, GapKind] = {
    "unit_unconfirmed": GapKind(
        key="unit_unconfirmed",
        needs_new_hardware=False,
        summary="The measurement is arriving; nothing has said what it is in.",
        remedy=(
            "Record the unit on the gateway, beside the point's live value — it "
            "travels here on every reading. Neither side infers one from the tag: "
            "a naming convention is evidence of nothing."
        ),
        where="the gateway that sends these points",
    ),
    "unit_wrong_dimension": GapKind(
        key="unit_wrong_dimension",
        needs_new_hardware=False,
        summary="A unit is recorded, but it is not the kind of quantity this signal needs.",
        remedy=(
            "Correct the unit on the gateway. A recorded unit of the wrong "
            "dimension is an error that has already been made, and it is worse "
            "than a missing one: everything downstream would type-check and be "
            "wrong."
        ),
        where="the gateway that sends these points",
    ),
    "role_unbound": GapKind(
        key="role_unbound",
        needs_new_hardware=False,
        summary="Points that could play this part exist; none is bound to the role.",
        remedy=(
            "Bind the role on one of the candidate points. The correlation asks "
            "for a role and never for a tag, so that the same question works on "
            "the next estate, which spells its tags differently."
        ),
        where="Building Intelligence → Roles",
    ),
    "signal_silent": GapKind(
        key="signal_silent",
        # WHY None, AND NOT False. This is the kind that most wants to be cheap,
        # and it is the one that has least business claiming to be.
        #
        # The assertion is RIGHT: somebody bound the role, or confirmed the unit,
        # and the point exists. What has failed is the measurement. From inside
        # `neubit_reporting` the reason for that is genuinely not decidable — a
        # dead transducer, a gateway that lost the device, a poll that was edited,
        # a panel powered down for works, or a tag renamed by a rebuild so the
        # readings now arrive under a different point id (which is what
        # `app/api/succession.py` exists for, and which costs nothing to fix).
        # Two of those cost money and the rest do not.
        #
        # False would tell an operator "nothing to buy" about what may be a failed
        # meter. True would send them shopping for a sensor that is probably just
        # offline, and would wreck the one aggregate on this screen that has to be
        # trustworthy. The honest answer is the third one, and it is the same
        # answer `module_population_unknown` gives for the same reason: the fact is
        # not in this store.
        needs_new_hardware=None,
        summary="The binding is right and the sensor has gone quiet.",
        remedy=(
            "Nothing here needs re-configuring: the role or unit on this point is "
            "correct. The point has produced no reading inside the window. Check "
            "the device and its gateway link first, and check whether the tag was "
            "renamed by a rebuild — a rename moves the readings to a new point and "
            "costs nothing to follow."
        ),
        where="Building Intelligence → Points (last seen), then the gateway",
    ),
    "point_absent": GapKind(
        key="point_absent",
        needs_new_hardware=True,
        summary="No point of this shape exists on this estate at all.",
        remedy=(
            "This is the one kind of gap that costs money: a sensor, or an "
            "existing sensor brought onto the gateway. Note what it is NOT — a "
            "point that exists and has stopped is `signal_silent`, and a point "
            "that exists and reports is one of the configuration gaps. This is "
            "the case where the dimension holds no such row."
        ),
        where=None,
    ),
    "module_unpopulated": GapKind(
        key="module_unpopulated",
        needs_new_hardware=False,
        summary="The module publishes into this store, and has published nothing in the window.",
        remedy=(
            "Switch on a module you already own: enrol the devices and let them "
            "publish. Nothing needs to be bought — the integration is deployed "
            "and the pipe is connected, it is carrying no traffic."
        ),
        where="Configurations → the module's own console",
    ),
    "module_population_unknown": GapKind(
        key="module_population_unknown",
        needs_new_hardware=None,
        summary="This store cannot see the module at all, so its population is unknown.",
        remedy=(
            "Register the module's projection so its events reach the reporting "
            "store. Until then neither 'it is empty' nor 'it is populated' is a "
            "sentence this service is entitled to say — its inventory lives in a "
            "database this service is not allowed to open."
        ),
        where="Configurations → Integrations",
    ),
    "site_fact_unrecorded": GapKind(
        key="site_fact_unrecorded",
        needs_new_hardware=False,
        summary="A fact about the site that nobody has typed in.",
        remedy=(
            "Record it on the site. It is not measurable and it is never "
            "estimated here — a default would be a number nobody asserted "
            "wearing the authority of a measurement."
        ),
        where="Building Intelligence → Setup → Building facts",
    ),
    "site_fact_uncited": GapKind(
        key="site_fact_uncited",
        needs_new_hardware=False,
        summary="The fact is recorded, but with no source to stand behind it.",
        remedy=(
            "Add the citation. A figure that ends up in a disclosure has to name "
            "where it came from, or it is a number somebody remembered."
        ),
        where="Building Intelligence → Setup → Building facts",
    ),
}

# The closed source vocabulary, and the `requires` keys each source understands.
# A seed naming a source that is not here, or a `requires` key this resolver
# would silently ignore, is a SpecError — never a signal that quietly never
# resolves.
SOURCES: dict[str, tuple[frozenset[str], frozenset[str]]] = {
    # source -> (required keys, optional keys)
    "point_live": (frozenset({"tag_pattern"}), frozenset({"category", "device_type"})),
    "point_unit": (
        frozenset({"tag_pattern"}),
        frozenset({"category", "device_type", "dimension"}),
    ),
    "point_role": (
        frozenset({"role"}),
        frozenset({"category", "device_type", "candidate_tag_pattern"}),
    ),
    "projection": (frozenset({"projection_key", "key_column"}), frozenset()),
    "site_fact": (frozenset({"fact"}), frozenset()),
}

# The site facts a correlation may ask for. Closed, like the role vocabulary and
# for the same reason: an open string would grow a folksonomy of facts with no
# resolver behind them.
SITE_FACTS = ("emission_factor",)


def validate_signal(signal: dict) -> None:
    """That a seeded signal is one this resolver can actually answer.

    Called on every signal before anything is queried, so a bad seed fails the
    request loudly instead of rendering as a gap that can never be closed.
    """
    source = signal.get("source")
    spec = SOURCES.get(source)
    if spec is None:
        raise SpecError(
            f"signal `{signal.get('key')}` declares source `{source}`, which is "
            f"not in the closed vocabulary ({', '.join(sorted(SOURCES))}). A new "
            f"source is a new way of being satisfied and needs a resolver."
        )
    required, optional = spec
    requires = signal.get("requires") or {}
    missing = sorted(required - set(requires))
    if missing:
        raise SpecError(f"signal `{signal.get('key')}` ({source}) is missing {missing}")
    extra = sorted(set(requires) - required - optional)
    if extra:
        raise SpecError(
            f"signal `{signal.get('key')}` ({source}) declares {extra}, which this "
            f"resolver would ignore — a requirement nothing enforces is not one"
        )
    if source == "point_role" and requires["role"] not in ROLE_DEFS:
        raise SpecError(
            f"signal `{signal.get('key')}` needs role `{requires['role']}`, which "
            f"is not in the role vocabulary ({', '.join(sorted(ROLE_DEFS))})"
        )
    if source == "point_unit":
        dimension = requires.get("dimension")
        if dimension is not None and dimension not in set(UNIT_DIMENSION.values()):
            raise SpecError(
                f"signal `{signal.get('key')}` needs dimension `{dimension}`, which "
                f"no unit in the dimension table carries"
            )
    if source == "site_fact" and requires["fact"] not in SITE_FACTS:
        raise SpecError(
            f"signal `{signal.get('key')}` needs site fact `{requires['fact']}`, "
            f"which has no resolver ({', '.join(SITE_FACTS)})"
        )


# ── Loading the definitions ──────────────────────────────────────────────────
#
# A tenant sees the union of platform rows (`tenant_id IS NULL`) and its own, and
# where both define a key the TENANT's row wins — identical to how the metric
# registry resolves a definition, and for the identical reason: a platform row is
# a default, not a decree.
#
# `effective_from <= now()` and the highest version among those: a correlation
# that changed what it needs keeps answering for the window it answered for.

_DEFS_SQL = text(
    """
    SELECT id, tenant_id, key, version, effective_from, name, question, unlocks,
           domains, signals
      FROM correlation_defs
     WHERE (tenant_id IS NULL OR tenant_id = CAST(:tenant AS uuid))
       AND effective_from <= now()
     ORDER BY key, tenant_id NULLS LAST, effective_from DESC, version DESC
    """
)


def _pick_effective(rows: list[dict]) -> list[dict]:
    """One row per key: the tenant's own if it has one, else the platform's.

    The ORDER BY does the work — `tenant_id NULLS LAST` puts a tenant row ahead
    of the platform row for the same key, and the descending effective_from puts
    the version in force first — so this keeps the first row it sees per key.
    """
    out: list[dict] = []
    seen: set[str] = set()
    for row in rows:
        if row["key"] in seen:
            continue
        seen.add(row["key"])
        out.append(row)
    return out


async def load_definitions(db: AsyncSession, tenant: uuid.UUID | None) -> list[dict]:
    rows = _rows(await db.execute(_DEFS_SQL, {"tenant": str(tenant) if tenant else None}))
    return _pick_effective(rows)


# ── Probing the points ───────────────────────────────────────────────────────
#
# ONE statement for every point-shaped need on the screen, rather than one per
# signal. The probes travel as parallel arrays and are unnested into a relation,
# so adding a correlation adds a row to an array and not a round trip.
#
# What comes BACK is rows, not verdicts: the matched points with their unit, unit
# source and whether the role is bound. Every rule about what that means lives in
# the pure functions below, where a test can reach it without a database.
#
# WHAT MAKES A POINT COUNT — and the mistake this replaces, which shipped.
#
# An earlier version of this file applied `queries.LIVE_POINT` here and said, in a
# comment directly above the SQL, that this meant "a signal is satisfied by a
# point that is actually reporting". That sentence was false, and it was false in
# the most expensive direction available.
#
#     LIVE_POINT := p.retired_at IS NULL
#                   AND (:retire_days = 0
#                        OR p.last_seen_at >= now() - make_interval(days => :retire_days))
#
# with `VE_READINGS_RETIRE_AFTER_DAYS` defaulting to 30. That is "nobody retired
# it and it spoke sometime in the last MONTH". A point silent for twenty-nine days
# passes it. On this deployment, all twenty role bindings were last seen on 5 or
# 11 September while the estate as a whole was current to the minute — so the
# endpoint whose entire job is to say whether a question can honestly be asked was
# reporting chiller ΔT as SATISFIED off two sensors that had produced nothing for
# eight days. That is dead-meter averaging, in the one place this platform least
# gets to do it.
#
# So the rule is now the one the window already implies:
#
#   * a point SATISFIES a signal when it produced READINGS INSIDE THE REQUESTED
#     WINDOW. That is what the `LEFT JOIN LATERAL` below establishes, per point,
#     over `readings` — the same window `/bi/correlation` would compute the
#     coefficient over, because a signal that is "present" over a span the answer
#     is not computed over is not present for this purpose at all;
#   * `retired_at IS NULL` is kept as the one coarse filter, because an operator
#     saying "this is gone" is a statement and not a silence;
#   * the 30-day horizon is NOT applied. It would erase exactly the case that
#     matters — a point somebody bound a role to, that has since stopped — turning
#     it after a month from "your meter stopped, here it is" into "you have no
#     such sensor, go and buy one". The duration of the silence is not hidden
#     either: `last_seen_at` rides back on every row.

_PROBE_SQL = """
    WITH probe(idx, pattern, category, device_type, role, require_role) AS (
        SELECT * FROM unnest(
            CAST(:idx AS int[]),
            CAST(:pattern AS text[]),
            CAST(:category AS text[]),
            CAST(:device_type AS text[]),
            CAST(:role AS text[]),
            CAST(:require_role AS boolean[])
        )
    )
    SELECT pr.idx,
           p.point_id, p.point_tag, p.device_tag, p.category, p.device_type,
           p.unit, p.unit_source, p.last_seen_at,
           r.role AS bound_role,
           w.last_in_window
      FROM probe pr
      JOIN points p
        ON (pr.pattern IS NULL OR p.point_tag ~* pr.pattern)
       AND (pr.category IS NULL OR p.category = pr.category)
       AND (pr.device_type IS NULL OR p.device_type = pr.device_type)
      LEFT JOIN point_roles r
        ON r.point_id = p.point_id AND r.role = pr.role
      -- Did this point actually MEASURE anything in the window? `readings` is
      -- keyed (point_id, ts), so this is an index seek per point and a backward
      -- scan that stops at the first row; `max()` rather than `EXISTS` because
      -- the instant it last spoke inside the window is worth the same seek.
      LEFT JOIN LATERAL (
          SELECT max(rd.ts) AS last_in_window
            FROM readings rd
           WHERE rd.point_id = p.point_id
             AND rd.tenant_id = p.tenant_id
             AND rd.ts >= :start
             AND rd.ts < :end
      ) w ON TRUE
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND p.retired_at IS NULL
       AND (NOT pr.require_role OR r.point_id IS NOT NULL)
     ORDER BY pr.idx, p.device_tag NULLS LAST, p.point_tag NULLS LAST
"""


@dataclass(frozen=True)
class Probe:
    """One point-shaped question put to the store."""

    pattern: str | None
    category: str | None
    device_type: str | None
    role: str | None
    require_role: bool


def probes_for(signal: dict) -> dict[str, Probe]:
    """The probe(s) one signal needs, keyed by the name its resolver reads.

    A `point_role` signal needs TWO, and the split is load-bearing: the BOUND set
    is found by role and never by tag, because a role that followed a gateway
    rename now sits on a point whose tag matches no pattern anybody wrote (see
    `app/api/succession.py`). Probing the bound set by tag would report a bound
    role as unbound the first time an estate renamed a sensor.
    """
    source = signal["source"]
    req = signal.get("requires") or {}
    if source in ("point_live", "point_unit"):
        return {
            "matched": Probe(
                pattern=req["tag_pattern"],
                category=req.get("category"),
                device_type=req.get("device_type"),
                role=None,
                require_role=False,
            )
        }
    if source == "point_role":
        out = {
            "bound": Probe(
                pattern=None,
                category=req.get("category"),
                device_type=req.get("device_type"),
                role=req["role"],
                require_role=True,
            )
        }
        candidate = req.get("candidate_tag_pattern")
        if candidate:
            out["candidates"] = Probe(
                pattern=candidate,
                category=req.get("category"),
                device_type=req.get("device_type"),
                role=None,
                require_role=False,
            )
        return out
    return {}


async def run_probes(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    probes: list[Probe],
    *,
    start: dt.datetime,
    end: dt.datetime,
) -> dict[int, list[dict]]:
    """Matched point rows per probe index. An empty list is a real answer.

    The window is a parameter and not a default, because it is the whole basis on
    which a point counts: `reported_in_window` is decided against THIS request's
    span, so asking over 90 days and asking over 7 are different questions and
    are allowed to have different answers.
    """
    if not probes:
        return {}
    params = {
        "tenant": str(tenant) if tenant else None,
        "start": start,
        "end": end,
        "idx": list(range(len(probes))),
        "pattern": [p.pattern for p in probes],
        "category": [p.category for p in probes],
        "device_type": [p.device_type for p in probes],
        "role": [p.role for p in probes],
        "require_role": [p.require_role for p in probes],
    }
    out: dict[int, list[dict]] = {i: [] for i in range(len(probes))}
    for row in _rows(await db.execute(text(_PROBE_SQL), params)):
        # Derived once, here, so no rule below has to remember that "it measured
        # something" is `last_in_window IS NOT NULL` and not `last_seen_at`.
        out[int(row["idx"])].append({**row, "reported_in_window": row["last_in_window"] is not None})
    return out


def reporting(rows: list[dict]) -> list[dict]:
    """The subset that actually measured something inside the window."""
    return [r for r in rows if r.get("reported_in_window")]


# ── The pure rules ───────────────────────────────────────────────────────────

# How many matched points travel back on the response. Enough for an operator to
# recognise the probe and disagree with it; not so many that a screen renders a
# point browser it did not ask for.
SAMPLE_LIMIT = 8


def _sample(rows: list[dict]) -> list[dict]:
    return [
        {
            "point_id": r["point_id"],
            "point_tag": r["point_tag"],
            "device_tag": r["device_tag"],
            "unit": r["unit"],
            "unit_source": r["unit_source"],
            # Both of these, on every sampled point, because "it is bound" and
            # "it is measuring" are different facts and the whole class of bug
            # this file now guards against came from reading one as the other.
            "last_seen_at": r.get("last_seen_at"),
            "reported_in_window": bool(r.get("reported_in_window")),
        }
        for r in rows[:SAMPLE_LIMIT]
    ]


def _silent_since(rows: list[dict]):
    """The most recent thing any of these points ever said. None if none ever did.

    This is what stops `signal_silent` reading as `point_absent` on a screen: an
    operator needs "quiet since the 11th" and not just "quiet".
    """
    seen = [r["last_seen_at"] for r in rows if r.get("last_seen_at") is not None]
    return max(seen) if seen else None


def _silent(rows: list[dict], what: str) -> dict:
    """The verdict for "these are the right points and none of them measured".

    Built once, here, because three resolvers reach it and the evidence it
    carries — how many, since when, and the points themselves — is the entire
    difference between a useful sentence and "no data".
    """
    return {
        "satisfied": False,
        "gap": "signal_silent",
        "gate": (
            f"{len(rows)} {what} on this estate, and not one of them produced a "
            f"reading inside the window"
        ),
        "evidence": {
            "points_matched": len(rows),
            "points_reporting_in_window": 0,
            "silent_since": _silent_since(rows),
            "points": _sample(rows),
        },
    }


def resolve_point_live(matched: list[dict]) -> dict:
    """A point of this shape exists AND measured something in the window."""
    live = reporting(matched)
    if live:
        return {
            "satisfied": True,
            "gap": None,
            "gate": None,
            "evidence": {
                "points_matched": len(matched),
                "points_reporting_in_window": len(live),
                "points": _sample(live),
            },
        }
    if matched:
        return _silent(matched, "point(s) match this signal's shape")
    return {
        "satisfied": False,
        "gap": "point_absent",
        "gate": "no point on this estate matches this signal's shape",
        "evidence": {"points_matched": 0, "points_reporting_in_window": 0, "points": []},
    }


def resolve_point_unit(matched: list[dict], dimension: str | None) -> dict:
    """A confirmed unit turns a number that is ARRIVING into a quantity.

    The order of these checks is the argument. Silence is decided FIRST, among the
    points that match at all, because confirming a unit on a point that has
    stopped reporting buys precisely nothing — the screen would send an operator
    to assert something true about a dead sensor and the correlation would still
    have no data. So `unit_unconfirmed` and `unit_wrong_dimension` are only ever
    said about points that are actually delivering, which is what makes them
    actionable rather than merely correct.

    Four outcomes, four different sentences:
      * nothing matched        → no such sensor (this one costs money);
      * matched, all silent    → the sensor stopped (this one is undetermined);
      * arriving, unconfirmed  → nobody has said what the number is;
      * arriving, confirmed as the wrong quantity → somebody said, and said
        something that is not the kind of quantity this correlation needs.

    A point counts as described when it HAS a unit, whoever recorded it. That
    used to mean `unit_source = 'operator'`, on the argument that a unit off the
    wire is not an assertion anybody made; the gateway is where a person makes
    that assertion now, and it rides every envelope — the same rule
    `app/api/rating.py` follows.
    """
    if not matched:
        return {
            "satisfied": False,
            "gap": "point_absent",
            "gate": "no point on this estate matches this signal's shape",
            "evidence": {"points_matched": 0, "points_reporting_in_window": 0, "points": []},
        }

    live = reporting(matched)
    if not live:
        verdict = _silent(matched, "point(s) match this signal's shape")
        # Said explicitly, because it is the reassuring half and an operator who
        # cannot see it will go and re-do configuration that was never wrong.
        confirmed_but_dead = [r for r in matched if (r["unit"] or "").strip()]
        verdict["evidence"]["points_with_confirmed_unit"] = len(confirmed_but_dead)
        return verdict

    confirmed = [r for r in live if (r["unit"] or "").strip()]
    evidence = {
        "points_matched": len(matched),
        "points_reporting_in_window": len(live),
        "points_with_confirmed_unit": len(confirmed),
        "confirmed_units": sorted({r["unit"] for r in confirmed}),
        "points": _sample(live),
    }

    if dimension is None:
        usable = confirmed
    else:
        usable = [r for r in confirmed if UNIT_DIMENSION.get(r["unit"]) == dimension]
        evidence["dimension_required"] = dimension

    if usable:
        return {"satisfied": True, "gap": None, "gate": None, "evidence": evidence}
    if confirmed:
        # Confirmed, but not as this kind of quantity. Distinct from unconfirmed
        # on purpose: the remedy is to CORRECT an assertion, not to make one.
        return {
            "satisfied": False,
            "gap": "unit_wrong_dimension",
            "gate": (
                f"{len(confirmed)} reporting point(s) carry a confirmed unit, and "
                f"none of them is a {dimension}"
            ),
            "evidence": evidence,
        }
    return {
        "satisfied": False,
        "gap": "unit_unconfirmed",
        "gate": (
            f"{len(live)} point(s) are reporting inside the window, none with a "
            f"unit on record"
        ),
        "evidence": evidence,
    }


def resolve_point_role(bound: list[dict], candidates: list[dict], role: str) -> dict:
    """A role is what a point IS to a question, and only a human says it.

    Same ordering argument as the unit resolver, and on this estate this is the
    case that matters: every role binding here sits on a point that stopped
    reporting days before the window opened. Reporting those as SATISFIED (which
    is what a 30-day retirement horizon did) is a correlation computed over
    nothing; reporting them as `role_unbound` would be worse still, because it
    blames the operator for a binding that is correct.

      * bound AND reporting          → satisfied;
      * bound, none reporting        → the sensor stopped, the binding is fine;
      * unbound, candidates reporting→ one human assertion away (free);
      * unbound, candidates silent   → the sensor stopped, and nothing is bound;
      * neither                      → no such point (costs money).

    Where a role is bound to a silent point and OTHER points of the right shape
    ARE reporting, those candidates ride back in the evidence. That is the shape
    of a gateway rename. This deliberately does NOT assert it is one: the
    candidate probe is not device-scoped, so "an IWT somewhere on this estate is
    alive" is not evidence that it is THIS chiller's IWT — which is exactly the
    inference `app/api/succession.py` refuses to make and this file has no better
    claim to. The operator gets the facts and the succession worklist makes the
    proposal.
    """
    live_bound = reporting(bound)
    if live_bound:
        return {
            "satisfied": True,
            "gap": None,
            "gate": None,
            "evidence": {
                "points_bound": len(bound),
                "points_reporting_in_window": len(live_bound),
                "points": _sample(live_bound),
            },
        }

    live_candidates = reporting(candidates)
    if bound:
        verdict = _silent(bound, f"point(s) are bound to role `{role}`")
        verdict["evidence"]["candidates_reporting_in_window"] = len(live_candidates)
        verdict["evidence"]["candidates"] = _sample(live_candidates)
        if live_candidates:
            verdict["gate"] += (
                f"; {len(live_candidates)} other point(s) matching this signal's "
                f"shape ARE reporting, which may be the same sensor under a new tag"
            )
        return verdict

    evidence = {
        "points_bound": 0,
        "candidates_matched": len(candidates),
        "candidates_reporting_in_window": len(live_candidates),
        "candidates": _sample(live_candidates or candidates),
    }
    if live_candidates:
        return {
            "satisfied": False,
            "gap": "role_unbound",
            "gate": (
                f"no point is bound to role `{role}`; {len(live_candidates)} "
                f"candidate point(s) are reporting inside the window"
            ),
            "evidence": evidence,
        }
    if candidates:
        verdict = _silent(candidates, f"candidate point(s) for role `{role}`")
        verdict["evidence"]["points_bound"] = 0
        return verdict
    return {
        "satisfied": False,
        "gap": "point_absent",
        "gate": f"no point is bound to role `{role}` and none looks like a candidate",
        "evidence": evidence,
    }


# ── Projections: the honest instrument, and the limit of it ──────────────────
#
# THE QUESTION THIS CANNOT ANSWER, STATED BEFORE THE ONE IT CAN.
#
# "How many doors are enrolled?" is a question about `neubit_access.access_doors`,
# and this service may not open that database. Neither may it open
# `neubit_vision.cameras`. That is not squeamishness: a cross-service read is the
# second place a schema drifts, the first being a second writer, and the pipeline
# contract bans it (§1) for the reason `placement_sync.py` sets out at length.
#
# So the enrolment inventory is NOT KNOWABLE here, and this module never pretends
# otherwise. What IS knowable, and is genuinely this store's own:
#
#   1. whether the domain publishes into the reporting store at all —
#      `reporting_projections` holds one row per domain that has registered a
#      spec, and a domain with no row has no read-model here;
#   2. what that domain has actually SAID inside the analysis window — the
#      projected relation, which this store owns outright.
#
# And (2) is the better instrument anyway, which is the part worth being clear
# about. A correlation over a window needs EVENTS IN THAT WINDOW. A hundred
# enrolled doors that badged nobody this week supply exactly as much occupancy
# signal as no doors at all, so "how many are enrolled" was never the question the
# screen needed answered. What the screen needs is "did anything report", and that
# this store can answer for itself.
#
# Hence:
#   * no projection row            → module_population_unknown. The domain is
#     invisible from here and its population is a fact this service does not hold.
#   * projection row, relation not applied yet → also unknown, same reason.
#   * relation present, no rows in window → module_unpopulated. Note the wording
#     of that kind carefully: "has published nothing in the window". It does NOT
#     say zero devices are enrolled, because this store cannot see that and the
#     evidence it carries (`last_event_at`) will frequently prove it false.
#   * rows in window → satisfied.

_PROJ_SPEC_SQL = text(
    """
    SELECT key, name, enabled, spec
      FROM reporting_projections
     WHERE key = ANY(CAST(:keys AS text[]))
    """
)

_RELATION_PRESENT_SQL = text("SELECT to_regclass(:qualified) IS NOT NULL AS present")


def _ident(name: Any, what: str) -> str:
    """A name out of a registered spec, checked before it is quoted into SQL."""
    if not isinstance(name, str) or not IDENT_RE.match(name):
        raise SpecError(f"{what} `{name!r}` is not a plain identifier")
    return name


def projection_relation(spec: dict, key_column: str) -> tuple[str, str]:
    """(relation, time column) out of the registered spec, both ident-checked.

    Read from the SPEC and never from the correlation, deliberately: the
    projection owns its own relation name, and a correlation that carried a copy
    would be a second place to change it — which is how a rename becomes a count
    of zero that nobody can explain.
    """
    target = (spec or {}).get("target") or {}
    relation = _ident(target.get("relation"), "projection relation")
    time_column = _ident(target.get("time_column"), "projection time column")
    # The key column is the correlation's, not the spec's, so it is ident-checked
    # here AND required to be one the projection actually publishes. Counting
    # DISTINCT over a column a domain does not emit is a zero nobody can explain.
    _ident(key_column, "projection key column")
    declared = {c.get("name") for c in (target.get("columns") or [])}
    if key_column not in declared:
        raise SpecError(
            f"projection `{relation}` declares no column `{key_column}`; the "
            f"correlation is counting something the projection does not publish"
        )
    return relation, time_column


def _population_sql(relation: str, time_column: str, key_column: str) -> Any:
    """Counts in the window, plus the last event EVER.

    The all-time `max()` is here so the "nothing in the window" answer can carry
    the thing that stops it being read as "nothing exists": a stream that went
    quiet in August and a stream that never ran look identical without it, and
    only one of them is a device somebody needs to go and look at.

    Deliberately no all-time row COUNT: on a five-year hypertable that is a scan,
    and a number nobody needed is not worth one.
    """
    return text(
        f"""
        SELECT count(*) FILTER (WHERE {time_column} >= :start AND {time_column} < :end)
                   AS rows_in_window,
               count(DISTINCT {key_column})
                   FILTER (WHERE {time_column} >= :start AND {time_column} < :end)
                   AS keys_in_window,
               max({time_column}) AS last_event_at
          FROM {relation}
         WHERE (CAST(:tenant AS uuid) IS NULL OR tenant_id = CAST(:tenant AS uuid))
        """
    )


async def projection_population(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    projection_key: str,
    key_column: str,
    specs: dict[str, dict],
    start: dt.datetime,
    end: dt.datetime,
) -> dict:
    """What this store knows about one domain's traffic. `known=False` is a result."""
    row = specs.get(projection_key)
    if row is None:
        return {"known": False, "reason": "not_registered", "projection": projection_key}
    if not row["enabled"]:
        # Registered but switched off: the relation may exist and be stale, so
        # counting it would report a window the projector was not filling.
        return {"known": False, "reason": "disabled", "projection": projection_key}

    relation, time_column = projection_relation(row["spec"], key_column)
    present = _rows(await db.execute(_RELATION_PRESENT_SQL, {"qualified": f"public.{relation}"}))
    if not present or not present[0]["present"]:
        return {"known": False, "reason": "relation_absent", "projection": projection_key}

    stats = _rows(
        await db.execute(
            _population_sql(relation, time_column, key_column),
            {"tenant": str(tenant) if tenant else None, "start": start, "end": end},
        )
    )[0]
    return {
        "known": True,
        "projection": projection_key,
        "relation": relation,
        "rows_in_window": int(stats["rows_in_window"] or 0),
        "distinct_keys_in_window": int(stats["keys_in_window"] or 0),
        "last_event_at": stats["last_event_at"],
    }


def resolve_projection(population: dict, label: str) -> dict:
    """Satisfied / unpopulated / unknown — and never unpopulated when unknown."""
    if not population["known"]:
        reason = {
            "not_registered": (
                f"no `{population['projection']}` projection is registered in the "
                f"reporting store, so whether any {label} exists is not knowable "
                f"from this service — its inventory lives in a database this "
                f"service is not permitted to read"
            ),
            "disabled": (
                f"the `{population['projection']}` projection is registered but "
                f"disabled, so its relation is not being filled and its contents "
                f"say nothing about the window"
            ),
            "relation_absent": (
                f"the `{population['projection']}` projection is registered but its "
                f"relation has not been applied yet"
            ),
        }[population["reason"]]
        return {
            "satisfied": False,
            "gap": "module_population_unknown",
            "gate": reason,
            "evidence": {"known": False, "reason": population["reason"]},
        }

    evidence = {
        "known": True,
        "relation": population["relation"],
        "rows_in_window": population["rows_in_window"],
        "distinct_keys_in_window": population["distinct_keys_in_window"],
        "last_event_at": population["last_event_at"],
    }
    if population["rows_in_window"] > 0:
        return {"satisfied": True, "gap": None, "gate": None, "evidence": evidence}
    # NOT "there are no doors". The sentence is about traffic, and the evidence
    # beside it carries the last event ever seen precisely so a reader can tell
    # "never ran" from "went quiet".
    return {
        "satisfied": False,
        "gap": "module_unpopulated",
        "gate": (
            f"the `{population['projection']}` projection is registered and has "
            f"published no event in the window"
        ),
        "evidence": evidence,
    }


# ── Site facts ───────────────────────────────────────────────────────────────

_EMISSION_FACTOR_SQL = text(
    """
    SELECT count(*) AS recorded,
           count(*) FILTER (WHERE btrim(source) <> '') AS cited
      FROM site_emission_factors
     WHERE (CAST(:tenant AS uuid) IS NULL OR tenant_id = CAST(:tenant AS uuid))
    """
)

_FACT_LABEL = {
    "emission_factor": "a grid emission factor (kg CO₂ per kWh), with the source it came from"
}


async def site_fact_state(db: AsyncSession, tenant: uuid.UUID | None, fact: str) -> dict:
    if fact != "emission_factor":  # pragma: no cover — validate_signal got here first
        raise SpecError(f"no resolver for site fact `{fact}`")
    row = _rows(await db.execute(_EMISSION_FACTOR_SQL, {"tenant": str(tenant) if tenant else None}))[0]
    return {"fact": fact, "recorded": int(row["recorded"] or 0), "cited": int(row["cited"] or 0)}


def resolve_site_fact(state: dict) -> dict:
    """Recorded AND cited, or it is not a fact this platform will divide by."""
    evidence = {"recorded": state["recorded"], "cited": state["cited"]}
    if state["cited"] > 0:
        return {"satisfied": True, "gap": None, "gate": None, "evidence": evidence}
    label = _FACT_LABEL[state["fact"]]
    if state["recorded"] > 0:
        return {
            "satisfied": False,
            "gap": "site_fact_uncited",
            "gate": f"{label} is recorded, with no source named",
            "evidence": evidence,
        }
    return {
        "satisfied": False,
        "gap": "site_fact_unrecorded",
        "gate": f"nobody has recorded {label}",
        "evidence": evidence,
    }


# ── Assembly ─────────────────────────────────────────────────────────────────


def _signal_out(signal: dict, verdict: dict) -> dict:
    """One signal's answer, with the gap kind expanded into its sentences."""
    gap = None
    if verdict["gap"] is not None:
        kind = GAP_KINDS[verdict["gap"]]
        gap = {
            "kind": kind.key,
            "needs_new_hardware": kind.needs_new_hardware,
            "summary": kind.summary,
            "remedy": kind.remedy,
            "where": kind.where,
            "gate": verdict["gate"],
        }
    return {
        "key": signal["key"],
        "label": signal.get("label") or signal["key"],
        "domain": signal.get("domain"),
        "source": signal["source"],
        "unlocks": signal.get("unlocks"),
        "satisfied": verdict["satisfied"],
        "gap": gap,
        "evidence": verdict["evidence"],
    }


def assemble(definition: dict, signals_out: list[dict]) -> dict:
    """One correlation's row on the screen.

    `state` is LIVE or BLOCKED and there is no third value. Nothing here is
    "partial", "estimated" or scored out of ten: either every signal the question
    needs is present, in which case ask it, or it has named gaps.

    `blocking_gap` is the FIRST unsatisfied signal in declaration order. The order
    is part of the spec (migration 0025's header says so), so which remedy a
    screen leads with is a decision somebody made in a reviewable file, not an
    accident of a dict's iteration order or an opinion this function invented.
    """
    blocked = [s for s in signals_out if not s["satisfied"]]
    return {
        "key": definition["key"],
        "version": definition["version"],
        "name": definition["name"],
        "question": definition["question"],
        "unlocks": definition["unlocks"],
        "domains": definition["domains"],
        "scope": "tenant" if definition["tenant_id"] is not None else "platform",
        "effective_from": definition["effective_from"],
        "state": "blocked" if blocked else "live",
        "signals": signals_out,
        "blocking_gap": (
            {"signal": blocked[0]["key"], **blocked[0]["gap"]} if blocked else None
        ),
    }


def totals(correlations: list[dict]) -> dict:
    """The arithmetic a screen must not have to do.

    The headline it exists to support is "7 gaps · 0 need new hardware", and the
    only way that sentence is honest is if UNDETERMINED is counted apart from NO.
    So there are three buckets, never two, and `no_new_hardware_needed` counts
    only gaps whose kind actually says False.

    Two populations are reported because two different sentences want them:
      * `blocking_*`  one per blocked correlation — the thing to fix FIRST, and
        what the headline counts;
      * `signal_*`    every unsatisfied signal, which is the real size of the
        backlog and is never smaller.
    """
    blocking = [c["blocking_gap"] for c in correlations if c["blocking_gap"]]
    every = [s["gap"] for c in correlations for s in c["signals"] if s["gap"]]

    def by_kind(gaps: list[dict]) -> dict[str, int]:
        out: dict[str, int] = {}
        for gap in gaps:
            out[gap["kind"]] = out.get(gap["kind"], 0) + 1
        return dict(sorted(out.items()))

    def hardware(gaps: list[dict]) -> tuple[int, int, int]:
        yes = sum(1 for g in gaps if g["needs_new_hardware"] is True)
        no = sum(1 for g in gaps if g["needs_new_hardware"] is False)
        unknown = sum(1 for g in gaps if g["needs_new_hardware"] is None)
        return yes, no, unknown

    yes, no, unknown = hardware(blocking)
    s_yes, s_no, s_unknown = hardware(every)
    return {
        "correlations": len(correlations),
        "live": sum(1 for c in correlations if c["state"] == "live"),
        "blocked": sum(1 for c in correlations if c["state"] == "blocked"),
        "blocking_gaps": len(blocking),
        "blocking_gaps_by_kind": by_kind(blocking),
        "needs_new_hardware": yes,
        "no_new_hardware_needed": no,
        "hardware_undetermined": unknown,
        "signal_gaps": len(every),
        "signal_gaps_by_kind": by_kind(every),
        "signal_gaps_needing_new_hardware": s_yes,
        "signal_gaps_needing_no_new_hardware": s_no,
        "signal_gaps_hardware_undetermined": s_unknown,
    }


async def resolve_all(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    start: dt.datetime,
    end: dt.datetime,
) -> list[dict]:
    """Every correlation this caller can see, resolved against this estate."""
    definitions = await load_definitions(db, tenant)
    for definition in definitions:
        for signal in definition["signals"]:
            validate_signal(signal)

    # Plan every point probe first, so they all travel in one statement.
    probes: list[Probe] = []
    plan: list[dict[str, int]] = []
    for definition in definitions:
        for signal in definition["signals"]:
            mapping: dict[str, int] = {}
            for name, probe in probes_for(signal).items():
                mapping[name] = len(probes)
                probes.append(probe)
            plan.append(mapping)
    matched = await run_probes(db, tenant, probes, start=start, end=end)

    projection_keys = sorted(
        {
            s["requires"]["projection_key"]
            for d in definitions
            for s in d["signals"]
            if s["source"] == "projection"
        }
    )
    specs = {
        r["key"]: r
        for r in (
            _rows(await db.execute(_PROJ_SPEC_SQL, {"keys": projection_keys}))
            if projection_keys
            else []
        )
    }

    # Population and site facts are cached per distinct need: three correlations
    # share the access door stream, and asking the same relation three times
    # would be three scans for one answer.
    population_cache: dict[tuple[str, str], dict] = {}
    fact_cache: dict[str, dict] = {}

    out: list[dict] = []
    step = iter(plan)
    for definition in definitions:
        signals_out: list[dict] = []
        for signal in definition["signals"]:
            mapping = next(step)
            req = signal.get("requires") or {}
            source = signal["source"]
            if source == "point_live":
                verdict = resolve_point_live(matched.get(mapping["matched"], []))
            elif source == "point_unit":
                verdict = resolve_point_unit(
                    matched.get(mapping["matched"], []), req.get("dimension")
                )
            elif source == "point_role":
                verdict = resolve_point_role(
                    matched.get(mapping["bound"], []),
                    matched.get(mapping["candidates"], []) if "candidates" in mapping else [],
                    req["role"],
                )
            elif source == "projection":
                cache_key = (req["projection_key"], req["key_column"])
                if cache_key not in population_cache:
                    population_cache[cache_key] = await projection_population(
                        db,
                        tenant,
                        projection_key=req["projection_key"],
                        key_column=req["key_column"],
                        specs=specs,
                        start=start,
                        end=end,
                    )
                verdict = resolve_projection(
                    population_cache[cache_key], signal.get("label") or signal["key"]
                )
            else:  # site_fact — the vocabulary is closed and validated above
                if req["fact"] not in fact_cache:
                    fact_cache[req["fact"]] = await site_fact_state(db, tenant, req["fact"])
                verdict = resolve_site_fact(fact_cache[req["fact"]])
            signals_out.append(_signal_out(signal, verdict))
        out.append(assemble(definition, signals_out))
    return out
