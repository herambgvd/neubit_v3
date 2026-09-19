"""Role succession — following an operator's binding across a gateway RENAME.

THE GAP, MEASURED ON THIS DEPLOYMENT
------------------------------------
`neubit_reporting.point_roles` holds 20 rows, and 19 of them join to a `points`
row. COUNT BOTH WAYS OR THE NUMBER IS WRONG: this header said "19 rows" until
2026-09-19, because the query behind it joined `points` — which is the same
INNER JOIN the orphans worklist used to do, and it silently dropped the one row
whose point row no longer exists at all. Stating the joined count as the table's
size documented the blind spot as if it were the estate.

    select count(*) from point_roles;                                  -- 20
    select count(*) from point_roles r join points p using (point_id);  -- 19

Of the 19 that join, not one is on a point that is still reporting: every one was
last seen on 5 or 11 September, while the devices they sit on are still
delivering through other tags. An operator did the binding work, a gateway
rebuild invalidated all of it, and nothing said so — Building Intelligence has
been refusing at gate 4 ever since with no screen that explains why. The 20th
(`3089f793-…` / `outlet_water_temp`) is worse and is dealt with under `forget`
below: its point is not merely dead, there is no row for it.

WHY GHOST COLLAPSE DOES NOT ALREADY COVER IT
--------------------------------------------
`queries.ghost_groups` groups on `(device_tag, point_tag)`. That is the right key
for the case it was built for — a connection rebuilt under the SAME tags, which
mints new ids and nothing else. The dead roles are not in those groups, because
the rebuild renamed the TAG as well as re-keying the id:

    device `1F York Chiller01`
      point_tag `IWT`                degC, the role is bound here, dead since 5 Sep
      point_tag `1FYorkChiller1_IWT` dead since 5 Sep
      point_tag `1FYC1_IWT`          reporting, no role, no unit

Three generations of one physical sensor under three different tags. Different
`point_tag`, so not a duplicate, so the collapse can never reach them. That gap
is what this module is.

The two features share the `superseded_by` chain (0024) and the reconcile that
carries a role across it (`reporting.role_succession`), so a repoint and a
collapse produce the same kind of record and the same kind of history. They stay
separate in what they DO: a collapse retires the generations it superseded,
because a duplicated tag with several live rows is inflating every estate count.
A repoint writes no retirement at all — a renamed generation stops being counted
by the `last_seen_at` horizon on its own, and retiring it here would be a second
decision the operator did not make.

THE RULE THAT SHAPES EVERYTHING BELOW
--------------------------------------
**Nothing auto-applies.** `orphan_roles()` SCORES and PROPOSES; only
`repoint_roles()` writes, and only over ids a human named. There is deliberately
no confidence threshold above which this module binds a role on its own, and no
place to put one — `units.py` says the same thing about units and the reason is
stronger here. A role is a statement about what a number MEANS: bind
`inlet_water_temp` to the wrong tag and ΔT, kW/TR and every rating above them
still compute, plausibly, and wrongly. A refusal is visible; a plausible wrong
answer is not.

**A candidate is on the SAME device.** Cross-device matching is a different and
much riskier feature — `IWT` exists on every chiller in the building, and a
scorer allowed to roam would happily propose 2F's sensor for 1F's role. It is out
of scope here and should stay out until there is something better than a tag to
join on.

WHAT "STILL REPORTING" MEANS HERE, AND WHY IT IS NOT `FRESH_MINUTES`
---------------------------------------------------------------------
The obvious definition — a role is orphaned when its point is outside the
15-minute freshness window — does not survive contact with this deployment. At
the time of writing, `max(points.last_seen_at)` is ~4.8 hours old across the
whole estate: ingest is between runs, and ZERO of the 766 live points are fresh.
Under that definition every role is orphaned AND no candidate is live, so the
feature would propose nothing, on exactly the estate it exists for — while a
gateway that happened to be mid-cycle would make the same screen propose
everything. A worklist whose contents depend on whether ingest is running this
minute is not a worklist.

So the comparison is against the DEVICE'S OWN CLOCK:

    device_last_seen_at  = max(last_seen_at) over the device's unretired points

A point is at its device's LEADING EDGE when it reported within
`SUCCESSION_GRACE_MINUTES` of that maximum, and a role is ORPHANED when its point
is not. That is a statement about the rename and nothing else: this device is
still talking, through other tags, and the tag the role is bound to has gone
quiet. It is stable across an ingest outage — when a whole device goes dark its
role point is still at the leading edge, so nothing is proposed, which is right,
because nothing replaced it. `fresh` (the absolute 15-minute window) is still
reported on every row, because an operator should see that the estate is between
runs; it just does not decide anything.
"""

from __future__ import annotations

import re
import uuid

