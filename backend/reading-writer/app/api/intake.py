"""Intake — what arrived, what still means nothing, and what is not there at all.

THE TREADMILL NOBODY WAS STANDING ON
------------------------------------
This platform refuses to measure anything a human has not asserted: a point has
no meaning until an operator confirms its UNIT (`app/api/units.py`) and, for a
metric, its ROLE (`app/metric_registry/roles.py`). That is correct and is not
what this module changes.

What it fixes is the consequence. A sensor added on Monday has no unit and no
role, so every metric that would use it refuses — correctly, by name — and the
refusal is buried inside a metric evaluation nobody reads until they wonder why
a number is a dash. New devices land on this estate WEEKLY (two chillers arrived
during the session this module was written in) and there was no surface anywhere
that answered "what arrived this week and still means nothing to us".

So: one read that ranks the unconfirmed backlog by whether the work is worth
doing, and one guard that stops the assertion that cannot be true.

EVERYTHING HERE IS KEYED ON `max(readings.ts)`, AND STAYS THAT WAY
------------------------------------------------------------------
It was written that way because `points.last_seen_at` was not evidence of a
reading at all: the writer upserted the dimension row for every message and THEN
inserted the readings `ON CONFLICT DO NOTHING`, so a retained MQTT message
replayed on reconnect — storing nothing, by design — dragged `last_seen_at` to
now() and cleared `retired_at` on the way past. `4F Khem Chiller02 / IWT` carried
`last_seen_at = 2026-09-05 08:27` against `max(readings.ts) = 2026-09-02 07:37`,
which is how `inlet_water_temp` came to be bound to a tag the device had stopped
publishing under.

THE WRITER WAS FIXED. `last_seen_at` is now the ts of a reading the writer
actually stored, and only a reading that landed clears `retired_at`. This module
still does not read that column, and the choice is deliberate:

* The rows that were already inflated do not heal. Nothing can write a truthful
  timestamp for a point that never reports again, so the three superseded Khem
  addresses still carry their old `08:27` — the exact rows this surface exists to
  expose. Keying on the column would hide them again.
* `last_seen_at` is a DENORMALISATION, lagging by up to the writer's point-touch
  interval and true only as long as one service keeps its promise.
  `max(readings.ts)` cannot drift from the data because it IS the data, and a
  surface whose entire job is to catch drift should not be the one place that
  trusts a copy.
* The guard refuses an assertion about a point with no data. That is a statement
  about readings, so it reads readings.

It is read through the `readings` primary key `(point_id, ts)` as a backwards
index scan per point — bounded by the number of points asked about, never by the
number of readings.

THE FOUR STATES, AND WHY THE GRACE WINDOW EXISTS
------------------------------------------------
    reporting               a reading inside `SILENT_AFTER_HOURS`
    awaiting_first_reading  no reading EVER, but the row is younger than
                            `FIRST_READING_GRACE_MIN` — a genuinely new sensor in
                            its first minutes, which is ordinary, not a fault
    silent                  reported once, nothing since the silence horizon
    never_reported          no reading ever, and old enough that the absence is
                            the answer: an address that does not exist

Splitting the last two from the first is the point. "Pending confirmation" and
"there is nothing at this address" look identical on a units screen and are
completely different problems, and only one of them is fixed by an operator
picking a unit from a dropdown.

WHAT THIS MODULE DELIBERATELY DOES NOT DO
-----------------------------------------
* It confirms NOTHING. There is no write path in this file at all.
* It expands no pattern. `siblings` on a refusal are the points on the SAME
  device that are actually reporting, listed so the operator can see the
  spelling they may have meant — the same discipline as `units.suggest()`: read
  time, labelled, never stored, never chosen on their behalf.
* It retires nothing, and now that is a choice rather than a constraint. It used
  to be impossible — `store.py` cleared `retired_at` for any message, so retiring
  a dead address wrote a fact the writer erased minutes later, invisibly. Since
  only a stored reading clears it, retirement STICKS, and the eight addresses
  listed here as SILENT can be retired for good. Which of them should be is an
  operator's judgement about their building, not a rule this module gets to
  apply on its own.
"""

