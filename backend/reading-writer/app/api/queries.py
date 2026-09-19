"""SELECT-only queries behind the Building Intelligence read API.

Three rules run through everything here.

**1. Charts read the ROLLUPS, never the raw table.** That is the property that
makes query cost independent of ingest rate (contract §5), which matters because
sensors have wildly different turnaround times and the platform cannot assume any
of them. `readings_1m` and `readings_1h` are continuous aggregates; a chart hits
one of them. Raw is reachable only through `resolution="raw"` over a window this
module refuses to widen past `RAW_MAX_MINUTES`, and through the bounded
"latest value" lookup.

**2. Everything is tenant-scoped.** Every statement carries a `:tenant` bind. A
tenant-scoped caller passes their own uuid and can never widen it — the parameter
is filled from the JWT, never from the request. A platform super-admin (no tenant
claim) may pass NULL and see every tenant, which is the same semantics
`kernel.auth.scoped()` gives every other service.

**3. A device's identity is its `device_id`, its label is `device_tag`.** Renaming
a device must not split it into two rows, and two devices must not merge because
they share a tag. `device_id` can be NULL for a pre-Phase-C row, so the grouping
key falls back to the tag.

The rollup views are not SQLAlchemy models (a continuous aggregate is not
expressible in ORM metadata — see `reporting.models`), so these are textual
statements against them. The `points` dimension IS a model, but it is queried the
same way here so one filter builder covers both halves.
"""

from __future__ import annotations

import datetime as dt
import os
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

# The raw table is reachable only over a window this short. Past it a caller gets
# a 400 telling them which rollup to ask for instead — silently downgrading the
# resolution would make a chart lie about its own precision.
RAW_MAX_MINUTES = 180

# `readings_1m` is materialized_only with a ~2 minute freshness floor, so a
# "current value" cannot come from it. Latest values read RAW over this bounded
# lookback; a point with nothing inside it reports no latest value at all rather
# than an hours-old number presented as live.
LATEST_LOOKBACK_MINUTES = 60

# How recent `points.last_seen_at` must be for a point to count as "reporting".
# The live gateway publishes on a ~5 minute cycle, so 15 minutes is three missed
# cycles — long enough not to flicker, short enough to notice a dead device.
FRESH_MINUTES = 15

# ── retirement ───────────────────────────────────────────────────────────────
# A point that stops reporting used to count toward every Building Intelligence
# figure forever: a decommissioned meter, a renamed tag, a one-off test point
# were all permanent members of `total_points`, and the only way out was to
# DELETE the dimension row — which orphans its readings, since `readings` has no
# foreign key to `points`.
#
# A point is LIVE when it is neither explicitly retired nor past the horizon:
#
#   retired_at IS NULL                                  (nobody retired it), AND
#   last_seen_at >= now() - RETIRE_AFTER_DAYS           (it reported recently)
#
# Both halves matter. The horizon needs no operator and self-heals, so a building
# nobody curates still reports honest numbers; the explicit flag is for a point
# that is gone NOW and should not wait a month. Neither deletes anything — a
# retired point's readings stay exactly where they are, and it returns to the
# counts the instant a reading arrives (the writer clears `retired_at`).
#
# Set VE_READINGS_RETIRE_AFTER_DAYS=0 to disable the horizon and rely only on
# explicit retirement.
RETIRE_AFTER_DAYS = max(0, int((os.getenv("VE_READINGS_RETIRE_AFTER_DAYS") or "30").strip() or 30))

# The predicate, in one place. `:retire_days = 0` short-circuits the horizon so
# the same SQL serves both configurations.
LIVE_POINT = (
    "p.retired_at IS NULL "
    "AND (:retire_days = 0 "
    "     OR p.last_seen_at >= now() - make_interval(days => :retire_days))"
)


def _live(include_retired: bool = False) -> str:
    """The retirement predicate as a SQL fragment, or TRUE when retired rows are wanted.

    Browse surfaces take `include_retired=true` so a retired point remains
    REACHABLE — it is excluded from the counts, not hidden from the operator who
    wants to see what was retired and why the total moved.
    """
    return "TRUE" if include_retired else LIVE_POINT

# Ceilings. A chart that asks for 500 series or 100k buckets is a bug, and it
# should fail loudly at the edge rather than becoming a slow query.
MAX_SERIES_POINTS = 24
MAX_BUCKETS_PER_SERIES = 5000


def _rows(result) -> list[dict]:
    return [dict(r) for r in result.mappings().all()]


# ── Portfolio ────────────────────────────────────────────────────────────────

_SUMMARY_SQL = text(
    """
    SELECT p.category                                      AS category,
           count(*)                                        AS points,
           count(DISTINCT coalesce(p.device_id::text, p.device_tag)) AS devices,
           count(*) FILTER (
               WHERE p.last_seen_at >= now() - make_interval(mins => :fresh)
           )                                               AS points_reporting,
           max(p.last_seen_at)                             AS last_seen_at
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND """ + LIVE_POINT + """
     GROUP BY p.category
     ORDER BY count(*) DESC
    """
)

_DEVICE_TYPES_SQL = text(
    """
    SELECT p.category                                      AS category,
           p.device_type                                   AS device_type,
           count(*)                                        AS points,
           count(DISTINCT coalesce(p.device_id::text, p.device_tag)) AS devices
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND """ + LIVE_POINT + """
     GROUP BY p.category, p.device_type
     ORDER BY count(*) DESC
    """
)

# Extent of the stored history + the last hour's volume. `readings_1h` is a
# REAL-TIME continuous aggregate, so its newest bucket already includes rows the
# materializer has not folded in yet — the count is current, not two minutes old.
_EXTENT_SQL = text(
    """
    SELECT min(r.bucket)                                   AS first_bucket,
           max(r.bucket)                                   AS last_bucket,
           coalesce(sum(r.sample_count) FILTER (
               WHERE r.bucket >= date_trunc('hour', now())
           ), 0)                                           AS samples_this_hour
      FROM readings_1h r
     WHERE (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
    """
)

# Totals, counted ONCE over the whole tenant rather than summed from the
# per-category rows. Summing would double-count a device that owns both
# classified and unclassified points — this deployment has exactly one
# (`4F-5F Light DB`: six energy points and one the gateway never classified).
#
# The true last reading time comes from `points.last_seen_at` rather than from a
# bucket start, which would round backwards. That column is the ts of a reading
# the writer actually STORED — it used to be the arrival time of any message,
# including a replayed one that stored nothing.
#
# ── `registers`: HOW MANY THINGS, as against how many ROWS ────────────────────
#
# `points` counts point ids and a rebuilt gateway connection mints a new id for
# every point behind it (see the ghost-points block below), so `points` is rows
# and `registers` is the physical registers those rows describe: 766 against 475
# on this deployment, 291 of the rows being later generations of something
# already counted.
#
# IT IS COMPUTED HERE, IN THIS STATEMENT, ON PURPOSE. The number cannot be
# derived on a screen by subtracting the ghost worklist's duplicate excess from
# `total_points`, because those two are counted over DIFFERENT ROW SETS: this one
# applies the retirement horizon (LIVE_POINT) and the ghost grouping deliberately
# applies only `retired_at IS NULL`, since applying the horizon would hide the
# members that worklist exists to find. A generation dead long enough to be past
# the horizon is therefore in the worklist and was never in the total, and the
# subtraction under-counts by exactly those rows. Today the two happen to agree;
# that is a coincidence of this estate's ages and not a property. Putting the
# distinct count in the same SELECT as `points` makes the two share one predicate
# by construction rather than by two places agreeing.
#
# A register is `(device_tag, point_tag)`, the same key the ghost grouping uses,
# joined by an ASCII unit separator so `('1FYC1', 'A_B')` and `('1FYC1_A', 'B')`
# cannot collide. A row missing either tag falls back to its own `point_id`, so it
# counts as one register of its own: two untagged rows cannot be shown to be the
# same thing, and grouping them — which a plain `count(DISTINCT (a, b))` would do,
# because DISTINCT reads NULLs as equal — would silently merge every unlabelled
# point on the estate into one.
_TOTALS_SQL = text(
    """
    SELECT count(DISTINCT coalesce(p.device_id::text, p.device_tag)) AS devices,
           count(*)                                        AS points,
           count(DISTINCT CASE
                   WHEN p.device_tag IS NOT NULL AND p.point_tag IS NOT NULL
                   THEN p.device_tag || chr(31) || p.point_tag
                   ELSE p.point_id::text
                 END)                                      AS registers,
           count(*) FILTER (
               WHERE p.last_seen_at >= now() - make_interval(mins => :fresh)
           )                                               AS points_reporting,
           min(p.first_seen_at)                            AS first_seen_at,
           max(p.last_seen_at)                             AS last_seen_at,
           -- WHERE this device is, so a device-first screen can show what it is
           -- about to change and which devices have no building at all. Placement
           -- is a device-level statement, so these agree across a device's points
           -- except where an operator has overridden ONE point
           -- (`placement_source = 'point'`); `max` then reports one of the two,
           -- and the point console is where that distinction is visible.
           max(p.site_id::text)                            AS site_id,
           max(p.site_name)                                AS site_name
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND """ + LIVE_POINT + """
    """
)

# The RETIRED half of the same tenant, so the UI can say "313 points (4 retired)"
# rather than showing a total that silently shrank by four.
_RETIRED_TOTALS_SQL = text(
    """
    SELECT count(*)                                        AS points_retired
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND NOT (""" + LIVE_POINT + """)
    """
)