from reporting.role_succession import inherit_roles
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..metric_registry.roles import ROLE_DEFS, suggest
from ..metric_registry.units import UNIT_DIMENSION
from .queries import FRESH_MINUTES, _rows

# How close to its device's newest reading a point has to be to count as being at
# the LEADING EDGE. Reused from the freshness window rather than invented: the
# live gateway publishes on a ~5 minute cycle, so 15 minutes is three missed
# cycles — long enough that a point which merely landed in a different batch is
# not called dead, short enough that a tag abandoned in a rebuild shows up on the
# first worklist after it.
SUCCESSION_GRACE_MINUTES = FRESH_MINUTES


# ── The device clock ─────────────────────────────────────────────────────────
#
# Repeated verbatim in both statements below rather than factored into a view: a
# CTE is cheap, and the alternative is a second place where "when did this device
# last report" could be defined slightly differently from the first. The orphan
# set and the candidate set MUST agree about the leading edge, or a point could
# be too stale to keep its role and too stale to receive one at the same time.
_CLOCK_CTE = """
    clock AS (
        SELECT p.tenant_id,
               p.device_tag,
               max(p.last_seen_at) AS device_last_seen_at
          FROM points p
         WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
           AND p.retired_at IS NULL
           AND p.device_tag IS NOT NULL
         GROUP BY p.tenant_id, p.device_tag
    )
"""

# Every `point_roles` row whose point has stopped carrying the measurement.
#
# TWO of the three ways to be orphaned, and they are reported apart because they
# are different facts about the building (the third — no `points` row at all —
# cannot be reached from a statement that joins `points`, and has its own below):
#
#   `superseded`  the point is behind its device's leading edge. The device is
#                 still delivering, through other tags; this one was renamed
#                 away. All 19 of the rows that join `points` are this.
#   `retired`     the point is retired. A retired point is not part of the estate,
#                 so a role on it cannot be selecting anything — whether it was
#                 retired by hand or by a ghost collapse that could not move the
#                 role. It is included with no device-clock test at all, because
#                 "retired" already settles it.
#
# A role on a point with NO device tag is unreachable here and that is stated
# rather than hidden: without a device there is no candidate set, because the
# same-device rule is the whole of the safety. Those rows come back with an empty
# candidate list like any other orphan with nothing credible beside it.
_ORPHAN_ROLES_SQL = text(
    """
    WITH """ + _CLOCK_CTE + """
    SELECT r.role,
           r.role_source,
           r.confirmed_by,
           r.confirmed_at,
           p.point_id,
           p.device_tag,
           p.point_tag,
           p.unit,
           p.type,
           p.category,
           p.last_seen_at,
           p.retired_at IS NOT NULL                                AS retired,
           p.last_seen_at >= now() - make_interval(mins => :fresh)  AS fresh,
           c.device_last_seen_at
      FROM point_roles r
      JOIN points p ON p.point_id = r.point_id
      LEFT JOIN clock c
             ON c.tenant_id = p.tenant_id
            AND c.device_tag = p.device_tag
     WHERE (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
       AND (
             p.retired_at IS NOT NULL
             OR (
                 c.device_last_seen_at IS NOT NULL
                 AND p.last_seen_at
                     < c.device_last_seen_at - make_interval(mins => :grace)
             )
           )
     ORDER BY p.device_tag NULLS LAST, r.role, p.point_tag
    """
)

# The THIRD way to be orphaned, and the only one the statement above can never
# see: there is no `points` row at all.
#
# `point_roles` has no foreign key to `points` — the two are written by different
# paths (the writer upserts the dimension, an operator confirms the role) and a
# role can be recorded against an id the dimension row for which is later DELETED
# outright. On this deployment exactly one of the 20 rows is in that state:
#
#     3089f793-22e7-47bc-afed-cf0db4fbf355 | outlet_water_temp
#
# which is why `select count(*) from point_roles` says 20 and the same count
# joined to `points` says 19. It is the most orphaned assertion on the estate — a
# human stated what a number means and the thing it meant is not merely retired,
# it is GONE — and until this statement existed it was the one row the orphans
# worklist could never show, because that worklist INNER JOINs the dimension.
#
# There is nothing to score. Every column the scorer reads (`device_tag`,
# `point_tag`, `unit`, `type`) lives on the row that no longer exists, and the
# same-device rule is the whole of the safety here — with no device there is no
# candidate set, and a search that roamed for a tag it cannot even read would be
# inventing a successor rather than proposing one. So this returns the assertion
# and nothing else, and the only honest action on it is `forget_roles` below.
#
# Scoped by `point_roles.tenant_id`, which is the only tenant column left: the
# point's own is gone with the point.
_MISSING_POINT_ROLES_SQL = text(
    """
    SELECT r.role,
           r.role_source,
           r.confirmed_by,
           r.confirmed_at,
           r.point_id
      FROM point_roles r
      LEFT JOIN points p ON p.point_id = r.point_id
     WHERE (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
       AND p.point_id IS NULL
     ORDER BY r.role, r.confirmed_at
    """
)