from __future__ import annotations

import datetime as dt
import os
import uuid

from kernel.errors import ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .queries import LIVE_POINT, RETIRE_AFTER_DAYS, _rows

# ── thresholds ───────────────────────────────────────────────────────────────
#
# A brand-new sensor legitimately has no reading for its first minutes: the
# `points` row is written by the same batch as its first reading, but a metric
# screen can be open a poll cycle before the second one. This estate's gateway
# publishes on a ~5 minute cycle (see `queries.FRESH_MINUTES`), so 30 minutes is
# six cycles — long enough that "it just arrived" is a real explanation, short
# enough that a permanently empty address cannot hide behind it forever.
#
# A rule that blocked EVERY point with no readings would be wrong in the other
# direction: the two chillers that arrived this morning would have been
# unconfirmable during the window an operator is most likely to be looking at
# them, and a guard that fires on correct work is a guard that gets removed.
FIRST_READING_GRACE_MIN = max(
    0, int((os.getenv("VE_BI_FIRST_READING_GRACE_MIN") or "30").strip() or 30)
)

# How long a point may carry no new reading before an assertion about it is
# challenged. Deliberately a whole day, not a poll cycle: a network outage, a
# maintenance window or a change-of-value source that sits still are all normal,
# and none of them should make an operator argue with a dialog. The mis-bindings
# this guard exists for were silent for DAYS.
SILENT_AFTER_HOURS = max(
    1, int((os.getenv("VE_BI_SILENT_AFTER_HOURS") or "24").strip() or 24)
)

# Default "recently" for the arrivals view. Weekly is the estate's actual rhythm.
INTAKE_WINDOW_DAYS = max(1, int((os.getenv("VE_BI_INTAKE_WINDOW_DAYS") or "7").strip() or 7))

# The states, ranked by how much an operator's attention is worth spending on
# them. A point that is REPORTING and unconfirmed is the work; one that has
# never existed is not work at all, it is a correction somewhere else.
STATES = ("reporting", "awaiting_first_reading", "silent", "never_reported")

# States on which asserting a unit or a role is challenged rather than accepted.
CHALLENGED = ("never_reported", "silent")


def classify(
    first_seen_at: dt.datetime | None,
    last_reading_at: dt.datetime | None,
    now: dt.datetime,
) -> str:
    """Which of `STATES` a point is in. Pure — the SQL feeds it, tests drive it."""
    if last_reading_at is not None:
        silent_from = now - dt.timedelta(hours=SILENT_AFTER_HOURS)
        return "silent" if last_reading_at < silent_from else "reporting"
    # No reading, ever. Age is the only thing that separates "new" from "wrong".
    if first_seen_at is not None:
        if first_seen_at >= now - dt.timedelta(minutes=FIRST_READING_GRACE_MIN):
            return "awaiting_first_reading"
    return "never_reported"


# ── the read ─────────────────────────────────────────────────────────────────
#
# `last_reading_at` is a LATERAL max() over the readings PK, not a join to a
# rollup: `readings_1m` is materialized with a freshness floor, so a point that
# started reporting ten minutes ago would read as never-reported through it —
# the exact confusion this module exists to end.
_POINT_COLUMNS = """
           p.point_id, p.point_tag, p.device_id, p.device_tag, p.category,
           p.device_type, p.type, p.site_id, p.site_name,
           p.first_seen_at, p.last_seen_at,
           p.unit, p.unit_source, p.unit_confirmed_at, p.unit_confirmed_by,
           r.role, r.confirmed_at AS role_confirmed_at, r.confirmed_by AS role_confirmed_by,
           lr.last_reading_at
"""

_POINT_FROM = """
      FROM points p
      LEFT JOIN point_roles r ON r.point_id = p.point_id
      LEFT JOIN LATERAL (
           SELECT max(x.ts) AS last_reading_at
             FROM readings x
            WHERE x.point_id = p.point_id
      ) lr ON TRUE
"""