async def summary(db: AsyncSession, tenant: uuid.UUID | None) -> dict:
    params = {
        "tenant": str(tenant) if tenant else None,
        "fresh": FRESH_MINUTES,
        "retire_days": RETIRE_AFTER_DAYS,
    }
    nofresh = {"tenant": params["tenant"], "retire_days": RETIRE_AFTER_DAYS}
    cats = _rows(await db.execute(_SUMMARY_SQL, params))
    types = _rows(await db.execute(_DEVICE_TYPES_SQL, nofresh))
    extent = _rows(await db.execute(_EXTENT_SQL, {"tenant": params["tenant"]}))
    seen = _rows(await db.execute(_TOTALS_SQL, params))
    retired = _rows(await db.execute(_RETIRED_TOTALS_SQL, nofresh))
    placed = _rows(await db.execute(_PLACEMENT_SQL, nofresh))
    floors = _rows(await db.execute(_BY_FLOOR_SQL, params))
    sites = await sites_breakdown(db, tenant, params, nofresh)

    by_cat: dict[object, list[dict]] = {}
    for t in types:
        by_cat.setdefault(t["category"], []).append(
            {
                "device_type": t["device_type"],
                "devices": int(t["devices"]),
                "points": int(t["points"]),
            }
        )

    categories = [
        {
            "category": c["category"],
            "devices": int(c["devices"]),
            "points": int(c["points"]),
            "points_reporting": int(c["points_reporting"]),
            "last_seen_at": c["last_seen_at"],
            "device_types": by_cat.get(c["category"], []),
        }
        for c in cats
    ]

    ext = extent[0] if extent else {}
    row = seen[0] if seen else {}
    return {
        "tenant_id": tenant,
        "generated_at": dt.datetime.now(dt.timezone.utc),
        "fresh_minutes": FRESH_MINUTES,
        # The horizon in force, so a caller can see WHY a point stopped counting
        # rather than watching a total change for no visible reason.
        "retire_after_days": RETIRE_AFTER_DAYS,
        # Excluded from every count above — retired explicitly or past the
        # horizon. Their readings are untouched; this is a count, not a deletion.
        "total_points_retired": int((retired[0] if retired else {}).get("points_retired") or 0),
        "categories": categories,
        # From _TOTALS_SQL, not summed from `categories` — see its comment.
        "total_devices": int(row.get("devices") or 0),
        "total_points": int(row.get("points") or 0),
        # The same rows as `total_points`, counted as THINGS rather than as ids —
        # see _TOTALS_SQL. `total_points - total_registers` is the number of rows
        # that are later generations of a register already counted, and it is
        # honest only because both halves came out of one statement over one
        # predicate.
        "total_registers": int(row.get("registers") or 0),
        "total_points_reporting": int(row.get("points_reporting") or 0),
        "first_reading_at": row.get("first_seen_at") or ext.get("first_bucket"),
        "last_reading_at": row.get("last_seen_at"),
        "readings_last_hour": int(ext.get("samples_this_hour") or 0),
        # Where the estate is anchored. Stated even when the answer is "nowhere",
        # because a floor-wise surface with no rows looks broken while "0 of 314
        # points are placed" is a fact.
        "placement": _placement(placed[0] if placed else {}),
        # The leaderboard's row set: every site the `site_facts` mirror carries,
        # plus the unplaced pseudo-row. Shaped for N sites; one site is just N=1.
        "sites": sites,
        "site_alert_hours": SITE_ALERT_HOURS,
        "floors": [
            {
                "floor_id": f["floor_id"],
                "floor_name": f["floor_name"],
                "site_name": f["site_name"],
                "devices": int(f["devices"]),
                "points": int(f["points"]),
                "points_reporting": int(f["points_reporting"]),
                "last_seen_at": f["last_seen_at"],
            }
            for f in floors
        ],
    }


def _placement(row: dict) -> dict:
    """How much of the live estate is anchored in space.

    Nothing here infers a placement, and nothing derives one level from another:
    a point can legitimately have a site and no floor (a rooftop meter that
    belongs to the building rather than to a storey), so the three counts are
    independent rather than nested.
    """
    total = int(row.get("points") or 0)
    with_site = int(row.get("points_with_site") or 0)
    with_floor = int(row.get("points_with_floor") or 0)
    with_zone = int(row.get("points_with_zone") or 0)
    return {
        "points": total,
        "with_site": with_site,
        "with_floor": with_floor,
        "with_zone": with_zone,
        # The headline for a console: how much of the estate cannot answer a
        # floor-wise question at all.
        "unplaced": total - with_floor,
    }


# ── Placement ────────────────────────────────────────────────────────────────
#
# Where the estate IS, and — for now — mostly where it is NOT. `points.site_id` /
# `floor_id` / `zone_id` exist (migration 0008) and nothing populates them: the
# gateway wire carries no placement and there is no placement API. So this query
# answers, honestly, "how much of the estate is anchored in space", and the
# answer today is none of it.
#
# It is here rather than left out because a floor-wise console that simply had no
# data would look broken. "0 of 314 points are placed" is a different statement
# from "there is no data", and it is the true one.
_PLACEMENT_SQL = text(
    """
    SELECT count(*)                                        AS points,
           count(*) FILTER (WHERE p.site_id IS NOT NULL)   AS points_with_site,
           count(*) FILTER (WHERE p.floor_id IS NOT NULL)  AS points_with_floor,
           count(*) FILTER (WHERE p.zone_id IS NOT NULL)   AS points_with_zone
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND """ + LIVE_POINT + """
    """
)

# The floor-wise breakdown. The UNPLACED group is returned as a row with a NULL
# id rather than being dropped, for the same reason `/bi/devices` answers
# `category=`: "the points nothing has placed" is a real question and hiding them
# would make the floors look like the whole estate.
_BY_FLOOR_SQL = text(
    """
    SELECT p.floor_id                                      AS floor_id,
           max(p.floor_name)                               AS floor_name,
           max(p.site_name)                                AS site_name,
           count(*)                                        AS points,
           count(DISTINCT coalesce(p.device_id::text, p.device_tag)) AS devices,
           count(*) FILTER (
               WHERE p.last_seen_at >= now() - make_interval(mins => :fresh)
           )                                               AS points_reporting,
           max(p.last_seen_at)                             AS last_seen_at
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND """ + LIVE_POINT + """
     GROUP BY p.floor_id
     -- Placed floors first, then the unplaced bucket, each by size.
     ORDER BY (p.floor_id IS NULL), count(*) DESC
    """
)


# ── Sites ────────────────────────────────────────────────────────────────────
#
# The per-SITE breakdown behind the Portfolio leaderboard. The row set is the
# `site_facts` mirror (a site exists on the leaderboard because core published
# it, whether or not anything is placed there) PLUS one "unplaced" pseudo-row for
# the points no site owns — same rule as the floor list: the points nothing has
# placed are a real group, and folding them into a site would misstate both.
#
# What is DELIBERATELY NOT here:
#   • No score. Nothing on this platform defines one yet (the metric registry
#     will); the field is present and NULL so the screen reads a slot, not a
#     hardcoded dash.
#   • No derived consumption unless an operator has confirmed kWh registers at
#     the site — see the `kwh` block below.

# The alert window for the per-site severity counts. Matches the Portfolio fault
# queue so the leaderboard chip and the queue answer about the same stretch.
SITE_ALERT_HOURS = 24

_BY_SITE_SQL = text(
    """
    SELECT p.site_id                                       AS site_id,
           max(p.site_name)                                AS site_name,
           count(DISTINCT coalesce(p.device_id::text, p.device_tag)) AS devices,
           count(*)                                        AS points,
           count(*) FILTER (
               WHERE p.last_seen_at >= now() - make_interval(mins => :fresh)
           )                                               AS points_reporting,
           max(p.last_seen_at)                             AS last_seen_at,
           count(*) FILTER (
               WHERE p.unit_source = 'operator' AND lower(btrim(p.unit)) = 'kwh'
           )                                               AS kwh_points
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND """ + LIVE_POINT + """
     GROUP BY p.site_id
    """
)

_SITE_CATEGORIES_SQL = text(
    """
    SELECT p.site_id                                       AS site_id,
           p.category                                      AS category,
           count(DISTINCT coalesce(p.device_id::text, p.device_tag)) AS devices,
           count(*)                                        AS points
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND """ + LIVE_POINT + """
     GROUP BY p.site_id, p.category
     ORDER BY count(*) DESC
    """
)

# Alerts carry no site of their own; a device's placement is the only anchor.
# The join is through the DISTINCT device→site map from `points` (placement is a
# device-level statement, so every point of a device agrees). An alert whose
# device is unplaced — or that carries no device_id at all — lands in the
# NULL-site bucket, never in a site it was not placed on.
_SITE_ALERTS_SQL = text(
    """
    SELECT ds.site_id                                      AS site_id,
           a.severity                                      AS severity,
           count(*)                                        AS alerts
      FROM iot_alerts a
      LEFT JOIN (
           SELECT DISTINCT p.device_id, p.site_id
             FROM points p
            WHERE p.device_id IS NOT NULL AND p.site_id IS NOT NULL
      ) ds ON ds.device_id = a.device_id
     WHERE a.ts >= now() - make_interval(hours => :alert_hours)
       AND (CAST(:tenant AS uuid) IS NULL OR a.tenant_id = CAST(:tenant AS uuid))
     GROUP BY ds.site_id, a.severity
    """
)

# `SELECT f.*` on purpose: the mirror is another agent's surface and is about to
# grow columns (city/location among them). Reading whatever is there and picking
# keys defensively means a new fact flows through without an edit here — and an
# absent one reads as NULL, which renders as "—" with its reason, never as a
# stand-in.
#
# `f.is_active` IS A FILTER, NOT A COLUMN TO RENDER. Core's site delete is SOFT
# (`sites/site/service.py`), and the mirror deliberately deletes nothing — a
# `deleted` event only flips this flag (`site_facts_sync.py`). So without this
# predicate a site an operator deleted in Configurations → Sites vanishes from
# Sites and stays on the BI leaderboard forever, indistinguishable from a live
# one. That is not a hypothetical: two rows named "TEMP smoke site" sat on this
# portfolio with `is_active = false` and no row left in core at all.
#
# Filtered rather than rendered as "archived": a deleted site is a site the
# operator said is not theirs any more, and an estate score that still averages
# it in is wrong in the direction that matters. A retired-sites view, if anyone
# ever wants one, asks a different question and gets its own query.
_SITE_FACTS_SQL = text(
    """
    SELECT f.*
      FROM site_facts f
     WHERE (CAST(:tenant AS uuid) IS NULL OR f.tenant_id = CAST(:tenant AS uuid))
       AND f.is_active
     ORDER BY f.site_name NULLS LAST
    """
)