# Every point at the leading edge of one of the affected devices.
#
# This is the candidate POOL, not the proposal: everything here is scored in
# Python and most of it scores nothing. Returning the pool rather than only the
# winners is what lets the endpoint say "11 live points on this device, none of
# them credible" instead of an empty list that reads like a missing feature.
#
# `current_role` comes back on every row so the operator sees a conflict BEFORE
# they choose — `point_roles` is keyed by `point_id` alone, so a candidate that
# already carries a different role cannot take this one and the repoint will
# refuse it.
_LEADING_EDGE_SQL = text(
    """
    WITH """ + _CLOCK_CTE + """
    SELECT p.point_id,
           p.device_tag,
           p.point_tag,
           p.unit,
           p.type,
           p.category,
           p.last_seen_at,
           p.last_seen_at >= now() - make_interval(mins => :fresh) AS fresh,
           c.device_last_seen_at,
           r.role AS current_role
      FROM points p
      JOIN clock c
        ON c.tenant_id = p.tenant_id
       AND c.device_tag = p.device_tag
      LEFT JOIN point_roles r ON r.point_id = p.point_id
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND p.retired_at IS NULL
       AND p.device_tag = ANY(CAST(:devices AS text[]))
       AND p.last_seen_at >= c.device_last_seen_at - make_interval(mins => :grace)
     ORDER BY p.device_tag, p.point_tag
    """
)


# ── Scoring ──────────────────────────────────────────────────────────────────
#
# WHAT THIS IS AND IS NOT. It is a ranking of the candidates a human will read,
# with every signal it used shown beside it in words. It is not a decision, it is
# not a probability, and the numbers are not calibrated against anything — they
# are an ORDER. Two candidates half a point apart are two candidates a human has
# to look at, and the endpoint says so by returning both.
#
# The signals, and why each one is evidence rather than a guess:
#
#   identical_tag     the tag did not change at all, only the id. This is the
#                     rebuild-without-rename case, which ghost collapse also sees
#                     as a duplicate — the strongest thing a tag can say.
#   measurement_tail  the last token of the two tags is the same. This estate
#                     PREFIXES device identity onto the measurement and leaves
#                     the measurement at the tail (`IWT`, `1FYorkChiller1_IWT`,
#                     `1FYC1_IWT`), which is the same observation `units.py`
#                     builds its whole catalogue on. This is the POSITION signal.
#   role_convention   this estate's own role conventions (`metric_registry.roles`)
#                     read the candidate's tag as THE ROLE BEING MOVED. It is the
#                     one signal tied to the role rather than to string shape, and
#                     it is reused rather than restated so a convention is only
#                     ever written down once.
#   shared_token      the tags share a token that is not device identity. Weak,
#                     and it exists for the reorder case (`IWT_1F` → `1F_IWT`).
#                     Device-identity tokens are excluded by counting: a token on
#                     most of the device's tags identifies the DEVICE, and every
#                     candidate has it, so it separates nothing.
#   unit_match        the candidate carries the same confirmed unit. Corroborating
#                     only — every temperature point on a chiller reads degC.
#   dimension_match   the candidate's unit is at least of the role's dimension.
#                     Weaker still, and it is here to make "this candidate is in
#                     kWh and the role wants a temperature" visible as an ABSENCE.
#
# WHAT IS DELIBERATELY NOT A SIGNAL: recency. "The candidate that reported most
# recently" is not evidence about which sensor it is — every point on a live
# device reported recently — and scoring it would dress the newest row up as the
# right one. Ties are broken alphabetically, which is arbitrary and looks it.
_W_IDENTICAL_TAG = 100
_W_MEASUREMENT_TAIL = 60
_W_ROLE_CONVENTION = 50
_W_SHARED_TOKEN = 30
_W_UNIT_MATCH = 25
_W_DIMENSION_MATCH = 15

# A candidate is CREDIBLE only if at least one of these fired. The rest corroborate
# and cannot carry a proposal on their own: a candidate whose only evidence is
# "same unit" is every other temperature point on the chiller, and proposing one
# of those would be picking a sensor out of a hat with a score printed on it.
_CREDIBLE_SIGNALS = ("identical_tag", "measurement_tail", "role_convention")

# The fraction of a device's tags a token has to appear on before it is read as
# DEVICE IDENTITY rather than as measurement. Half is deliberately generous:
# `1FYC1` is on nearly every tag of its device, and the cost of being wrong in
# this direction is only that a weak signal does not fire.
_IDENTITY_TOKEN_SHARE = 0.5