_LIST_SQL = """
    SELECT {cols}
    {frm}
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND {live}
       {filters}
     ORDER BY
           -- the work first: a point that is delivering values and means nothing
           -- yet, before one that arrived and went quiet, before an address that
           -- was never there.
           CASE
             WHEN lr.last_reading_at >= now() - make_interval(hours => :silent_hours) THEN 0
             WHEN lr.last_reading_at IS NULL
              AND p.first_seen_at >= now() - make_interval(mins => :grace_mins)      THEN 1
             WHEN lr.last_reading_at IS NOT NULL                                     THEN 2
             ELSE 3
           END,
           lr.last_reading_at DESC NULLS LAST,
           p.first_seen_at DESC,
           p.device_tag NULLS LAST, p.point_tag NULLS LAST
     LIMIT :limit OFFSET :offset
"""

# The counters are computed over the WHOLE live estate, never over the page, so
# "138 unconfirmed" does not silently become "the 50 rows you can see".
_COUNTS_SQL = """
    SELECT count(*)                                                           AS points,
           count(*) FILTER (WHERE p.first_seen_at >= now() - make_interval(days => :days))
                                                                              AS arrived,
           count(*) FILTER (WHERE p.unit_source IS DISTINCT FROM 'operator')   AS unit_unconfirmed,
           count(*) FILTER (WHERE r.point_id IS NULL)                          AS role_unbound,
           count(*) FILTER (
               WHERE p.first_seen_at >= now() - make_interval(days => :days)
                 AND p.unit_source IS DISTINCT FROM 'operator'
           )                                                                   AS arrived_unit_unconfirmed,
           count(*) FILTER (
               WHERE lr.last_reading_at >= now() - make_interval(hours => :silent_hours)
           )                                                                   AS reporting,
           count(*) FILTER (
               WHERE lr.last_reading_at IS NULL
                 AND p.first_seen_at >= now() - make_interval(mins => :grace_mins)
           )                                                                   AS awaiting_first_reading,
           count(*) FILTER (
               WHERE lr.last_reading_at IS NOT NULL
                 AND lr.last_reading_at < now() - make_interval(hours => :silent_hours)
           )                                                                   AS silent,
           count(*) FILTER (
               WHERE lr.last_reading_at IS NULL
                 AND p.first_seen_at < now() - make_interval(mins => :grace_mins)
           )                                                                   AS never_reported
    {frm}
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND {live}
"""

# Devices, because that is the unit a human recognises: "a new chiller appeared"
# is one row here and three on the points list.
_DEVICES_SQL = """
    SELECT coalesce(p.device_tag, '—')                                   AS device_tag,
           min(p.device_id::text)                                         AS device_id,
           min(p.category)                                                AS category,
           min(p.device_type)                                             AS device_type,
           min(p.first_seen_at)                                           AS first_seen_at,
           count(*)                                                       AS points,
           count(*) FILTER (WHERE p.unit_source = 'operator')             AS unit_confirmed,
           count(r.point_id)                                              AS role_bound,
           count(*) FILTER (
               WHERE lr.last_reading_at >= now() - make_interval(hours => :silent_hours)
           )                                                              AS reporting,
           max(lr.last_reading_at)                                        AS last_reading_at
    {frm}
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND {live}
       AND p.first_seen_at >= now() - make_interval(days => :days)
     GROUP BY coalesce(p.device_tag, '—')
     ORDER BY min(p.first_seen_at) DESC
"""


def _filters(state: str | None, pending: bool, new_only: bool, search: str | None) -> tuple[str, dict]:
    where = ""
    params: dict = {}
    if pending:
        # "Means nothing to us yet" is the unit — the input a rating cannot do
        # without. A missing ROLE is shown per row but is NOT a backlog: most
        # points are not an input to any metric and never will be, and counting
        # them as outstanding work would make the number meaningless.
        where += " AND p.unit_source IS DISTINCT FROM 'operator'"
    if new_only:
        where += " AND p.first_seen_at >= now() - make_interval(days => :days)"
    if search:
        where += " AND (p.device_tag ILIKE :search OR p.point_tag ILIKE :search)"
        params["search"] = f"%{search}%"
    if state == "reporting":
        where += " AND lr.last_reading_at >= now() - make_interval(hours => :silent_hours)"
    elif state == "silent":
        where += (
            " AND lr.last_reading_at IS NOT NULL"
            " AND lr.last_reading_at < now() - make_interval(hours => :silent_hours)"
        )
    elif state == "awaiting_first_reading":
        where += (
            " AND lr.last_reading_at IS NULL"
            " AND p.first_seen_at >= now() - make_interval(mins => :grace_mins)"
        )
    elif state == "never_reported":
        where += (
            " AND lr.last_reading_at IS NULL"
            " AND p.first_seen_at < now() - make_interval(mins => :grace_mins)"
        )
    return where, params