def _site_kwh(kwh_points: int, consumption: float | None) -> dict:
    """The measured-consumption slot for one site, gated on confirmed units.

    ZERO confirmed registers is the state this deployment is in, and it renders
    as BLOCKED with the fix named — never as 0 kWh, which would be a measurement
    nobody made.
    """
    if kwh_points <= 0:
        return {
            "confirmed_points": 0,
            "window_hours": SITE_ALERT_HOURS,
            "consumption_kwh": None,
            "status": "blocked",
            "reason": "no kWh register confirmed — confirm units in Ratings",
        }
    if consumption is None:
        return {
            "confirmed_points": kwh_points,
            "window_hours": SITE_ALERT_HOURS,
            "consumption_kwh": None,
            "status": "no_data",
            "reason": (
                f"{kwh_points} confirmed kWh register(s), but no usable hourly "
                "bucket in the window (no data, or every register decreased)"
            ),
        }
    return {
        "confirmed_points": kwh_points,
        "window_hours": SITE_ALERT_HOURS,
        "consumption_kwh": consumption,
        "status": "measured",
        "reason": (
            f"sum of {kwh_points} operator-confirmed kWh register(s), last−first "
            f"per register over {SITE_ALERT_HOURS}h. NOTE: a sum over every "
            "confirmed register can double-count an incomer against its own "
            "sub-meters; the Ratings screen takes the operator's meter list "
            "for the authoritative figure"
        ),
    }


async def _site_consumption(
    db: AsyncSession, tenant: uuid.UUID | None, site_id
) -> float | None:
    """Measured kWh over the site's confirmed registers, from the hourly rollup.

    Reuses the Ratings arithmetic (`last − first` with the monotonic guard) so
    this figure and a rating computed over the same registers cannot disagree.
    Returns None when no register produced a usable delta.
    """
    # Lazy import: `rating` imports from this module at load time.
    from . import rating as rt

    meters = await rt.candidate_meters(db, tenant, site_id)
    if not meters:
        return None
    end = dt.datetime.now(dt.timezone.utc)
    start = end - dt.timedelta(hours=SITE_ALERT_HOURS)
    regs = await rt.registers(
        db, tenant, point_ids=[m["point_id"] for m in meters], start=start, end=end
    )
    total: float | None = None
    for m in meters:
        row = rt.meter_row(m, regs.get(m["point_id"]))
        if row["status"] == "ok" and row["consumption_kwh"] is not None:
            total = (total or 0.0) + float(row["consumption_kwh"])
    return total


def _categories_by_site(cats: list[dict]) -> dict[object, list[dict]]:
    """What each site is made of, by point category."""
    out: dict[object, list[dict]] = {}
    for c in cats:
        out.setdefault(c["site_id"], []).append(
            {
                "category": c["category"],
                "devices": int(c["devices"]),
                "points": int(c["points"]),
            }
        )
    return out


def _alerts_by_site(alerts: list[dict]) -> dict[object, dict]:
    """Each site's alert count, kept split by severity as well as totalled."""
    out: dict[object, dict] = {}
    for a in alerts:
        bucket = out.setdefault(a["site_id"], {"total": 0, "by_severity": {}})
        sev = a["severity"] or "unknown"
        bucket["by_severity"][sev] = bucket["by_severity"].get(sev, 0) + int(a["alerts"])
        bucket["total"] += int(a["alerts"])
    return out


def _site_row(
    site_id, fact: dict | None, by_site: dict, cats_by_site: dict, alerts_by_site: dict
) -> dict:
    """One leaderboard row, with every slot the screen reads already present."""
    agg = by_site.get(site_id) or {}
    kwh_points = int(agg.get("kwh_points") or 0)
    fact = fact or {}
    return {
        "site_id": site_id,
        "site_name": fact.get("site_name") or agg.get("site_name"),
        "placed": site_id is not None,
        "is_active": fact.get("is_active"),
        # Facts the mirror may or may not carry yet. `.get` on purpose —
        # an absent column is NULL, and NULL renders as "—" with its reason.
        "gross_floor_area_sqm": fact.get("gross_floor_area_sqm"),
        "city": fact.get("city") or fact.get("location"),
        "occupancy": fact.get("occupancy"),
        "devices": int(agg.get("devices") or 0),
        "points": int(agg.get("points") or 0),
        "points_reporting": int(agg.get("points_reporting") or 0),
        "last_seen_at": agg.get("last_seen_at"),
        "categories": cats_by_site.get(site_id, []),
        "alerts": {
            "hours": SITE_ALERT_HOURS,
            "total": alerts_by_site.get(site_id, {}).get("total", 0),
            "by_severity": alerts_by_site.get(site_id, {}).get("by_severity", {}),
        },
        # Filled by the CCEI loop below from the metric registry; the
        # screen reads this SLOT, so a refusal arrives as reason + detail,
        # never as a fabricated number.
        "score": None,
        "score_reason": None,
        "score_detail": None,
        "kwh": _site_kwh(kwh_points, None),
    }


async def _fill_measured_consumption(
    db: AsyncSession, tenant: uuid.UUID | None, rows: list[dict], by_site: dict
) -> None:
    """Measured consumption, only where an operator confirmed registers —
    everywhere else the blocked state `_site_row` set stands."""
    for r in rows:
        if r["site_id"] is None:
            continue
        kwh_points = int((by_site.get(r["site_id"]) or {}).get("kwh_points") or 0)
        if kwh_points > 0:
            consumption = await _site_consumption(db, tenant, r["site_id"])
            r["kwh"] = _site_kwh(kwh_points, consumption)


async def _fill_ccei_scores(
    db: AsyncSession, tenant: uuid.UUID | None, rows: list[dict]
) -> None:
    """The SCORE slot, read from the metric registry's `ccei`.

    A composite ROW — weights are data, contract §21 — evaluated per site over
    the same window as the other leaderboard figures. The registry's refusal
    semantics ride along WHOLE: a site that cannot honestly score gets the
    reason and every component's own {status, reason} in `score_detail`, so the
    dash the screen renders can explain itself input by input. Nothing here
    rounds a refusal into a number.
    """
    from ..metric_registry import evaluator as metric_eval  # lazy: circular import

    end = dt.datetime.now(dt.timezone.utc)
    start = end - dt.timedelta(hours=SITE_ALERT_HOURS)
    for r in rows:
        if r["site_id"] is None:
            r["score_reason"] = (
                "unplaced points belong to no site, and a score is a site's — "
                "place the devices and they count"
            )
            continue
        try:
            ev = await metric_eval.evaluate(
                db, tenant, "ccei", site_id=r["site_id"], start=start, end=end,
            )
        except metric_eval.EvaluationError as exc:
            # No ccei definition effective (or the site vanished between two
            # queries). Stated, not invented.
            r["score_reason"] = f"no score: {exc}"
            continue
        item = ev["items"][0] if ev["items"] else None
        if item is None:
            r["score_reason"] = "no score: site not present in the reporting mirror"
            continue
        r["score_detail"] = {
            "metric": ev["metric"],
            "version": ev["version"],
            "window_hours": SITE_ALERT_HOURS,
            "status": item["status"],
            "components": item.get("components"),
            "arithmetic": item.get("arithmetic"),
        }
        if item["status"] == "ok":
            r["score"] = float(item["value"])
            r["score_reason"] = f"CCEI v{ev['version']}: {item.get('arithmetic')}"
        else:
            r["score_reason"] = (
                f"CCEI v{ev['version']} {item['status']}: {item['reason']}"
            )


async def sites_breakdown(
    db: AsyncSession, tenant: uuid.UUID | None, params: dict, nofresh: dict
) -> list[dict]:
    facts = _rows(await db.execute(_SITE_FACTS_SQL, {"tenant": params["tenant"]}))
    by_site = {r["site_id"]: r for r in _rows(await db.execute(_BY_SITE_SQL, params))}
    cats_by_site = _categories_by_site(_rows(await db.execute(_SITE_CATEGORIES_SQL, nofresh)))
    alerts_by_site = _alerts_by_site(
        _rows(
            await db.execute(
                _SITE_ALERTS_SQL,
                {"tenant": params["tenant"], "alert_hours": SITE_ALERT_HOURS},
            )
        )
    )

    out = [
        _site_row(f["site_id"], f, by_site, cats_by_site, alerts_by_site) for f in facts
    ]
    # Sites the point store knows that the mirror does not (should not happen —
    # placement writes come from core, which also feeds the mirror — but a row
    # silently dropped from the leaderboard would hide real devices).
    known = {f["site_id"] for f in facts}
    for sid in by_site:
        if sid is not None and sid not in known:
            out.append(_site_row(sid, None, by_site, cats_by_site, alerts_by_site))
    # The unplaced pseudo-row, always last and always present when it is
    # non-empty — "121 points no site owns" is a fact, not clutter.
    unplaced = by_site.get(None)
    if unplaced and int(unplaced.get("points") or 0) > 0:
        out.append(_site_row(None, None, by_site, cats_by_site, alerts_by_site))

    await _fill_measured_consumption(db, tenant, out, by_site)
    await _fill_ccei_scores(db, tenant, out)
    return out