def _tokens(tag: str | None) -> list[str]:
    """A tag split into lowercase alphanumeric tokens, in order.

    Separator-based only. No camel-case splitting: `TodayKWH` is one word on this
    estate and `1FYorkChiller1` is not three, and a splitter confident enough to
    take either apart would also take apart the tags it should not.
    """
    if not tag:
        return []
    return [t for t in re.split(r"[^A-Za-z0-9]+", tag.strip().lower()) if t]


def _tail(tag: str | None) -> str | None:
    tokens = _tokens(tag)
    return tokens[-1] if tokens else None


def _identity_tokens(tags: list[str | None]) -> set[str]:
    """Tokens common enough across a device's tags to be naming the DEVICE.

    Counted rather than pattern-matched, because the pattern differs per gateway
    build — `1FYC1_`, `1FYorkChiller1_`, `1F-York Chiller-1 ` are the same device
    over three rebuilds and no regex was going to cover the next one.
    """
    if len(tags) < 2:
        return set()
    counts: dict[str, int] = {}
    for tag in tags:
        for token in set(_tokens(tag)):
            counts[token] = counts.get(token, 0) + 1
    floor = max(2, int(len(tags) * _IDENTITY_TOKEN_SHARE))
    return {token for token, n in counts.items() if n >= floor}


def _evidence(kind: str, weight: int, detail: str) -> dict:
    return {"kind": kind, "weight": weight, "detail": detail}


def score_candidate(orphan: dict, candidate: dict, identity: set[str]) -> dict:
    """Score one candidate against one orphaned role, showing its working.

    Pure. Returns `{score, credible, evidence}` where `evidence` is the list of
    signals that fired, each with the weight it contributed and a sentence a
    human can check. A signal that did not fire is simply absent — an evidence
    list padded with zeroes would bury the two lines that matter.
    """
    o_tag = orphan.get("point_tag")
    c_tag = candidate.get("point_tag")
    role = orphan.get("role")
    evidence: list[dict] = []

    o_tokens, c_tokens = _tokens(o_tag), _tokens(c_tag)
    o_tail, c_tail = _tail(o_tag), _tail(c_tag)

    if o_tag and c_tag and o_tag.strip().lower() == c_tag.strip().lower():
        evidence.append(_evidence(
            "identical_tag", _W_IDENTICAL_TAG,
            f"the tag is unchanged — `{c_tag}` is spelled exactly as the tag the "
            f"role is bound to, so the rebuild re-keyed the point without "
            f"renaming it",
        ))
    elif o_tail and c_tail and o_tail == c_tail:
        evidence.append(_evidence(
            "measurement_tail", _W_MEASUREMENT_TAIL,
            f"both tags end in `{c_tail}` — this estate prefixes device identity "
            f"onto the measurement and leaves the measurement last, so the tail "
            f"is what survives a rename",
        ))

    # The role conventions, asked of the whole tag AND of its tail. The tail is
    # asked because the rules in `metric_registry.roles` are anchored to a bare
    # measurement (`^iwt$`), which a prefixed tag never matches — and the prefix
    # is device identity, which the rule was never about.
    for probe, how in ((c_tag, "the tag"), (c_tail, "the tag's last token")):
        hit = suggest(probe, candidate.get("type"))
        if hit and hit["role"] == role:
            evidence.append(_evidence(
                "role_convention", _W_ROLE_CONVENTION,
                f"{how} reads as `{role}` by this estate's own role convention: "
                f"{hit['basis']}",
            ))
            break

    shared = (set(o_tokens) & set(c_tokens)) - identity - {o_tail}
    if shared:
        listed = ", ".join(f"`{t}`" for t in sorted(shared))
        evidence.append(_evidence(
            "shared_token", _W_SHARED_TOKEN,
            f"the tags share {listed}, which is not part of this device's own "
            f"naming and so is describing the measurement",
        ))

    o_unit, c_unit = orphan.get("unit"), candidate.get("unit")
    if o_unit and c_unit and o_unit == c_unit:
        evidence.append(_evidence(
            "unit_match", _W_UNIT_MATCH,
            f"both carry the confirmed unit `{c_unit}`",
        ))
    elif c_unit and role in ROLE_DEFS:
        wanted = ROLE_DEFS[role]["dimension"]
        if UNIT_DIMENSION.get(c_unit) == wanted:
            evidence.append(_evidence(
                "dimension_match", _W_DIMENSION_MATCH,
                f"its unit `{c_unit}` is a {wanted}, which is the dimension "
                f"`{role}` is defined to carry",
            ))

    kinds = {e["kind"] for e in evidence}
    return {
        "score": sum(e["weight"] for e in evidence),
        "credible": bool(kinds & set(_CREDIBLE_SIGNALS)),
        "evidence": evidence,
    }