async def intake(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    days: int = INTAKE_WINDOW_DAYS,
    state: str | None = None,
    pending: bool = True,
    new_only: bool = False,
    search: str | None = None,
    limit: int = 200,
    offset: int = 0,
) -> dict:
    """What arrived, what is outstanding, and what is not there — in one read."""
    where, extra = _filters(state, pending, new_only, search)
    params = {
        "tenant": str(tenant) if tenant else None,
        "retire_days": RETIRE_AFTER_DAYS,
        "silent_hours": SILENT_AFTER_HOURS,
        "grace_mins": FIRST_READING_GRACE_MIN,
        "days": days,
        "limit": limit,
        "offset": offset,
        **extra,
    }
    frm = _POINT_FROM
    counts = _rows(await db.execute(text(_COUNTS_SQL.format(frm=frm, live=LIVE_POINT)), params))[0]
    devices = _rows(await db.execute(text(_DEVICES_SQL.format(frm=frm, live=LIVE_POINT)), params))
    rows = _rows(
        await db.execute(
            text(_LIST_SQL.format(cols=_POINT_COLUMNS, frm=frm, live=LIVE_POINT, filters=where)),
            params,
        )
    )
    now = dt.datetime.now(dt.timezone.utc)
    for r in rows:
        # Computed here from `max(readings.ts)` at read time, stored nowhere.
        r["state"] = classify(r["first_seen_at"], r["last_reading_at"], now)
        r["unit_confirmed"] = r["unit_source"] == "operator"
    return {
        "window_days": days,
        "generated_at": now,
        # Sent so the screen can state the rule it is applying rather than
        # hardcoding a number that a deployment may have tuned.
        "thresholds": {
            "first_reading_grace_minutes": FIRST_READING_GRACE_MIN,
            "silent_after_hours": SILENT_AFTER_HOURS,
        },
        "counts": {k: int(v or 0) for k, v in counts.items()},
        "devices": devices,
        "items": rows,
    }


# ── the guard ────────────────────────────────────────────────────────────────
#
# A surface alone would not have saved the operator who wrote the brief for this
# module: he confirmed `IWT`/`OWT` on a chiller that publishes `4FKC2_IWT`/
# `4FKC2_OWT`, and nothing anywhere said no. The confirmation succeeded, the
# metric refused `no_data`, and it stayed that way for days.

_LIVENESS_SQL = text(
    """
    SELECT p.point_id, p.point_tag, p.device_tag, p.device_id,
           p.first_seen_at, p.last_seen_at,
           lr.last_reading_at,
           coalesce(sib.tags, ARRAY[]::text[]) AS siblings
      FROM points p
      LEFT JOIN LATERAL (
           SELECT max(x.ts) AS last_reading_at
             FROM readings x
            WHERE x.point_id = p.point_id
      ) lr ON TRUE
      LEFT JOIN LATERAL (
           -- The points on the SAME device that ARE delivering values. Offered
           -- so the operator can see the spelling they probably meant; nothing
           -- picks one, and nothing here is stored.
           SELECT array_agg(s.point_tag ORDER BY s.point_tag) AS tags
             FROM (
                  SELECT q.point_tag
                    FROM points q
                    JOIN LATERAL (
                         SELECT max(y.ts) AS last_reading_at
                           FROM readings y
                          WHERE y.point_id = q.point_id
                    ) qr ON TRUE
                   WHERE q.tenant_id = p.tenant_id
                     AND q.point_id <> p.point_id
                     AND q.device_tag IS NOT DISTINCT FROM p.device_tag
                     AND qr.last_reading_at >= now() - make_interval(hours => :silent_hours)
                   LIMIT 8
             ) s
      ) sib ON TRUE
     WHERE p.point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
    """
)