_ACTIVITY_SQL = text(
    """
    SELECT r.bucket                    AS bucket,
           p.category                  AS category,
           sum(r.sample_count)::bigint AS samples,
           count(DISTINCT r.point_id)  AS points
      FROM readings_1h r
      JOIN points p ON p.point_id = r.point_id
     WHERE r.bucket >= now() - make_interval(hours => :hours)
       AND (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
       -- A retired point's HISTORY is intact in readings_1h; it is simply not
       -- charted alongside the live estate. Retiring never deletes a bucket.
       AND p.retired_at IS NULL AND (:retire_days = 0      OR p.last_seen_at >= now() - make_interval(days => :retire_days))
     GROUP BY r.bucket, p.category
     ORDER BY r.bucket
    """
)


async def activity(db: AsyncSession, tenant: uuid.UUID | None, hours: int) -> list[dict]:
    """Hourly ingest volume per category — the honest "is the building talking?".

    `readings_1h` is real-time, so the current (partial) hour is included and is
    genuinely current. Nothing here is a physical quantity: it counts SAMPLES,
    which the pipeline actually knows, rather than a kWh nobody sent.
    """
    rows = _rows(
        await db.execute(
            _ACTIVITY_SQL,
            {
                "tenant": str(tenant) if tenant else None,
                "hours": hours,
                "retire_days": RETIRE_AFTER_DAYS,
            },
        )
    )
    return [
        {
            "bucket": r["bucket"],
            "category": r["category"],
            "samples": int(r["samples"]),
            "points": int(r["points"]),
        }
        for r in rows
    ]


# ── Devices ──────────────────────────────────────────────────────────────────

_DEVICES_SQL = """
    SELECT p.device_id                                     AS device_id,
           max(p.device_tag)                               AS device_tag,
           max(p.category)                                 AS category,
           max(p.device_type)                              AS device_type,
           count(*)                                        AS points,
           count(*) FILTER (WHERE p.type = 'num')          AS numeric_points,
           count(*) FILTER (WHERE p.type = 'text')         AS text_points,
           count(*) FILTER (
               WHERE p.last_seen_at >= now() - make_interval(mins => :fresh)
           )                                               AS points_reporting,
           min(p.first_seen_at)                            AS first_seen_at,
           max(p.last_seen_at)                             AS last_seen_at,
           -- WHERE this device is, so a device-first screen can show what it is
           -- about to change and which devices have no building at all. Placement
           -- is a device-level statement, so these agree across a device's points
           -- except where an operator has overridden ONE point
           -- (`placement_source = 'point'`); `max` then reports one of the two,
           -- and the point console is where that distinction is visible.
           max(p.site_id::text)                            AS site_id,
           max(p.site_name)                                AS site_name
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND {live}
       {search}
     GROUP BY p.device_id, coalesce(p.device_id::text, p.device_tag)
    {having}
"""


#: `placement=` on `/bi/devices`. Two answers, and NEITHER of them is a default:
#: a screen asks for one explicitly or gets the whole estate. "unplaced" is the
#: list an operator works from when assigning devices to a building, and it is a
#: filter over what is ALREADY TRUE — it never becomes a selection that something
#: then acts on by itself.
PLACEMENT_FILTERS = {
    # Not one point of this device belongs to any site.
    "unplaced": "count(*) FILTER (WHERE p.site_id IS NOT NULL) = 0",
    "placed": "count(*) FILTER (WHERE p.site_id IS NOT NULL) > 0",
}


def _device_filters(
    category: str | None,
    device_type: str | None,
    search: str | None,
    placement: str | None = None,
):
    """Category/type are DEVICE facts, so they filter AFTER the grouping.

    A device can own a point the gateway never classified (this deployment has
    exactly that: `4F-5F Light DB` has six energy points and one with no
    category). Filtering point-rows before the group would drop that point out of
    the device's own count and make the device look smaller than it is. The
    device's classification is `max(category)` over its points, and HAVING is
    what filters on it.
    """
    having: list[str] = []
    params: dict = {}
    if category is not None:
        # "" selects the UNCLASSIFIED devices, which is a real, answerable
        # question ("what is reporting that nothing has classified?").
        if category == "":
            having.append("max(p.category) IS NULL")
        else:
            having.append("max(p.category) = :category")
            params["category"] = category
    if device_type:
        having.append("max(p.device_type) = :device_type")
        params["device_type"] = device_type
    if placement:
        # Placement is a device fact for the same reason category is, so it
        # filters after the grouping too: a device with one placed point and one
        # unplaced one is not two devices.
        if placement not in PLACEMENT_FILTERS:
            from kernel.errors import ValidationError  # lazy, as below

            raise ValidationError(
                f"placement must be one of: {sorted(PLACEMENT_FILTERS)}"
            )
        having.append(PLACEMENT_FILTERS[placement])
    search_sql = ""
    if search:
        search_sql = "AND p.device_tag ILIKE :search"
        params["search"] = f"%{search}%"
    return (
        ("HAVING " + " AND ".join(having)) if having else "",
        search_sql,
        params,
    )


async def devices(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    category: str | None,
    device_type: str | None,
    search: str | None,
    limit: int,
    offset: int,
    include_retired: bool = False,
    site_id: uuid.UUID | None = None,
    placement: str | None = None,
) -> tuple[int, list[dict]]:
    having, search_sql, extra = _device_filters(
        category, device_type, search, placement
    )
    # Site scope (Portfolio drill-down). Placement is a DEVICE-level statement
    # (every point of a device carries its pin), so a plain WHERE on the point
    # rows cannot split a device the way a category filter would.
    if site_id is not None:
        search_sql += " AND p.site_id = :site_id"
        extra["site_id"] = str(site_id)
    base = _DEVICES_SQL.format(
        search=search_sql, having=having, live=_live(include_retired)
    )
    params = {
        "tenant": str(tenant) if tenant else None,
        "fresh": FRESH_MINUTES,
        "retire_days": RETIRE_AFTER_DAYS,
        **extra,
    }

    total = (
        await db.execute(text(f"SELECT count(*) FROM ({base}) d"), params)
    ).scalar_one()

    rows = _rows(
        await db.execute(
            text(f"{base} ORDER BY max(p.device_tag) LIMIT :limit OFFSET :offset"),
            {**params, "limit": limit, "offset": offset},
        )
    )
    return int(total), rows


# ── Points + their latest value ──────────────────────────────────────────────

_POINTS_SQL = """
    SELECT p.point_id, p.point_tag, p.device_id, p.device_tag, p.category,
           p.device_type, p.type, p.unit, p.first_seen_at, p.last_seen_at,
           p.retired_at,
           NOT (p.retired_at IS NULL AND (:retire_days = 0      OR p.last_seen_at >= now() - make_interval(days => :retire_days)))                     AS retired
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND {live}
       {filters}
"""

# DISTINCT ON (point_id) walks the PRIMARY KEY (point_id, ts) backwards and stops
# at the first row per point — an index scan, not a sort of the window. The
# `ts >=` bound is what keeps it bounded; without it this would degrade as the
# hypertable grows.
_LATEST_SQL = text(
    """
    SELECT DISTINCT ON (r.point_id)
           r.point_id, r.ts, r.num, r.txt, r.quality
      FROM readings r
     WHERE r.point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
       AND r.ts >= now() - make_interval(mins => :lookback)
     ORDER BY r.point_id, r.ts DESC
    """
)


async def points(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    device_id: uuid.UUID | None,
    device_tag: str | None,
    category: str | None,
    point_type: str | None,
    search: str | None,
    limit: int,
    offset: int,
    with_latest: bool,
    include_retired: bool = False,
    site_id: uuid.UUID | None = None,
) -> tuple[int, list[dict]]:
    filters: list[str] = []
    params: dict = {
        "tenant": str(tenant) if tenant else None,
        "retire_days": RETIRE_AFTER_DAYS,
    }
    if device_id is not None:
        filters.append("AND p.device_id = :device_id")
        params["device_id"] = str(device_id)
    if device_tag:
        filters.append("AND p.device_tag = :device_tag")
        params["device_tag"] = device_tag
    if category is not None:
        if category == "":
            filters.append("AND p.category IS NULL")
        else:
            filters.append("AND p.category = :category")
            params["category"] = category
    if point_type:
        filters.append("AND p.type = :point_type")
        params["point_type"] = point_type
    if site_id is not None:
        filters.append("AND p.site_id = :site_id")
        params["site_id"] = str(site_id)
    if search:
        filters.append("AND (p.point_tag ILIKE :search OR p.device_tag ILIKE :search)")
        params["search"] = f"%{search}%"

    base = _POINTS_SQL.format(
        filters=" ".join(filters), live=_live(include_retired)
    )
    total = (await db.execute(text(f"SELECT count(*) FROM ({base}) q"), params)).scalar_one()
    rows = _rows(
        await db.execute(
            text(f"{base} ORDER BY p.device_tag, p.point_tag LIMIT :limit OFFSET :offset"),
            {**params, "limit": limit, "offset": offset},
        )
    )

    if with_latest and rows:
        latest = {
            r["point_id"]: {
                "ts": r["ts"],
                "num": r["num"],
                "txt": r["txt"],
                "quality": int(r["quality"]),
            }
            for r in _rows(
                await db.execute(
                    _LATEST_SQL,
                    {
                        "pids": [r["point_id"] for r in rows],
                        "tenant": params["tenant"],
                        "lookback": LATEST_LOOKBACK_MINUTES,
                    },
                )
            )
        }
        for r in rows:
            r["latest"] = latest.get(r["point_id"])

    return int(total), rows


# ── Series ───────────────────────────────────────────────────────────────────

_ROLLUP_SQL = """
    SELECT r.point_id, r.bucket AS t, r.sample_count AS count,
           r.num_min AS min, r.num_max AS max, r.num_avg AS avg,
           r.num_first AS first, r.num_last AS last, r.txt_last
      FROM {view} r
     WHERE r.point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
       AND r.bucket >= :start AND r.bucket < :end
     ORDER BY r.point_id, r.bucket
"""