def _candidate_view(candidate: dict, scored: dict) -> dict:
    return {
        "point_id": candidate["point_id"],
        "point_tag": candidate["point_tag"],
        "unit": candidate["unit"],
        "last_seen_at": candidate["last_seen_at"],
        "fresh": bool(candidate["fresh"]),
        "score": scored["score"],
        "evidence": scored["evidence"],
        # Named `conflicting_role` rather than `role` on purpose: it is the reason
        # `repoint` will refuse this candidate, not a property the screen should
        # render as "this point's role" beside a proposal to change it.
        "conflicting_role": candidate.get("current_role"),
    }


async def orphan_roles(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    role: str | None = None,
) -> dict:
    """Every orphaned role, with its scored successors on the SAME device.

    Three statements, not one: the orphans, the roles whose point row is gone
    entirely, then the leading edge of the devices
    they sit on. Scoring in Python rather than in SQL is what lets the evidence be
    a sentence — a score computed in a CASE expression can be returned but it
    cannot be explained, and an unexplained number is exactly what an operator
    must not act on.

    `role` filters the RESULT to one role name. It cannot change any candidate
    set, because candidates are a property of the device.

    Tenant-scoped in both statements, and the candidate pool is computed INSIDE
    the tenant — so another tenant's point is not a candidate for the same reason
    it is not a ghost-group member: it is not in the rows.
    """
    params = {
        "tenant": str(tenant) if tenant else None,
        "fresh": FRESH_MINUTES,
        "grace": SUCCESSION_GRACE_MINUTES,
    }
    orphans = _rows(await db.execute(_ORPHAN_ROLES_SQL, params))
    missing = _rows(await db.execute(_MISSING_POINT_ROLES_SQL,
                                     {"tenant": params["tenant"]}))
    if role is not None:
        orphans = [o for o in orphans if o["role"] == role]
        missing = [m for m in missing if m["role"] == role]

    devices = sorted({o["device_tag"] for o in orphans if o["device_tag"]})
    pool: list[dict] = []
    if devices:
        pool = _rows(
            await db.execute(_LEADING_EDGE_SQL, {**params, "devices": devices})
        )

    by_device: dict[str, list[dict]] = {}
    for row in pool:
        by_device.setdefault(row["device_tag"], []).append(row)

    out: list[dict] = []
    for orphan in orphans:
        siblings = [
            c for c in by_device.get(orphan["device_tag"] or "", [])
            if c["point_id"] != orphan["point_id"]
            # A `txt` point cannot carry a numeric role and vice versa. This is a
            # hard exclusion rather than a negative score: it is not weak
            # evidence, it is a different kind of value, and a scorer that can be
            # talked round to it by three string matches is one bad tag away from
            # binding a status flag into a chiller efficiency.
            and c["type"] == orphan["type"]
        ]
        identity = _identity_tokens(
            [orphan["point_tag"]] + [c["point_tag"] for c in siblings]
        )
        scored = []
        for candidate in siblings:
            result = score_candidate(orphan, candidate, identity)
            if result["credible"]:
                scored.append(_candidate_view(candidate, result))
        # Score first, then the tag alphabetically. The second key is arbitrary
        # AND LOOKS IT, which is the intent: a tie is a question for a human, and
        # ordering ties by `last_seen_at` would quietly answer it with "whichever
        # reported last", which is not evidence about anything.
        scored.sort(key=lambda c: (-c["score"], c["point_tag"] or ""))
        out.append(
            {
                "role": orphan["role"],
                "role_source": orphan["role_source"],
                "confirmed_by": orphan["confirmed_by"],
                "confirmed_at": orphan["confirmed_at"],
                "point_id": orphan["point_id"],
                "device_tag": orphan["device_tag"],
                "point_tag": orphan["point_tag"],
                "unit": orphan["unit"],
                "category": orphan["category"],
                "last_seen_at": orphan["last_seen_at"],
                "fresh": bool(orphan["fresh"]),
                "device_last_seen_at": orphan["device_last_seen_at"],
                "orphan_reason": "retired" if orphan["retired"] else "superseded",
                # How many points were LOOKED AT, so "no successor found" reads as
                # a considered answer rather than as an empty screen.
                "candidates_considered": len(siblings),
                "candidates": scored,
            }
        )

    # The roles with no point at all, LAST and with every point-shaped field
    # stated as null rather than omitted. Omitting them would make a screen that
    # reads `point_tag` fail on these rows alone; null says "there is no row to
    # read it from", which is the fact. `candidates_considered = 0` is likewise
    # the truth and not a placeholder: nothing was looked at, because with no
    # device tag there is nothing that could have been looked at.
    #
    # They sort after the device-tagged orphans for the same reason the statement
    # above puts NULL device tags last — a worklist reads device by device, and a
    # row that belongs to no device belongs at the end of it.
    out.extend(
        {
            "role": m["role"],
            "role_source": m["role_source"],
            "confirmed_by": m["confirmed_by"],
            "confirmed_at": m["confirmed_at"],
            "point_id": m["point_id"],
            "device_tag": None,
            "point_tag": None,
            "unit": None,
            "category": None,
            "last_seen_at": None,
            "fresh": False,
            "device_last_seen_at": None,
            "orphan_reason": "point_missing",
            "candidates_considered": 0,
            "candidates": [],
        }
        for m in missing
    )

    # The three counts are computed over `out` AFTER the missing-point rows joined
    # it, so they cannot disagree with the list they describe: `total` is the
    # length of `orphans`, and `with_candidates + without_candidates` is `total`.
    # A missing-point row is always in `without_candidates` — there is no
    # candidate set for it and there never will be.
    return {
        "orphans": out,
        "total": len(out),
        "with_candidates": sum(1 for o in out if o["candidates"]),
        "without_candidates": sum(1 for o in out if not o["candidates"]),
        "fresh_minutes": FRESH_MINUTES,
        "grace_minutes": SUCCESSION_GRACE_MINUTES,
    }