def refusals(rows: list[dict], *, now: dt.datetime) -> list[dict]:
    """The points in `rows` an assertion should not silently succeed on.

    Pure, and separate from the query on purpose: the decision is the part worth
    testing, and it is the part that must not change by accident.
    """
    out: list[dict] = []
    for r in rows:
        state = classify(r.get("first_seen_at"), r.get("last_reading_at"), now)
        if state not in CHALLENGED:
            continue
        last = r.get("last_reading_at")
        out.append(
            {
                "point_id": str(r["point_id"]),
                "device_tag": r.get("device_tag"),
                "point_tag": r.get("point_tag"),
                "state": state,
                # ISO, not a datetime: this rides in an AppError's `details`, and
                # `kernel.errors` hands that straight to `JSONResponse` without
                # `jsonable_encoder` — a datetime there is a 500 INTERNAL_ERROR
                # in place of the refusal the operator needs to read.
                "last_reading_at": last.isoformat() if hasattr(last, "isoformat") else last,
                "reporting_siblings": list(r.get("siblings") or []),
            }
        )
    return out


async def guard_confirmable(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    point_ids: list[uuid.UUID],
    acknowledged: bool,
    what: str,
) -> list[dict]:
    """Refuse — or, on an explicit acknowledgement, permit and report — a
    confirmation on points that are not carrying data.

    WHY A CHALLENGE AND NOT A BAN. A flat refusal would be wrong: a genuinely
    existing meter can be offline for maintenance, and an operator who KNOWS the
    address is right must be able to say so. The failure being prevented is not
    "asserting about a quiet point", it is asserting about one WITHOUT NOTICING —
    so the request must carry a second, different statement (`acknowledge_not_
    reporting`) that could only have been sent by someone who read the refusal.
    That is why it is a request field and not a query flag or a setting: it
    cannot be turned on once and forgotten.

    WHY IT IS NOT AN AUTO-CORRECTION. The refusal lists the device's reporting
    points, and stops. Rebinding to the one that looks closest is exactly the
    server-side guess this whole subsystem exists to refuse.

    RETRACTION IS NEVER GUARDED — the caller does not call this when clearing. A
    mis-binding an operator cannot take back is the worse failure, and a point
    that never reported is precisely one whose binding most needs removing.
    """
    if not point_ids:
        return []
    rows = _rows(
        await db.execute(
            _LIVENESS_SQL,
            {
                "pids": [str(p) for p in point_ids],
                "tenant": str(tenant) if tenant else None,
                "silent_hours": SILENT_AFTER_HOURS,
            },
        )
    )
    bad = refusals(rows, now=dt.datetime.now(dt.timezone.utc))
    if not bad or acknowledged:
        return bad
    never = [b for b in bad if b["state"] == "never_reported"]
    lead = ", ".join(
        f"`{b['device_tag']} / {b['point_tag']}`" for b in (never or bad)[:5]
    )
    more = len(never or bad) - 5
    raise ValidationError(
        (
            f"{len(bad)} of {len(point_ids)} point(s) are not carrying readings, so "
            f"a {what} confirmed on them would mean nothing and no metric would "
            f"ever compute from it: {lead}{f' and {more} more' if more > 0 else ''}. "
            "Check the spelling against the points that ARE reporting on the same "
            "device (listed in details.points[].reporting_siblings). If the address "
            "is right and the device is simply offline, resend with "
            "`acknowledge_not_reporting: true` to assert it anyway."
        ),
        code="POINT_NOT_REPORTING",
        details={
            "what": what,
            "requested": len(point_ids),
            "challenged": len(bad),
            "thresholds": {
                "first_reading_grace_minutes": FIRST_READING_GRACE_MIN,
                "silent_after_hours": SILENT_AFTER_HOURS,
            },
            "points": bad,
        },
    )