_RAW_SERIES_SQL = text(
    """
    SELECT r.point_id, r.ts AS t, 1 AS count,
           r.num AS min, r.num AS max, r.num AS avg,
           r.num AS first, r.num AS last, r.txt AS txt_last
      FROM readings r
     WHERE r.point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
       AND r.ts >= :start AND r.ts < :end
     ORDER BY r.point_id, r.ts
    """
)

_VIEWS = {"1m": "readings_1m", "1h": "readings_1h"}


def choose_resolution(start: dt.datetime, end: dt.datetime) -> tuple[str, str]:
    """Pick the store for a window, and say why in words the UI can print.

    * ≤ 3 hours  → `readings_1m`. It is `materialized_only` with a ~2 minute
      freshness floor, so the newest minute or two of a chart can be missing.
      For a shape-over-time chart that is invisible; for a live NUMBER it is not,
      which is why the current value comes from raw instead.
    * > 3 hours  → `readings_1h`, a REAL-TIME aggregate: the current partial hour
      is included and current.

    Raw is never chosen automatically. A caller has to ask for it, and then only
    inside `RAW_MAX_MINUTES`.
    """
    span_min = (end - start).total_seconds() / 60.0
    if span_min <= 180:
        return "1m", (
            "1-minute rollup (readings_1m); materialized-only, so the newest "
            "~2 minutes may not be included yet"
        )
    return "1h", "1-hour rollup (readings_1h); real-time aggregate, current hour included"


async def series(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    point_ids: list[uuid.UUID],
    start: dt.datetime,
    end: dt.datetime,
    resolution: str,
) -> dict[uuid.UUID, list[dict]]:
    params = {
        "pids": [str(p) for p in point_ids],
        "tenant": str(tenant) if tenant else None,
        "start": start,
        "end": end,
    }
    if resolution == "raw":
        rows = _rows(await db.execute(_RAW_SERIES_SQL, params))
    else:
        stmt = text(_ROLLUP_SQL.format(view=_VIEWS[resolution]))
        rows = _rows(await db.execute(stmt, params))

    out: dict[uuid.UUID, list[dict]] = {p: [] for p in point_ids}
    for r in rows:
        bucket = {
            "t": r["t"],
            "count": int(r["count"] or 0),
            "min": r["min"],
            "max": r["max"],
            "avg": r["avg"],
            "first": r["first"],
            "last": r["last"],
            "txt_last": r["txt_last"],
        }
        series_rows = out.setdefault(r["point_id"], [])
        if len(series_rows) < MAX_BUCKETS_PER_SERIES:
            series_rows.append(bucket)
    return out


_POINT_META_SQL = text(
    """
    SELECT p.point_id, p.point_tag, p.device_tag, p.unit, p.category, p.device_id
      FROM points p
     WHERE p.point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
    """
)


async def point_meta(
    db: AsyncSession, tenant: uuid.UUID | None, point_ids: list[uuid.UUID]
) -> dict[uuid.UUID, dict]:
    """Tags for the series legend — and the tenant CHECK for the series call.

    A point that does not resolve here does not belong to the caller's tenant (or
    does not exist), and the router drops it before any reading is read. That is
    the single place cross-tenant access is prevented for `/series`, so it must
    not be skipped as "just labels".
    """
    rows = _rows(
        await db.execute(
            _POINT_META_SQL,
            {"pids": [str(p) for p in point_ids], "tenant": str(tenant) if tenant else None},
        )
    )
    return {r["point_id"]: r for r in rows}


# ── Widget spec execution moved out ──────────────────────────────────────────
#
# The dashboard builder's queries USED to live here as hand-written statements
# over `points` + the rollups (`scope_points`, `aggregate_by_point`,
# `aggregate_by_group`). They were IoT-shaped by construction — a `scope` of
# points / device / category / all — and could not chart a door-access event or a
# fire panel state.
#
# They are gone, not kept as a second path. A widget's SQL is now GENERATED from
# builder state against a registered dataset (`registry.py` + `sqlgen.py` +
# `execute.py`), and v1 widgets are translated into that shape on read
# (`builder.migrate_v1`). Two executors would be two places the honesty rules of
# contract §4 have to be kept true, and one of them would drift.
#
# What remains in this file is what the HAND-BUILT BI screens use — /summary,
# /activity, /devices, /points, /series. Those are fixed screens with fixed
# questions, not a builder, and they are not generated.


# ── Retirement ───────────────────────────────────────────────────────────────
# The ONLY write in this module, and it writes one nullable timestamp on the
# dimension row. It never touches `readings`: retiring a point removes it from
# the counts, not from the record. See LIVE_POINT for what "retired" means.

_SET_RETIRED_SQL = text(
    """
    UPDATE points p
       SET retired_at = CASE WHEN :retired THEN now() ELSE NULL END
     WHERE p.point_id = :point_id
       AND (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
    RETURNING p.point_id, p.point_tag, p.device_tag, p.last_seen_at, p.retired_at
    """
)


async def set_retired(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    point_id: uuid.UUID,
    *,
    retired: bool,
) -> dict:
    """Set or clear `points.retired_at`. Tenant-scoped; raises if there is no such point."""
    from kernel.errors import NotFoundError

    row = (
        await db.execute(
            _SET_RETIRED_SQL,
            {
                "retired": retired,
                "point_id": str(point_id),
                "tenant": str(tenant) if tenant else None,
            },
        )
    ).mappings().first()
    if row is None:
        raise NotFoundError(f"no point {point_id}")
    await db.commit()
    return {
        "point_id": str(row["point_id"]),
        "point_tag": row["point_tag"],
        "device_tag": row["device_tag"],
        "last_seen_at": row["last_seen_at"],
        "retired_at": row["retired_at"],
        # True by either route, so the caller sees the effective state rather
        # than only the flag it just wrote.
        "retired": row["retired_at"] is not None
        or (
            RETIRE_AFTER_DAYS > 0
            and row["last_seen_at"] is not None
            and (dt.datetime.now(dt.timezone.utc) - row["last_seen_at"]).days
            >= RETIRE_AFTER_DAYS
        ),
    }


# ── Ghost points ─────────────────────────────────────────────────────────────
#
# THE SHAPE OF THE PROBLEM, measured on this deployment rather than reasoned
# about: 766 rows with `retired_at IS NULL` against 475 distinct
# `(device_tag, point_tag)` pairs. 283 pairs are duplicated, spanning 574 rows.
#
# Nothing here is a gateway bug. A conflux connection that is deleted and
# re-created mints a NEW `point_id` for every point behind it — the id belongs to
# the connection, not to the meter — and the writer's upsert must create a
# dimension row for an id it has never seen (contract §6), or it would be
# dropping readings. Sometimes the tag spelling changes across the rebuild too.
# So one physical register accumulates a GENERATION per rebuild, every one of
# them unretired, every one of them counted.
#
# WHY THE RETIREMENT HORIZON DOES NOT ALREADY COVER IT. The horizon (see
# LIVE_POINT) is applied at query time on `last_seen_at`, so a ghost does stop
# being COUNTED after RETIRE_AFTER_DAYS. It never stops being a row: it is still
# `retired_at IS NULL`, it is still in the browse list, nothing records that it
# was superseded, and its history is unreachable from the point that replaced it.
# The horizon answers "is this reporting". It cannot answer "which row IS this
# meter now", and that is the question an estate count is really asking.
#
# THE DUPLICATE SET IS DELIBERATELY NOT THE LIVE SET. The grouping below filters
# on `retired_at IS NULL` alone and does NOT apply LIVE_POINT. Applying the
# horizon would hide exactly the members this feature exists to find — a ghost
# has not reported in weeks, which is the whole reason it is a ghost — and every
# duplicated pair would collapse to one apparent member and vanish from the
# worklist.

_GHOST_MEMBERS_SQL = text(
    """
    WITH candidate AS (
        SELECT p.point_id,
               p.device_tag,
               p.point_tag,
               p.category,
               p.unit,
               p.site_id,
               -- WHEN THIS GENERATION STARTED, and how much it carries. Without
               -- both, a group whose members have all gone quiet offers an
               -- operator two uuids and two timestamps minutes apart, which is
               -- not a question a human can answer. WITH them the question is
               -- ordinary: one generation ran for months and holds the history,
               -- the other appeared at a rebuild.
               p.first_seen_at,
               p.last_seen_at,
               p.last_seen_at >= now() - make_interval(mins => :fresh) AS fresh,
               r.point_id IS NOT NULL                                  AS has_role,
               r.role                                                  AS role
          FROM points p
          -- One row at most: `point_roles` is keyed by point_id alone, so this
          -- join cannot fan a member out into several.
          LEFT JOIN point_roles r ON r.point_id = p.point_id
         WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
           AND p.retired_at IS NULL
           -- A NULL tag cannot identify a duplicate of anything. Grouping NULLs
           -- together would merge every unlabelled point on the estate into one
           -- enormous bogus group.
           AND p.device_tag IS NOT NULL
           AND p.point_tag IS NOT NULL
           AND (CAST(:category AS text) IS NULL OR p.category = CAST(:category AS text))
    ),
    duplicated AS (
        SELECT device_tag, point_tag
          FROM candidate
         GROUP BY device_tag, point_tag
        HAVING count(*) > 1
    )
    SELECT c.*,
           -- Off `readings_1h`, never off `readings`: the raw hypertable is
           -- compressed and counting it per member would scan chunks. The
           -- aggregate already holds the count, and the set here is only the
           -- duplicated members, never the estate.
           COALESCE(v.readings, 0)::bigint AS readings
      FROM candidate c
      JOIN duplicated d USING (device_tag, point_tag)
      LEFT JOIN LATERAL (
          SELECT sum(r.sample_count) AS readings
            FROM readings_1h r
           WHERE r.point_id = c.point_id
      ) v ON TRUE
     -- Newest first WITHIN a group, so the member a human reads first is the one
     -- most likely to be the survivor. NULLS LAST is defensive: `last_seen_at`
     -- is NOT NULL in the schema.
     ORDER BY c.device_tag, c.point_tag, c.last_seen_at DESC NULLS LAST
    """
)