# ── Applying one move ────────────────────────────────────────────────────────

# Both endpoints of a move, with whatever role each currently carries, read in ONE
# statement and inside the tenant. A point the caller cannot see simply does not
# come back, and "I could not find it" and "it is not yours" are the same refusal
# — which is what stops the route from being a probe for other tenants' point ids.
_MOVE_ENDPOINTS_SQL = text(
    """
    SELECT p.point_id,
           p.device_tag,
           p.point_tag,
           p.last_seen_at,
           p.retired_at IS NOT NULL AS retired,
           p.superseded_by,
           r.role AS current_role
      FROM points p
      LEFT JOIN point_roles r ON r.point_id = p.point_id
     WHERE p.point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
    """
)

# The succession record, and ONE column.
#
# `retired_at` and `retire_reason` are deliberately untouched, which is the one
# place this diverges visibly from the ghost collapse. A collapse retires because
# a duplicated tag with several unretired rows inflates every estate count and
# the operator confirmed which one is real. A rename does not have that problem:
# the old generation stops being counted by the `last_seen_at` horizon on its own,
# on the same schedule as every other dead address. Retiring it here would be a
# second decision, made by this route, that the operator never asked for — and
# `retire_reason = 'ghost'` in particular would put the row inside the reach of
# `POST /points/ghosts/restore`, which is an undo for a different operation.
_RECORD_SUCCESSION_SQL = text(
    """
    UPDATE points p
       SET superseded_by = CAST(:successor AS uuid)
     WHERE p.point_id = CAST(:predecessor AS uuid)
       AND (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
    RETURNING p.point_id
    """
)


def _refusal(move: dict, reason: str, **extra) -> dict:
    return {
        "role": move.get("role"),
        "from_point_id": move.get("from_point_id"),
        "to_point_id": move.get("to_point_id"),
        "status": "refused",
        "reason": reason,
        **extra,
    }