# The state decision 4 refuses to paper over: a point the collapse superseded
# that is REPORTING again. The writer clears `retired_at` when a reading actually
# stores and deliberately does not name `superseded_by`, so this row comes back
# as live while still pointing at its survivor. Two generations of one register
# are both talking, which is a fact an operator has to act on — so it is surfaced
# here rather than repaired silently.
_GHOST_RESURRECTED_SQL = text(
    """
    SELECT p.point_id,
           p.device_tag,
           p.point_tag,
           p.category,
           p.last_seen_at,
           p.superseded_by
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND p.superseded_by IS NOT NULL
       AND p.retired_at IS NULL
       AND (CAST(:category AS text) IS NULL OR p.category = CAST(:category AS text))
       -- A resurrected point is ONE point, so unlike a ghost group it has one
       -- placement and a plain predicate is the honest site scope.
       AND (CAST(:site AS uuid) IS NULL OR p.site_id = CAST(:site AS uuid))
     ORDER BY p.last_seen_at DESC
    """
)


def _classify(members: list[dict]) -> tuple[str, uuid.UUID | None]:
    """AUTO or MANUAL, and the survivor when there is one.

    The rule is deliberately the narrowest one that is defensible: a group is
    AUTO only when EXACTLY ONE member is fresh. That member is the generation the
    gateway is currently writing to, so the others are provably superseded rather
    than merely older.

    Everything else is MANUAL, and there are two kinds:

      * ZERO fresh members — the whole register has stopped reporting. Which
        generation "survives" is then a question about the building, not about
        the data; picking the newest `last_seen_at` would be a guess that reads
        like a fact. 19 of the 283 duplicated pairs here are in this state.
      * MORE THAN ONE fresh member — two generations are both delivering right
        now, which usually means a cutover in progress or a genuinely duplicated
        tag. Collapsing one into the other would destroy a live series. There are
        none on this deployment today; the branch exists because the state is
        reachable the moment a connection is rebuilt.

    Nothing is ever auto-applied to a MANUAL group.
    """
    fresh = [m for m in members if m["fresh"]]
    if len(fresh) == 1:
        return "auto", fresh[0]["point_id"]
    return "manual", None


async def ghost_groups(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    category: str | None = None,
    mode: str | None = None,
    site_id: uuid.UUID | None = None,
) -> list[dict]:
    """Every duplicated `(device_tag, point_tag)`, with its members and a verdict.

    One entry per duplicated pair. `mode` filters the RESULT, not the grouping —
    a group is classified over all of its members and then kept or dropped — so
    asking for `mode="auto"` can never change which members a group has.

    `category` DOES filter before the grouping, and that is the intended
    semantics: "show me the ghosts in Energy & Metering" is a question about
    duplication within that view. Category is a device-level attribute, so
    members of a real group share it in practice; a group whose generations were
    reclassified between rebuilds is split by this filter and shows up in
    whichever category has two or more members left.

    Tenant-scoped like everything else here: the duplicate set is computed
    INSIDE the tenant, so two tenants that happen to use the same device tag are
    never each other's ghosts.

    `site_id` does NOT filter before the grouping, and that asymmetry with
    `category` is deliberate. Generations of one register routinely sit in
    different places: the dead one was placed, the live one arrived after the
    rebuild and has no site yet. Measured on this estate, 44 of the 45 remaining
    duplicated pairs span more than one placement. Filtering members first would
    split each of those into a single-member "group", which is no longer a
    duplicate and silently vanishes — so a building's view would show almost none
    of the ghosts that are inflating that building. Instead a group is KEPT when
    any member is at the site, and it keeps ALL of its members, so its
    classification is the same one the estate view gives.
    """
    rows = _rows(
        await db.execute(
            _GHOST_MEMBERS_SQL,
            {
                "tenant": str(tenant) if tenant else None,
                "category": category,
                "fresh": FRESH_MINUTES,
            },
        )
    )

    grouped: dict[tuple[str, str], list[dict]] = {}
    for row in rows:
        grouped.setdefault((row["device_tag"], row["point_tag"]), []).append(row)

    out: list[dict] = []
    want_site = str(site_id) if site_id else None
    for (device_tag, point_tag), members in grouped.items():
        if want_site is not None and not any(
            m.get("site_id") is not None and str(m["site_id"]) == want_site
            for m in members
        ):
            continue
        group_mode, survivor = _classify(members)
        if mode is not None and mode != group_mode:
            continue
        out.append(
            {
                "device_tag": device_tag,
                "point_tag": point_tag,
                # The category of the group, as far as the members agree. They
                # disagree only when a rebuild reclassified the device, and the
                # honest answer then is the one the first member carries rather
                # than a merged label nothing said.
                "category": members[0]["category"],
                "mode": group_mode,
                "survivor_point_id": survivor,
                "members": [
                    {
                        "point_id": m["point_id"],
                        "first_seen_at": m["first_seen_at"],
                        "last_seen_at": m["last_seen_at"],
                        # What the member CARRIES, so the console can say "252
                        # days, 331k readings" instead of showing a uuid twice.
                        "readings": int(m["readings"] or 0),
                        "unit": m["unit"],
                        "fresh": bool(m["fresh"]),
                        "has_role": bool(m["has_role"]),
                        "role": m["role"],
                    }
                    for m in members
                ],
            }
        )
    return out


async def resurrected_points(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    category: str | None = None,
    site_id: uuid.UUID | None = None,
) -> list[dict]:
    """Points that were superseded and are reporting again — see the SQL above."""
    return _rows(
        await db.execute(
            _GHOST_RESURRECTED_SQL,
            {
                "tenant": str(tenant) if tenant else None,
                "category": category,
                "site": str(site_id) if site_id else None,
            },
        )
    )


# ── Collapsing a ghost group ─────────────────────────────────────────────────
#
# Three statements, in this order, per group. The order is not arbitrary: the
# role INSERT reads the ghosts' rows, so it has to run before the DELETE that
# removes them.

# Move a role from the ghosts onto the survivor.
#
# `point_roles` is keyed by `point_id` ALONE, so a point carries at most one
# role and the survivor either has one or does not. `ON CONFLICT DO NOTHING` is
# therefore the whole of the "do not create a duplicate role" rule AND the whole
# of "a survivor that already carries a role wins": the insert is a no-op, the
# ghost's row is dropped by the next statement, and the operator's assertion
# about the surviving point is never overwritten by an older generation's.
#
# LIMIT 1 over the ghosts, newest assertion first: when two ghosts carry roles
# only one can land, and the most recent statement is the better one to keep.
# The `RETURNING` is what makes the count honest — it reports rows that actually
# landed, not rows that were offered.
_MIGRATE_ROLE_SQL = text(
    """
    WITH ghost_role AS (
        SELECT r.tenant_id, r.role, r.role_source, r.confirmed_by, r.confirmed_at
          FROM point_roles r
         WHERE r.point_id = ANY(CAST(:ghosts AS uuid[]))
           AND (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
         ORDER BY r.confirmed_at DESC
         LIMIT 1
    )
    INSERT INTO point_roles (point_id, tenant_id, role, role_source, confirmed_by, confirmed_at)
    SELECT CAST(:survivor AS uuid), g.tenant_id, g.role, g.role_source, g.confirmed_by, g.confirmed_at
      FROM ghost_role g
    ON CONFLICT (point_id) DO NOTHING
    RETURNING point_id
    """
)

# Whatever the survivor did or did not absorb, the ghosts keep no role. A role is
# "what this point MEANS", and a superseded generation means nothing any more —
# leaving the row would let a metric definition select a retired point.
_DROP_GHOST_ROLES_SQL = text(
    """
    DELETE FROM point_roles r
     WHERE r.point_id = ANY(CAST(:ghosts AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
    RETURNING r.point_id
    """
)

# The retire itself. Three columns, no deletes, no readings touched — which is
# what makes the whole operation reversible by clearing the same three.
_RETIRE_GHOSTS_SQL = text(
    """
    UPDATE points p
       SET retired_at = now(),
           retire_reason = 'ghost',
           superseded_by = CAST(:survivor AS uuid)
     WHERE p.point_id = ANY(CAST(:ghosts AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
    RETURNING p.point_id
    """
)


async def collapse_ghost_group(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    survivor_point_id: uuid.UUID,
    ghost_point_ids: list[uuid.UUID],
) -> dict:
    """Retire one group's ghosts onto its survivor. ONE TRANSACTION.

    The three statements are committed together and rolled back together. A
    half-collapsed group — roles moved but the ghosts still live, or ghosts
    retired with their roles still pointing at dead rows — would be worse than
    not collapsing at all, because nothing downstream could tell it had happened.

    The caller is responsible for having VALIDATED the group first (see
    `collapse_ghosts`): by the time this runs, the survivor is known to be a
    member and the ghosts are known to be its siblings in the caller's tenant.
    """
    params = {
        "survivor": str(survivor_point_id),
        "ghosts": [str(p) for p in ghost_point_ids],
        "tenant": str(tenant) if tenant else None,
    }
    try:
        migrated = _rows(await db.execute(_MIGRATE_ROLE_SQL, params))
        dropped = _rows(await db.execute(_DROP_GHOST_ROLES_SQL, params))
        retired = _rows(await db.execute(_RETIRE_GHOSTS_SQL, params))
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return {
        "survivor_point_id": survivor_point_id,
        "points_retired": len(retired),
        # Landed on the survivor.
        "roles_migrated": len(migrated),
        # Removed from the ghosts WITHOUT landing — the survivor already carried
        # a role, so the older generation's assertion was discarded. Reported
        # separately because it is a loss, and an operator should see it.
        "roles_discarded": max(0, len(dropped) - len(migrated)),
    }