async def repoint_role(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    role: str,
    from_point_id: uuid.UUID,
    to_point_id: uuid.UUID,
) -> dict:
    """Move one role onto the point an operator says replaced its own. ONE TRANSACTION.

    The write is two statements and they commit together:

      1. `points.superseded_by` on the PREDECESSOR names the successor — the same
         continuity chain a ghost collapse writes, so a rename joins history the
         same way a re-key does;
      2. `reporting.role_succession.inherit_roles` carries the role across that
         chain.

    The second step is a call into the shared reconcile rather than an INSERT of
    its own, and that is the point of the design: the writer runs the SAME
    statement when a superseded point's successor reports (see `app/store.py`), so
    an operator's move and a self-heal cannot drift into two slightly different
    ideas of what a succession does.

    Every refusal below happens BEFORE either statement, and returns a dict rather
    than raising, because a batch of moves is a worklist and one stale row in it
    must not discard the rest. The caller reports them verbatim.
    """
    move = {"role": role, "from_point_id": from_point_id, "to_point_id": to_point_id}

    if from_point_id == to_point_id:
        return _refusal(move, "a point cannot succeed itself")

    rows = {
        r["point_id"]: r
        for r in _rows(
            await db.execute(
                _MOVE_ENDPOINTS_SQL,
                {
                    "pids": [str(from_point_id), str(to_point_id)],
                    "tenant": str(tenant) if tenant else None,
                },
            )
        )
    }
    src, dst = rows.get(from_point_id), rows.get(to_point_id)
    if src is None:
        return _refusal(move, "the point the role is bound to is not in this tenant")
    if dst is None:
        return _refusal(move, "the named successor is not in this tenant")

    # THE SAME-DEVICE RULE, enforced here and not only in the proposal. The
    # worklist only ever offers same-device candidates, but the worklist is not
    # what the operator posts back — ids are — and a rule that lives only in the
    # read path is not a rule. Cross-device succession is a different feature with
    # a different risk profile (`IWT` is on every chiller in the building) and it
    # is refused by name rather than quietly allowed.
    if not src["device_tag"] or src["device_tag"] != dst["device_tag"]:
        return _refusal(
            move,
            f"a successor must be on the same device: the role is on "
            f"`{src['device_tag']}` and the successor is on `{dst['device_tag']}`",
            from_device_tag=src["device_tag"],
            to_device_tag=dst["device_tag"],
        )

    if dst["retired"]:
        return _refusal(move, "the named successor is retired")

    # The role must still be where the operator thought it was. The worklist goes
    # stale between the GET and the POST — another operator repoints it, a ghost
    # collapse migrates it — and applying the move anyway would silently rebind
    # something the caller never saw.
    if src["current_role"] != role:
        return _refusal(
            move,
            f"the point no longer carries `{role}`"
            + (f" — it now carries `{src['current_role']}`"
               if src["current_role"] else " — it carries no role"),
            current_role=src["current_role"],
        )

    # THE CONFLICT, REPORTED AND NEVER RESOLVED HERE. `point_roles` is keyed by
    # `point_id` alone, so the successor can hold one role and it already holds a
    # different one. Both are an operator's assertion about a real measurement and
    # nothing in this module is entitled to choose between them.
    #
    # THIS DIVERGES FROM GHOST COLLAPSE, DELIBERATELY. A collapse reports
    # `roles_discarded` and carries on: the survivor's own role wins, the ghost's
    # is dropped, and that is defensible there because the caller asked to collapse
    # a GROUP and the survivor is by definition the row that is still reporting.
    # Here the caller named this one successor for this one role, so discarding
    # either side of the conflict would be discarding something they explicitly
    # asked for. The whole move is refused instead, nothing is written, and the
    # conflicting role is named so the operator can settle it on the roles screen
    # and come back.
    if dst["current_role"] is not None:
        if dst["current_role"] == role:
            return _refusal(
                move,
                f"the successor already carries `{role}` — nothing to move",
                conflicting_role=dst["current_role"],
            )
        return _refusal(
            move,
            f"the successor already carries a different role, `{dst['current_role']}` "
            f"— clear it deliberately before moving `{role}` onto it",
            conflicting_role=dst["current_role"],
        )

    try:
        recorded = _rows(
            await db.execute(
                _RECORD_SUCCESSION_SQL,
                {
                    "predecessor": str(from_point_id),
                    "successor": str(to_point_id),
                    "tenant": str(tenant) if tenant else None,
                },
            )
        )
        moved = await inherit_roles(db, tenant, point_ids=[to_point_id])
        if not recorded or not moved:
            # Something changed between the checks above and the write — a
            # concurrent repoint, a role that appeared on the successor. Rolling
            # back is the only honest answer: the alternative is a succession
            # recorded with the role still on the dead point, which looks like a
            # completed move on every screen that reads the chain.
            await db.rollback()
            return _refusal(
                move,
                "the role did not move — the points changed underneath the "
                "request and nothing was written",
            )
        await db.commit()
    except Exception:
        await db.rollback()
        raise

    return {
        "role": role,
        "from_point_id": from_point_id,
        "to_point_id": to_point_id,
        "status": "moved",
        "device_tag": src["device_tag"],
        "from_point_tag": src["point_tag"],
        "to_point_tag": dst["point_tag"],
    }


# ── Forgetting an assertion whose point is gone ──────────────────────────────

# What each named id actually is, read in ONE statement and inside the tenant —
# the same construction as `_MOVE_ENDPOINTS_SQL` and for the same reason: a row
# the caller cannot see does not come back, so "there is no such role" and "it is
# not yours" are one refusal and the route is not a probe for other tenants' ids.
#
# `point_exists` is read rather than assumed because it is the ONLY thing that
# separates this operation from two others that look like it. It is reported back
# in the refusal so the operator is told which one they actually want.
_FORGETTABLE_SQL = text(
    """
    SELECT r.point_id,
           r.role,
           r.role_source,
           r.confirmed_by,
           r.confirmed_at,
           p.point_id IS NOT NULL AS point_exists
      FROM point_roles r
      LEFT JOIN points p ON p.point_id = r.point_id
     WHERE r.point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
    """
)

# The delete, with the missing-point condition RESTATED as a NOT EXISTS.
#
# The check above already refused a role whose point exists, so this looks
# redundant and is not. The read and the write are two statements: between them a
# point can be re-created — the writer mints a `points` row for any id a reading
# arrives under (contract §6), including one that was deleted a minute ago — and
# a DELETE guarded only by a check in Python would then erase an operator's
# assertion about a point that had just come back. The guard belongs where the
# row is, so the worst a race can do is delete nothing and report it.
#
# There is no UPDATE here and nothing is kept. `point_roles` has no soft-delete
# column and inventing one for this row alone would be a second idea of what a
# role is; the history that survives is what the operator read on the worklist
# before they chose, which is why the response echoes the assertion back.
_FORGET_ROLE_SQL = text(
    """
    DELETE FROM point_roles r
     WHERE r.point_id = CAST(:pid AS uuid)
       AND (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
       AND NOT EXISTS (SELECT 1 FROM points p WHERE p.point_id = r.point_id)
    RETURNING r.role
    """
)