async def collapse_ghosts(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    mode: str | None = None,
    choices: list[dict] | None = None,
) -> dict:
    """Collapse every AUTO group, or an explicit list the operator chose.

    Exactly one of `mode` and `choices` is meaningful; the router enforces that.

    VALIDATION HAPPENS FIRST, FOR ALL GROUPS. Every explicit choice is resolved
    against the live duplicate set before a single statement runs, and a bad
    survivor raises out of this function with nothing written. Validating as we
    go would leave the groups before the bad one collapsed and the ones after it
    untouched — a partial apply the operator never asked for and cannot see.

    A group the caller named that is NOT a duplicated pair in their tenant is
    SKIPPED with a reason rather than refused: the worklist it was read from can
    legitimately go stale between the GET and the POST — a rebuild retires a
    member, or another operator collapsed it first — and failing the whole batch
    for that would make the screen unusable. Naming a survivor that is not a
    member is different: that is a claim about identity that was never true, so
    it raises.
    """
    from kernel.errors import ValidationError

    groups = await ghost_groups(db, tenant)
    by_pair = {(g["device_tag"], g["point_tag"]): g for g in groups}

    planned: list[tuple[dict, uuid.UUID]] = []
    skipped: list[dict] = []

    if choices is None:
        # `mode="auto"`: every group the classifier called auto, and ONLY those.
        # A manual group has no `survivor_point_id` and is never reachable from
        # here — there is no fallback that picks one.
        for group in groups:
            if group["mode"] == "auto":
                planned.append((group, group["survivor_point_id"]))
    else:
        for choice in choices:
            pair = (choice["device_tag"], choice["point_tag"])
            group = by_pair.get(pair)
            if group is None:
                skipped.append(
                    {
                        "device_tag": pair[0],
                        "point_tag": pair[1],
                        "reason": "no duplicated points with these tags in this tenant",
                    }
                )
                continue
            survivor = choice["survivor_point_id"]
            if survivor not in {m["point_id"] for m in group["members"]}:
                raise ValidationError(
                    f"survivor {survivor} is not a member of "
                    f"{pair[0]}/{pair[1]} — nothing was collapsed"
                )
            planned.append((group, survivor))

    collapsed = 0
    points_retired = 0
    roles_migrated = 0
    roles_discarded = 0
    for group, survivor in planned:
        ghosts = [m["point_id"] for m in group["members"] if m["point_id"] != survivor]
        if not ghosts:
            # Cannot happen for a group read out of `ghost_groups` (every group
            # has at least two members), but a group of one is a no-op rather
            # than an error if the set ever changes underneath us.
            skipped.append(
                {
                    "device_tag": group["device_tag"],
                    "point_tag": group["point_tag"],
                    "reason": "the survivor is the only member",
                }
            )
            continue
        result = await collapse_ghost_group(
            db, tenant, survivor_point_id=survivor, ghost_point_ids=ghosts
        )
        collapsed += 1
        points_retired += result["points_retired"]
        roles_migrated += result["roles_migrated"]
        roles_discarded += result["roles_discarded"]

    return {
        "groups_collapsed": collapsed,
        "points_retired": points_retired,
        "roles_migrated": roles_migrated,
        "roles_discarded": roles_discarded,
        "groups_skipped": len(skipped),
        "skipped": skipped,
    }


# The undo, and the reason `retire_reason` exists.
#
# `retire_reason = 'ghost'` is the ONLY row this statement can reach. A point an
# operator retired by hand has a NULL reason and is untouched however loudly a
# caller names it — which is the whole safety of this route: a bulk undo of a
# collapse must not be a bulk undo of every decommissioning decision anyone ever
# made. It clears exactly the three columns the collapse wrote and nothing else,
# so a restored point is byte-for-byte back where it started.
_RESTORE_GHOSTS_SQL = text(
    """
    UPDATE points p
       SET retired_at = NULL,
           retire_reason = NULL,
           superseded_by = NULL
     WHERE p.point_id = ANY(CAST(:pids AS uuid[]))
       AND p.retire_reason = 'ghost'
       AND (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
    RETURNING p.point_id, p.device_tag, p.point_tag
    """
)


async def restore_ghosts(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    point_ids: list[uuid.UUID],
) -> dict:
    """Undo a collapse for the named points, and ONLY for the ones it retired.

    Roles are NOT put back, and that is stated rather than hidden. The collapse
    moved a ghost's role onto the survivor precisely because the survivor is the
    point that means something now; handing it back to a restored ghost would
    re-create the ambiguity a metric definition cannot resolve. An operator who
    restores a point and wants it to carry a role asserts one.
    """
    rows = _rows(
        await db.execute(
            _RESTORE_GHOSTS_SQL,
            {
                "pids": [str(p) for p in point_ids],
                "tenant": str(tenant) if tenant else None,
            },
        )
    )
    await db.commit()
    restored = {r["point_id"] for r in rows}
    return {
        "restored": len(rows),
        "requested": len(point_ids),
        "points": rows,
        # Named but not reached: retired by another route, another tenant's, or
        # not retired at all. Said out loud rather than reported as a success.
        "refused": [p for p in point_ids if p not in restored],
    }


# ── Placement ─ the operator's worklist ───────────────────────────
#
# GONE, with the BI placement screen it served. The worklist ("29 devices, 12 of
# them unplaced, pick some and choose a floor") was the read side of a second
# place to say where a device is. There is one place now: Configurations → Sites →
# floor plan. `device_locations` is fed from core's `device_placements` by
# `app/placement_sync.py`.
#
# `_PLACEMENT_SQL` above is untouched and still runs on `/bi/summary`: counting
# how much of the estate is anchored in space is a read, and it stays true no
# matter which surface did the anchoring.


# ── Faults & alerts ──────────────────────────────────────────────────────────
#
# `iot_alerts` is NOT part of the readings schema. It is created and written by
# `app.projections` from the `iot_alerts` row of `reporting_projections` (builder
# contract §9), which is why nothing here declares it in `reporting.models` and
# why the statements below are textual. Same process since 2026-09-05, still a
# different owner — a projected relation reaching `reporting.models` would be the
# first sign the fold-in blurred the two.
#
# Reading it from HERE, on the other hand, is exactly right: the reading-writer is
# the ONE read path over the whole reporting store (pipeline contract §14). A
# second query path would be the drift that rule exists to prevent.
#
# WHY A DEDICATED ENDPOINT WHEN THE DATASET IS CHARTABLE. The registered dataset
# answers "how many alerts, by severity, over time" — a chart. It deliberately
# does NOT publish `message` as a dimension, because the message carries the
# measured value ("CAvg_A at 113.46 A — above 100 A") and is therefore unique per
# alert; making it a dimension would force it into the hourly rollup's GROUP BY
# and turn that rollup into a copy of the fact table. A fault QUEUE needs the
# message, so it reads raw over a bounded window — the same trade `/bi/points`
# makes for latest values.

# The raw ceiling the `iot_alerts` dataset declares for its raw relation
# (`max_window_minutes: 2880`). Kept identical on purpose: two surfaces over one
# relation must not disagree about how far back raw may be asked.
ALERTS_MAX_HOURS = 48

_ALERTS_SQL = text(
    """
    SELECT a.ts, a.alert_id, a.severity, a.alert_type, a.device_tag,
           a.device_category, a.device_type, a.device_id, a.point_id,
           a.point_addr, a.message, a.conn_slug, a.proto
      FROM iot_alerts a
     WHERE (CAST(:tenant AS uuid) IS NULL OR a.tenant_id = CAST(:tenant AS uuid))
       AND a.ts >= :start AND a.ts < :end
       AND (CAST(:severity AS text) IS NULL OR a.severity = CAST(:severity AS text))
       AND (CAST(:category AS text) IS NULL
            OR a.device_category = CAST(:category AS text))
     ORDER BY a.ts DESC
     LIMIT :limit
    """
)

_ALERTS_ROLLUP_SQL = text(
    """
    SELECT a.severity, count(*) AS alerts, count(DISTINCT a.device_tag) AS devices,
           max(a.ts) AS last_at
      FROM iot_alerts a
     WHERE (CAST(:tenant AS uuid) IS NULL OR a.tenant_id = CAST(:tenant AS uuid))
       AND a.ts >= :start AND a.ts < :end
     GROUP BY a.severity
     ORDER BY alerts DESC
    """
)

# The breakdown the widened wire made possible. Both counts are over the WHOLE
# window and neither is filtered by `severity` — the same choice `by_severity`
# makes, so a screen can show one breakdown while a filter narrows the list.
#
# NULLS LAST: a device with no classification sorts to the end rather than being
# hidden or relabelled. Absence renders as absence (builder contract §4).
_ALERTS_CATEGORY_SQL = text(
    """
    SELECT a.device_category AS category, count(*) AS alerts,
           count(DISTINCT a.device_tag) AS devices, max(a.ts) AS last_at
      FROM iot_alerts a
     WHERE (CAST(:tenant AS uuid) IS NULL OR a.tenant_id = CAST(:tenant AS uuid))
       AND a.ts >= :start AND a.ts < :end
     GROUP BY a.device_category
     ORDER BY alerts DESC, category NULLS LAST
    """
)


async def alerts(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    hours: int,
    severity: str | None,
    limit: int,
    category: str | None = None,
) -> dict:
    """The fault queue: every alert in a bounded window, newest first.

    Returns `available: false` rather than raising when the relation does not
    exist. That is not defensive noise — a projection is DATA, so a deployment can
    legitimately have it disabled or not yet reloaded, and the honest answer to
    "show me the faults" in that state is "nothing is collecting them", not a 500
    that reads as a broken screen. The reason travels with the answer.
    """
    end = dt.datetime.now(dt.timezone.utc)
    start = end - dt.timedelta(hours=hours)
    params = {
        "tenant": str(tenant) if tenant else None,
        "start": start,
        "end": end,
        "severity": severity,
        "category": category,
        "limit": limit,
    }
    try:
        items = _rows(await db.execute(_ALERTS_SQL, params))
        by_sev = _rows(await db.execute(_ALERTS_ROLLUP_SQL, params))
        by_cat = _rows(await db.execute(_ALERTS_CATEGORY_SQL, params))
    except Exception as exc:  # noqa: BLE001 — narrowed below; anything else re-raises
        # Two shapes of "not collected yet", and they must not be told apart from
        # a real fault: the relation missing (no projection at all) and a COLUMN
        # missing (a projection older than migration 0011, which is legitimate —
        # a spec is data and reaches a deployment on the registry's own reload
        # clock, not on a release's). Either way the honest answer is "nothing is
        # collecting them here", not a 500 that reads as a broken screen.
        text_of = str(exc)
        if "does not exist" not in text_of or not (
            "iot_alerts" in text_of or "device_category" in text_of
        ):
            raise
        await db.rollback()
        return {
            "available": False,
            "unavailable_reason": (
                "no alert projection is collecting into this store, or its spec "
                "predates the identity columns — the 'iot_alerts' row of "
                "reporting_projections is missing, disabled, or not yet reloaded"
            ),
            "window_hours": hours,
            "start": start,
            "end": end,
            "generated_at": end,
            "total": 0,
            "by_severity": [],
            "by_category": [],
            "items": [],
        }

    return {
        "available": True,
        "unavailable_reason": None,
        "window_hours": hours,
        "start": start,
        "end": end,
        "generated_at": end,
        # The count over the WHOLE window, so a truncated list can say "showing
        # 50 of 214" rather than presenting a page as the total.
        "total": sum(int(r["alerts"]) for r in by_sev),
        "by_severity": [
            {
                "severity": r["severity"],
                "alerts": int(r["alerts"]),
                "devices": int(r["devices"]),
                "last_at": r["last_at"],
            }
            for r in by_sev
        ],
        # `category` is None for a device the gateway never classified. That row
        # is kept: "3 energy, 1 hvac, 21 unattributed" is the truth, and dropping
        # the last number would make the first two look like the whole story.
        "by_category": [
            {
                "category": r["category"],
                "alerts": int(r["alerts"]),
                "devices": int(r["devices"]),
                "last_at": r["last_at"],
            }
            for r in by_cat
        ],
        "items": items,
    }


# ── Correlation ──────────────────────────────────────────────────────────────
#
# The arithmetic behind Building Intelligence → Insights & Correlation.
#
# WHY THIS IS HONEST WITHOUT A UNIT. Pearson's r is dimensionless: it is the
# covariance of two series divided by the product of their standard deviations,
# so every unit cancels. Two series that carry no unit still have a defined
# correlation, and the series are NOT anonymous — each one is named by the
# source's own `device_tag` / `point_tag`. "4F Khem Chiller01 / IWT against
# B2_Main Incomer / KWH is +0.62 over 168 aligned hours" is a statement about
# measured numbers, and every word of it came from the store.
#
# WHAT THE SCREEN MUST NOT DO with the number is a UI concern and is stated on
# the screen itself: r is association, not causation, and nothing here ranks
# causes or explains a bill.
#
# FOUR RULES THIS QUERY ENFORCES, because a coefficient without them misleads:
#
# 1. **It reads the ROLLUPS, never `readings`.** Same store as every chart
#    (contract §5), and the resolution is returned so the screen can print it.
#    There is no raw path: an r over raw samples would be an r over whatever
#    happened to be co-timestamped, which is not the same question.
# 2. **Only OVERLAPPING buckets count.** The join is on the bucket timestamp, so
#    two series are compared where both actually reported and nowhere else. `n`
#    — the number of buckets that overlapped — is returned with every
#    coefficient, because a 0.98 over 4 buckets is noise.
# 3. **A FROZEN series has no correlation.** Pearson divides by the standard
#    deviation; a series with one distinct value has a standard deviation of
#    zero, so r is UNDEFINED, not 0.00. Postgres `corr()` already returns NULL
#    there — the variance columns below are carried so the answer can say WHICH
#    side was flat instead of just going blank. Three of the four chillers on
#    this deployment are frozen, so this is the normal case, not the edge one.
# 4. **Absence renders as absence.** A pair with no overlapping bucket does not
#    appear in the join at all and is filled in by the caller as `no_overlap`.
#    It is never a zero.

# Below this many overlapping buckets a coefficient is not reported at all. Two
# points define a line, so r over n=2 is ±1 by construction and carries no
# information; three is the smallest n where the number means anything, and even
# then the screen prints n beside it.
MIN_CORRELATION_BUCKETS = 3

# Ceiling on how many series may be compared in one request. Pair count is
# quadratic (12 series = 66 pairs), and a matrix wider than this is unreadable
# before it is expensive.
MAX_CORRELATION_POINTS = 12

# Aligned sample pairs returned for the two-series scatter. Capped so a 90-day
# 1-minute window cannot return a million points to a browser.
MAX_SCATTER_SAMPLES = 2000

_CORR_STATS_SQL = """
    SELECT r.point_id,
           count(r.num_avg)                    AS n,
           count(DISTINCT r.num_avg)           AS distinct_values,
           min(r.num_avg)                      AS min,
           max(r.num_avg)                      AS max,
           avg(r.num_avg)                      AS mean,
           var_samp(r.num_avg)                 AS variance,
           min(r.bucket)                       AS first_bucket,
           max(r.bucket)                       AS last_bucket
      FROM {view} r
     WHERE r.point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
       AND r.bucket >= :start AND r.bucket < :end
       AND r.num_avg IS NOT NULL
     GROUP BY r.point_id
"""

# The pairwise join. `a.point_id < b.point_id` is what makes each unordered pair
# appear exactly once (r is symmetric, so the other half of the matrix is the
# same numbers mirrored and computing it twice would only be slower).
_CORR_PAIRS_SQL = """
    WITH s AS (
        SELECT r.point_id, r.bucket AS t, r.num_avg AS v
          FROM {view} r
         WHERE r.point_id = ANY(CAST(:pids AS uuid[]))
           AND (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
           AND r.bucket >= :start AND r.bucket < :end
           AND r.num_avg IS NOT NULL
    )
    SELECT a.point_id      AS a_id,
           b.point_id      AS b_id,
           count(*)        AS n,
           min(a.t)        AS overlap_start,
           max(a.t)        AS overlap_end,
           corr(a.v, b.v)  AS r,
           var_samp(a.v)   AS var_a,
           var_samp(b.v)   AS var_b
      FROM s a
      JOIN s b ON b.t = a.t AND a.point_id < b.point_id
     GROUP BY a.point_id, b.point_id
"""

# The aligned pairs themselves, for the two-series scatter. Same join, same
# buckets — the picture and the coefficient are computed from one definition of
# "overlapping", so they cannot disagree.
_CORR_SCATTER_SQL = """
    WITH s AS (
        SELECT r.point_id, r.bucket AS t, r.num_avg AS v
          FROM {view} r
         WHERE r.point_id = ANY(CAST(:pids AS uuid[]))
           AND (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
           AND r.bucket >= :start AND r.bucket < :end
           AND r.num_avg IS NOT NULL
    )
    SELECT a.t AS t, a.v AS a, b.v AS b
      FROM s a
      JOIN s b ON b.t = a.t AND a.point_id = CAST(:a_id AS uuid) AND b.point_id = CAST(:b_id AS uuid)
     ORDER BY a.t
     LIMIT :limit
"""


async def correlation_stats(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    point_ids: list[uuid.UUID],
    start: dt.datetime,
    end: dt.datetime,
    resolution: str,
) -> dict[uuid.UUID, dict]:
    """Per-series shape over the window: n, spread, and whether it is FROZEN.

    A point with no row here reported nothing in the window; a point with
    `distinct_values = 1` reported the same number every time, which is what
    makes its correlation undefined rather than zero.
    """
    rows = _rows(
        await db.execute(
            text(_CORR_STATS_SQL.format(view=_VIEWS[resolution])),
            {
                "pids": [str(p) for p in point_ids],
                "tenant": str(tenant) if tenant else None,
                "start": start,
                "end": end,
            },
        )
    )
    return {r["point_id"]: r for r in rows}


async def correlation_pairs(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    point_ids: list[uuid.UUID],
    start: dt.datetime,
    end: dt.datetime,
    resolution: str,
) -> list[dict]:
    """Pearson r per unordered pair, over the buckets both series actually filled."""
    return _rows(
        await db.execute(
            text(_CORR_PAIRS_SQL.format(view=_VIEWS[resolution])),
            {
                "pids": [str(p) for p in point_ids],
                "tenant": str(tenant) if tenant else None,
                "start": start,
                "end": end,
            },
        )
    )


async def correlation_scatter(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    a_id: uuid.UUID,
    b_id: uuid.UUID,
    start: dt.datetime,
    end: dt.datetime,
    resolution: str,
) -> list[dict]:
    """The aligned (bucket, a, b) triples behind one pair's coefficient."""
    return _rows(
        await db.execute(
            text(_CORR_SCATTER_SQL.format(view=_VIEWS[resolution])),
            {
                "pids": [str(a_id), str(b_id)],
                "tenant": str(tenant) if tenant else None,
                "start": start,
                "end": end,
                "a_id": str(a_id),
                "b_id": str(b_id),
                "limit": MAX_SCATTER_SAMPLES,
            },
        )
    )