async def forget_roles(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    point_ids: list[uuid.UUID],
) -> dict:
    """Delete the role rows whose point no longer exists. EXPLICIT IDS ONLY.

    This is the one action available on an orphan with `orphan_reason =
    "point_missing"`. There is nothing else that could be done to it: a repoint
    needs a successor and the same-device rule has no device to stand on, and an
    unbind of a point that is not there is what this is.

    THE NARROWNESS IS THE WHOLE DESIGN, exactly as it is for
    `/points/ghosts/restore`:

      * it takes point ids and there is no mode, no sweep and no "forget them
        all". Every other write in this module refuses to act on a worklist the
        server computed, and this one is DESTRUCTIVE — it erases a human's
        statement about what a number meant, and no self-heal puts it back;
      * it reaches a row ONLY when that row's point is missing, and that
        condition is in the DELETE rather than only in the check above it. A role
        whose point exists is refused by name however loudly it is asked for,
        because moving one is a repoint and clearing one is an unbind, and a
        route that silently did either would be a third operation nobody asked
        for.

    One transaction per id, like `repoint_roles`: these are independent decisions
    about different measurements, and a stale id must not discard the rest of the
    worklist. Every id comes back in `results` with what happened to it, and the
    assertion that was deleted is echoed back — it is the last place it exists.
    """
    known = {
        row["point_id"]: row
        for row in _rows(
            await db.execute(
                _FORGETTABLE_SQL,
                {
                    "pids": [str(p) for p in point_ids],
                    "tenant": str(tenant) if tenant else None,
                },
            )
        )
    }

    results: list[dict] = []
    for point_id in point_ids:
        row = known.get(point_id)
        if row is None:
            results.append({
                "point_id": point_id,
                "status": "refused",
                "reason": "no role is recorded against this point id in this tenant",
            })
            continue
        if row["point_exists"]:
            results.append({
                "point_id": point_id,
                "role": row["role"],
                "status": "refused",
                "reason": (
                    f"the point still exists — `{row['role']}` is bound to a real "
                    f"row, so this is a repoint or an unbind, not a forget"
                ),
            })
            continue
        try:
            deleted = _rows(
                await db.execute(
                    _FORGET_ROLE_SQL,
                    {
                        "pid": str(point_id),
                        "tenant": str(tenant) if tenant else None,
                    },
                )
            )
            if not deleted:
                # The point came back, or another operator forgot the row first.
                # Either way nothing was written and saying so is the only honest
                # answer — a 200 with no refusal would read as "forgotten" on a
                # screen where the row is still there.
                await db.rollback()
                results.append({
                    "point_id": point_id,
                    "role": row["role"],
                    "status": "refused",
                    "reason": (
                        "the role was not deleted — the point exists again or the "
                        "row was already forgotten, and nothing was written"
                    ),
                })
                continue
            await db.commit()
        except Exception:
            await db.rollback()
            raise
        results.append({
            "point_id": point_id,
            "status": "forgotten",
            # The assertion, echoed back after the only copy of it was deleted.
            "role": row["role"],
            "role_source": row["role_source"],
            "confirmed_by": row["confirmed_by"],
            "confirmed_at": row["confirmed_at"],
        })

    return {
        "requested": len(point_ids),
        "forgotten": sum(1 for r in results if r["status"] == "forgotten"),
        "refused": sum(1 for r in results if r["status"] == "refused"),
        "results": results,
    }


async def repoint_roles(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    moves: list[dict],
) -> dict:
    """Apply a list of moves, ONE TRANSACTION EACH, and report every outcome.

    Per-move transactions rather than one for the batch, and that is the same
    choice `collapse_ghosts` makes per group: these are independent decisions
    about different measurements, and one stale row should not discard nine good
    ones. It does mean a batch can half-apply — which is why every move comes back
    in `results` with what happened to it, and why `moved` is a count of writes
    rather than of requests.

    Nothing is validated ahead of the batch the way `collapse_ghosts` validates
    its choices, and the difference is deliberate: there, a bad survivor would
    have retired every member of its group, so the batch had to stop. Here the
    worst a bad move can do is be refused.
    """
    results = [
        await repoint_role(
            db, tenant,
            role=m["role"],
            from_point_id=m["from_point_id"],
            to_point_id=m["to_point_id"],
        )
        for m in moves
    ]
    return {
        "requested": len(moves),
        "moved": sum(1 for r in results if r["status"] == "moved"),
        "refused": sum(1 for r in results if r["status"] == "refused"),
        "results": results,
    }
