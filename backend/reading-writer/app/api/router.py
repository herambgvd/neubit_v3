"""Building Intelligence read API — `{api_prefix}/bi/...`.

Why it lives in the reading-writer rather than in a new service: contract §7 gives
the readings schema ONE owner, and the platform bans cross-service reads. A
separate "analytics API" container would have to open `neubit_reporting` and
SELECT tables it does not own, which is the second place a schema drifts. So the
owner serves the reads, importing the same `reporting.models`, and everything
here is SELECT-only.

Authorization is the pattern every other satellite uses (`ingest`'s router is the
worked example): the core-minted JWT is verified LOCALLY with the shared secret,
`bi.read` is the permission key, and the tenant comes from the token claim. It is
not a query parameter a caller can set — see `_tenant()`.

Gating, applied where the router is mounted (see `app.main`):
    require_feature("analytics")   the Dashboards & Reports module
    require_active_license()       suspended tenant / expired licence
    require_permission("bi.read")  per-route, like ingest gates ingest.read
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Annotated, get_args

from fastapi import APIRouter, Depends, Query
from kernel.auth import Principal, Scope, get_principal, get_scope, require_permission
from kernel.errors import ForbiddenError, ValidationError
from reporting.db import get_db
from sqlalchemy.ext.asyncio import AsyncSession

from . import builder
from . import context
from . import execute as ex
from . import permsync
from . import queries as q
from . import rating as rt
from . import units as un
from . import registry
from . import spec as widget_spec
from .schemas import (
    ActivityBucket,
    AlertListResponse,
    ConfirmUnitsRequest,
    CorrelationResponse,
    DeviceListResponse,
    PointListResponse,
    RatingResponse,
    SeriesResponse,
    SiteFactsListResponse,
    SummaryResponse,
    UnitListResponse,
)
from .spec import TableResult as QueryResult

# The permission key this API gates on. Registered in core's catalog
# (`app/auth/permissions.py`, group "Building Intelligence") so a tenant admin can
# actually grant it in the role editor — a key no catalog knows about can only
# ever be held by a wildcard admin.
PERM_READ = "bi.read"
# The WRITE key. It gates retiring/unretiring a point — an operator's statement
# about what is part of the estate, rather than a reading of it, and one that
# never touches a measurement. It used to gate PLACING a device too; placement
# now happens on the Sites floor plan and is gated by core's own sites
# permissions there. Registered in core's catalog beside bi.read.
PERM_MANAGE = "bi.manage"

bi_router = APIRouter(prefix="/bi", tags=["Building Intelligence"])

Db = Annotated[AsyncSession, Depends(get_db)]
Caller = Annotated[Scope, Depends(get_scope)]
Who = Annotated[Principal, Depends(get_principal)]


def _tenant(scope: Scope) -> uuid.UUID | None:
    """The tenant every query is filtered by. NEVER from the request.

    A tenant-scoped caller gets their own uuid from the JWT claim, so a request
    cannot widen its own scope. A platform super-admin has no tenant claim and
    gets NULL, which the queries read as "no tenant filter" — identical semantics
    to `kernel.auth.scoped()` everywhere else on the platform.
    """
    if scope.is_platform:
        return None
    if scope.tenant_id is None:
        # A non-superadmin token with no tenant claim cannot be scoped to
        # anything. Fail closed rather than falling through to "see everything".
        raise ValidationError("token carries no tenant")
    return scope.tenant_id


def _window(
    start: dt.datetime | None, end: dt.datetime | None, default_hours: int
) -> tuple[dt.datetime, dt.datetime]:
    now = dt.datetime.now(dt.timezone.utc)
    end = end or now
    start = start or (end - dt.timedelta(hours=default_hours))
    if end.tzinfo is None:
        end = end.replace(tzinfo=dt.timezone.utc)
    if start.tzinfo is None:
        start = start.replace(tzinfo=dt.timezone.utc)
    if start >= end:
        raise ValidationError("start must be before end")
    return start, end


# ── Portfolio ────────────────────────────────────────────────────────────────


@bi_router.get(
    "/summary",
    response_model=SummaryResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def summary(db: Db, scope: Caller) -> SummaryResponse:
    """What is reporting, by category — the Portfolio screen's whole payload.

    Read from the `points` dimension (cheap, one row per series) plus one
    real-time `readings_1h` aggregate for the current hour's volume. The raw
    hypertable is not touched.
    """
    return SummaryResponse(**await q.summary(db, _tenant(scope)))


@bi_router.get(
    "/activity",
    response_model=list[ActivityBucket],
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def activity(
    db: Db,
    scope: Caller,
    hours: Annotated[int, Query(ge=1, le=24 * 90)] = 24,
) -> list[ActivityBucket]:
    """Hourly sample volume per category, from the `readings_1h` rollup.

    This counts SAMPLES — a number the pipeline genuinely knows. It is not a
    physical quantity, because nothing on the wire says what a point measures.
    """
    return [ActivityBucket(**r) for r in await q.activity(db, _tenant(scope), hours)]


# ── Faults & alerts ─────────────────────────────────────────────────────────


@bi_router.get(
    "/alerts",
    response_model=AlertListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def alerts(
    db: Db,
    scope: Caller,
    hours: Annotated[int, Query(ge=1, le=q.ALERTS_MAX_HOURS)] = 24,
    severity: str | None = None,
    category: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> AlertListResponse:
    """The fault queue — every alert the gateway raised in a bounded window.

    Reads `iot_alerts`, which this service does NOT write: the reporting-projector
    fills it from `tenant.*.iot.alert.*` (builder contract §9). Reading it here is
    the rule, not an exception — the reading-writer is the one read path over the
    whole reporting store, and a second one is exactly the drift that rule exists
    to prevent.

    Bounded to `ALERTS_MAX_HOURS` because this reads RAW, for the same reason
    `/bi/points` does: the queue needs each alert's own message, and the hourly
    rollup deliberately does not carry it. A wider question is a chart, and the
    `iot_alerts` DATASET answers it from the rollup through `/bi/query`.

    `severity` is a plain equality filter over the gateway's own vocabulary
    (`critical` / `warning` / `info`); an unknown value returns nothing rather
    than everything. `category` filters the ITEM list the same way over the
    device's classification (`energy` / `hvac` / `water` / …); the two breakdowns
    are always over the whole window, so a narrowed list still shows what it is a
    slice of.

    Both breakdowns keep their unattributed bucket. An alert whose device carries
    no category is a real fault and is counted as `category: null`, never folded
    into a neighbouring one.
    """
    return AlertListResponse(
        **await q.alerts(
            db, _tenant(scope), hours=hours, severity=severity,
            category=category, limit=limit,
        )
    )


# ── Devices ──────────────────────────────────────────────────────────────────


@bi_router.get(
    "/devices",
    response_model=DeviceListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def devices(
    db: Db,
    scope: Caller,
    category: str | None = None,
    device_type: str | None = None,
    search: str | None = None,
    site_id: uuid.UUID | None = None,
    include_retired: bool = False,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> DeviceListResponse:
    """Devices that have REPORTED, grouped from `points`.

    `category=` (empty string) selects the devices nothing has classified — a
    real question, and the honest way to show the 8 unclassified points instead
    of quietly dropping them.
    """
    total, rows = await q.devices(
        db,
        _tenant(scope),
        category=category,
        device_type=device_type,
        search=search,
        limit=limit,
        offset=offset,
        include_retired=include_retired,
        # Portfolio drill-down: scope to the points placed at one site. There is
        # no "unplaced" sentinel here — the unplaced row links to the floor
        # plan, because its fix is placement, not a filtered console.
        site_id=site_id,
    )
    return DeviceListResponse(total=total, items=rows)


# ── Points ───────────────────────────────────────────────────────────────────


@bi_router.get(
    "/points",
    response_model=PointListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def points(
    db: Db,
    scope: Caller,
    device_id: uuid.UUID | None = None,
    device_tag: str | None = None,
    category: str | None = None,
    type: str | None = None,
    search: str | None = None,
    site_id: uuid.UUID | None = None,
    with_latest: bool = True,
    include_retired: bool = False,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> PointListResponse:
    """A device's points, each with its latest value.

    `latest` reads RAW over a bounded lookback, not `readings_1m`: that rollup is
    materialized-only with a ~2 minute freshness floor, and a current-value tile
    that is two minutes behind the building is a different product. The window is
    bounded (`LATEST_LOOKBACK_MINUTES`) so the cost does not grow with history —
    it is an index scan down the `(point_id, ts)` primary key per point.

    A point with nothing inside the window returns `latest: null`. It does NOT
    return an older value: presenting an hours-old reading as the current one is
    the same class of lie as inventing a unit.
    """
    total, rows = await q.points(
        db,
        _tenant(scope),
        device_id=device_id,
        device_tag=device_tag,
        category=category,
        point_type=type,
        search=search,
        limit=limit,
        offset=offset,
        with_latest=with_latest,
        include_retired=include_retired,
        site_id=site_id,
    )
    return PointListResponse(
        total=total,
        items=rows,
        latest_lookback_minutes=q.LATEST_LOOKBACK_MINUTES,
    )


@bi_router.post(
    "/points/{point_id}/retire",
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def retire_point(db: Db, scope: Caller, point_id: uuid.UUID) -> dict:
    """Retire a point: stop counting it, delete nothing.

    A point that stops reporting used to count toward every Building
    Intelligence figure forever, and the only way out was to DELETE the
    dimension row — which orphans its readings, because `readings` has no
    foreign key to `points`. This sets `retired_at` instead: the point drops out
    of the summary, the device rollups and the activity chart, and every reading
    it ever produced stays exactly where it is and is still queryable by id.

    It is not permanent. The writer clears `retired_at` on the next reading,
    because a point that is reporting is not retired whatever anyone said about
    it last month. Retiring a LIVE point therefore hides it only until it speaks
    again — which is the honest behaviour, not a bug.

    Tenant-scoped: a caller can only retire a point in their own tenant.
    """
    return await q.set_retired(db, _tenant(scope), point_id, retired=True)


@bi_router.post(
    "/points/{point_id}/unretire",
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def unretire_point(db: Db, scope: Caller, point_id: uuid.UUID) -> dict:
    """Undo an explicit retire, restoring the point to the counts.

    Clears `retired_at` only. It cannot bring back a point that is retired by the
    `last_seen_at` HORIZON — nothing but a new reading can do that, and that is
    the point of the horizon.
    """
    return await q.set_retired(db, _tenant(scope), point_id, retired=False)


# ── Placement ────────────────────────────────────────────────────────────────
#
# THERE IS NO PLACEMENT API HERE ANY MORE, AND THAT IS THE POINT.
#
# Placing a device already had a home before this store existed: Configurations →
# Sites → floor plan, backed by `neubit_control.device_placements`, which carries
# `site_id` / `floor_id` / `zone_id` beside the pin's `{x, y, rotation}`. A second
# BI-only placement screen writing `device_locations` directly was the same fact
# stated twice, with nothing to stop the two disagreeing.
#
# So `device_placements` is the source of truth and `device_locations` is this
# store's local READ-MODEL of it, fed by `app/placement_sync.py` — a durable
# consumer of core's `tenant.*.sites.device_placement.>` events. The rules that
# used to live on these routes did not go away; they moved:
#
# 1. **Names come from core, never from the client.** Core now publishes the
#    site / floor / zone NAME beside the id on the event, read from its own rows.
#    That is stronger than the HTTP round-trip this module used to make: the
#    authority states the label rather than being asked to confirm one.
# 2. **Unplaced is a state, not a gap.** Nothing infers a floor from a tag, and a
#    device with no pin has no `device_locations` row and no placed points.
# 3. **A placement is never overwritten by a reading.** Unchanged — the points
#    upsert never names these columns and `reconcile_placement` reads only
#    `device_locations`.
#
# WHAT IS GONE WITH THEM, STATED RATHER THAN HIDDEN:
#
# * **Site-without-floor placement.** `device_placements.floor_id` is NOT NULL, so
#   a rooftop meter that belongs to the building and to no storey can no longer be
#   expressed. `device_locations` still MODELS it (floor is nullable) and the
#   reconcile still handles it; nothing can write it.
# * **The point-level override.** `/placement/points` was the only way to say
#   "this sub-meter is not where its panel is". `reconcile_placement` still
#   refuses to touch a row marked `placement_source = 'point'`, and
#   `placement.place_points` / `reset_points` still exist — but no route reaches
#   them, so today the capability is unreachable outside SQL.



# ── Series ───────────────────────────────────────────────────────────────────


@bi_router.get(
    "/series",
    response_model=SeriesResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def series(
    db: Db,
    scope: Caller,
    point_id: Annotated[list[uuid.UUID], Query(min_length=1)],
    start: dt.datetime | None = None,
    end: dt.datetime | None = None,
    resolution: str = "auto",
    hours: Annotated[int, Query(ge=1, le=24 * 90)] = 6,
) -> SeriesResponse:
    """One or more point series over a window, read from a CONTINUOUS AGGREGATE.

    `resolution=auto` (the default, and what every screen uses) picks `1m` for a
    window up to 3 hours and `1h` beyond it — see `queries.choose_resolution` for
    what each one costs in freshness. `raw` is available for drill-down but only
    inside `RAW_MAX_MINUTES`; a wider raw request is a 400 naming the rollup to
    ask for instead, because silently downgrading it would make the chart claim a
    precision it does not have.
    """
    tenant = _tenant(scope)
    if len(point_id) > q.MAX_SERIES_POINTS:
        raise ValidationError(f"at most {q.MAX_SERIES_POINTS} points per request")

    start_at, end_at = _window(start, end, hours)

    if resolution == "auto":
        resolution, reason = q.choose_resolution(start_at, end_at)
    elif resolution == "raw":
        span_min = (end_at - start_at).total_seconds() / 60.0
        if span_min > q.RAW_MAX_MINUTES:
            raise ValidationError(
                f"raw readings are limited to {q.RAW_MAX_MINUTES} minutes "
                f"(asked for {int(span_min)}); use resolution=1m or 1h"
            )
        reason = "raw readings (bounded window) — every sample, no aggregation"
    elif resolution in ("1m", "1h"):
        reason = (
            "1-minute rollup (readings_1m); materialized-only, so the newest "
            "~2 minutes may not be included yet"
            if resolution == "1m"
            else "1-hour rollup (readings_1h); real-time aggregate, current hour included"
        )
    else:
        raise ValidationError("resolution must be one of: auto, 1m, 1h, raw")

    # Resolve the labels FIRST. This doubles as the tenant check: a point that
    # does not come back here is not the caller's, and is dropped before a single
    # reading is read.
    meta = await q.point_meta(db, tenant, point_id)
    allowed = [p for p in point_id if p in meta]
    if not allowed:
        return SeriesResponse(
            resolution=resolution,
            resolution_reason=reason,
            start=start_at,
            end=end_at,
            series=[],
        )

    buckets = await q.series(
        db,
        tenant,
        point_ids=allowed,
        start=start_at,
        end=end_at,
        resolution=resolution,
    )
    return SeriesResponse(
        resolution=resolution,
        resolution_reason=reason,
        start=start_at,
        end=end_at,
        series=[
            {
                "point_id": pid,
                "point_tag": meta[pid]["point_tag"],
                "device_tag": meta[pid]["device_tag"],
                "unit": meta[pid]["unit"],
                "buckets": buckets.get(pid, []),
            }
            for pid in allowed
        ],
    )


# ── Correlation ──────────────────────────────────────────────────────────────


@bi_router.get(
    "/correlation",
    response_model=CorrelationResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def correlation(
    db: Db,
    scope: Caller,
    point_id: Annotated[list[uuid.UUID], Query(min_length=2)],
    start: dt.datetime | None = None,
    end: dt.datetime | None = None,
    resolution: str = "auto",
    hours: Annotated[int, Query(ge=1, le=24 * 90)] = 168,
) -> CorrelationResponse:
    """Pearson correlation between measured series, pairwise, over aligned buckets.

    This endpoint exists because the coefficient does NOT need a unit. r is a
    ratio of a covariance to two standard deviations, so the units cancel; and
    the series are not anonymous — each carries the source's own `device_tag` and
    `point_tag`, which is what the response labels it with. What the number does
    NOT license is an interpretation, and nothing here supplies one: no ranking
    of causes, no "driver", no explanation.

    Everything a reader needs in order to distrust an answer travels with it:

    * `n` — the buckets that actually overlapped. A pair that never overlapped
      is `status="no_overlap"` with `r=None`, never a zero.
    * a FROZEN series (one distinct value) has zero variance, so every r
      involving it is UNDEFINED — `status="undefined_frozen"`, naming the flat
      side. Postgres `corr()` returns NULL there and this does not paper over it.
    * `resolution` / `resolution_reason` — which rollup answered. There is no raw
      path at all here, and `auto` is never silently downgraded.
    """
    tenant = _tenant(scope)
    ids: list[uuid.UUID] = []
    for p in point_id:
        if p not in ids:
            ids.append(p)
    if len(ids) < 2:
        raise ValidationError("correlation needs two distinct points")
    if len(ids) > q.MAX_CORRELATION_POINTS:
        raise ValidationError(
            f"at most {q.MAX_CORRELATION_POINTS} series per request "
            f"(asked for {len(ids)}); a wider matrix is unreadable before it is expensive"
        )

    start_at, end_at = _window(start, end, hours)

    # RAW IS NOT AN OPTION. Correlating raw samples would correlate whatever
    # happened to share a timestamp, which is a different question from the one
    # this screen asks; and contract §5 puts analysis on the rollups.
    if resolution == "auto":
        resolution, reason = q.choose_resolution(start_at, end_at)
    elif resolution in ("1m", "1h"):
        _, reason = q.choose_resolution(start_at, end_at)
        reason = (
            "1-minute rollup (readings_1m); materialized-only, so the newest "
            "~2 minutes may not be included yet"
            if resolution == "1m"
            else "1-hour rollup (readings_1h); real-time aggregate, current hour included"
        )
    else:
        raise ValidationError(
            "resolution must be one of: auto, 1m, 1h — correlation is computed on "
            "the rollups, never on raw readings"
        )

    # Resolve labels FIRST; this is also the tenant check (see `series`). A point
    # that does not come back is not the caller's and is dropped before a single
    # reading is read.
    meta = await q.point_meta(db, tenant, ids)
    allowed = [p for p in ids if p in meta]
    if len(allowed) < 2:
        raise ValidationError("correlation needs two points visible to this caller")

    stats = await q.correlation_stats(
        db, tenant, point_ids=allowed, start=start_at, end=end_at, resolution=resolution
    )
    rows = await q.correlation_pairs(
        db, tenant, point_ids=allowed, start=start_at, end=end_at, resolution=resolution
    )

    def _label(pid: uuid.UUID) -> str:
        m = meta[pid]
        return f"{m['device_tag'] or '?'} / {m['point_tag'] or '?'}"

    series_out: list[dict] = []
    frozen: set[uuid.UUID] = set()
    silent: set[uuid.UUID] = set()
    for pid in allowed:
        st = stats.get(pid)
        n = int(st["n"]) if st else 0
        distinct = int(st["distinct_values"]) if st else 0
        is_frozen = n > 0 and distinct <= 1
        if is_frozen:
            frozen.add(pid)
        if n == 0:
            silent.add(pid)
        series_out.append(
            {
                "point_id": pid,
                "point_tag": meta[pid]["point_tag"],
                "device_tag": meta[pid]["device_tag"],
                "category": meta[pid]["category"],
                "unit": meta[pid]["unit"],
                "buckets": n,
                "distinct_values": distinct,
                "frozen": is_frozen,
                "min": st["min"] if st else None,
                "max": st["max"] if st else None,
                "mean": st["mean"] if st else None,
                "first_bucket": st["first_bucket"] if st else None,
                "last_bucket": st["last_bucket"] if st else None,
            }
        )

    found = {(r["a_id"], r["b_id"]): r for r in rows}
    pairs_out: list[dict] = []
    for i, a in enumerate(allowed):
        for b in allowed[i + 1 :]:
            row = found.get((a, b)) or found.get((b, a))
            n = int(row["n"]) if row else 0
            flat = [p for p in (a, b) if p in frozen]

            if n == 0:
                # Absence renders as absence. Say WHICH kind of absence it is:
                # a series that reported nothing at all is a different problem
                # from two series that reported at times that never met.
                quiet = [p for p in (a, b) if p in silent]
                if quiet:
                    why = (
                        f"{' and '.join(_label(p) for p in quiet)} reported no numeric "
                        f"bucket in this window"
                    )
                else:
                    why = "the two series never filled the same bucket in this window"
                pairs_out.append(
                    {"a": a, "b": b, "n": 0, "r": None, "status": "no_overlap", "reason": why}
                )
                continue

            if flat:
                pairs_out.append(
                    {
                        "a": a,
                        "b": b,
                        "n": n,
                        "r": None,
                        "status": "undefined_frozen",
                        "reason": (
                            f"undefined — {' and '.join(_label(p) for p in flat)} "
                            f"reported one value for all {n} overlapping buckets, so its "
                            f"standard deviation is zero and Pearson's r has no value "
                            f"(this is not a correlation of zero)"
                        ),
                        "overlap_start": row["overlap_start"],
                        "overlap_end": row["overlap_end"],
                    }
                )
                continue

            if n < q.MIN_CORRELATION_BUCKETS:
                pairs_out.append(
                    {
                        "a": a,
                        "b": b,
                        "n": n,
                        "r": None,
                        "status": "too_few",
                        "reason": (
                            f"only {n} overlapping bucket(s); below "
                            f"{q.MIN_CORRELATION_BUCKETS} a coefficient is determined by "
                            f"the arithmetic rather than by the building"
                        ),
                        "overlap_start": row["overlap_start"],
                        "overlap_end": row["overlap_end"],
                    }
                )
                continue

            r_val = row["r"]
            if r_val is None:
                # corr() went NULL for a reason the distinct-value check did not
                # catch (a series flat only across the OVERLAP, for instance).
                pairs_out.append(
                    {
                        "a": a,
                        "b": b,
                        "n": n,
                        "r": None,
                        "status": "undefined_frozen",
                        "reason": (
                            f"undefined — one of the two series did not vary across the "
                            f"{n} overlapping buckets, so its standard deviation is zero"
                        ),
                        "overlap_start": row["overlap_start"],
                        "overlap_end": row["overlap_end"],
                    }
                )
                continue

            pairs_out.append(
                {
                    "a": a,
                    "b": b,
                    "n": n,
                    "r": float(r_val),
                    "status": "ok",
                    "reason": f"Pearson r over {n} aligned {resolution} buckets",
                    "overlap_start": row["overlap_start"],
                    "overlap_end": row["overlap_end"],
                }
            )

    samples: list[dict] = []
    truncated = False
    if len(allowed) == 2:
        raw = await q.correlation_scatter(
            db,
            tenant,
            a_id=allowed[0],
            b_id=allowed[1],
            start=start_at,
            end=end_at,
            resolution=resolution,
        )
        samples = [{"t": r["t"], "a": r["a"], "b": r["b"]} for r in raw]
        truncated = len(samples) >= q.MAX_SCATTER_SAMPLES

    return CorrelationResponse(
        resolution=resolution,
        resolution_reason=reason,
        start=start_at,
        end=end_at,
        min_buckets=q.MIN_CORRELATION_BUCKETS,
        series=series_out,
        pairs=pairs_out,
        samples=samples,
        samples_truncated=truncated,
    )


# ── Units ────────────────────────────────────────────────────────────────────
#
# The unit is the input that separates a number from a quantity, and it is the
# one input a rating cannot do without. `points.unit` is NULL for all 314 points
# because the wire carries no `env.u` (contract §11/§12); these two routes are
# how it stops being NULL, and the rule they exist to enforce is that only a
# HUMAN can make that happen.


@bi_router.get(
    "/units",
    response_model=UnitListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def units(
    db: Db,
    scope: Caller,
    category: str | None = None,
    search: str | None = None,
    confirmed: str = "all",
    limit: Annotated[int, Query(ge=1, le=1000)] = 300,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> UnitListResponse:
    """Every point, its unit, WHO said so, and what its tag appears to say.

    `suggestion` is derived from the point TAG at read time and is never stored.
    That is the whole shape of this feature: `KWH_kwh` and `Freq_Hz` look like
    they carry their unit, and offering that reading for a human to confirm is
    honest, while writing it silently is the naming-convention fabrication the
    contract forbids (§17 — `4F-3F AC DB` names two floors).

    `confirmed=unconfirmed` is the useful view: it is the work.
    """
    if confirmed not in ("all", "confirmed", "unconfirmed"):
        raise ValidationError("confirmed must be one of: all, confirmed, unconfirmed")
    counts, rows = await un.list_units(
        db,
        _tenant(scope),
        category=category,
        search=search,
        confirmed=confirmed,
        limit=limit,
        offset=offset,
    )
    return UnitListResponse(counts=counts, items=rows)


@bi_router.post(
    "/units/confirm",
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def confirm_units(db: Db, scope: Caller, who: Who, body: ConfirmUnitsRequest) -> dict:
    """An operator asserts the unit for a named set of points.

    Gated by `bi.manage`, not `bi.read`: this WRITES a fact that a rating divides
    by. It is the same key that gates retiring a point — statements about the
    estate rather than readings of it.

    The ids are explicit. There is deliberately no server-side pattern expansion:
    a bulk confirmation is a list the operator saw before pressing the button.

    `unit: null` clears back to unconfirmed, which has to be reachable — see
    `ConfirmUnitsRequest`.
    """
    # The caller's USER ID, from the token. Not an email: the JWT does not carry
    # one and asking core for it would be an HTTP round-trip to decorate a
    # provenance field. An id that resolves in the audit log is a better record
    # than a name that could go stale.
    actor = str(getattr(who, "user_id", "") or "") or None
    updated = await un.confirm_units(
        db,
        _tenant(scope),
        point_ids=body.point_ids,
        unit=body.unit,
        actor=actor,
    )
    return {
        "updated": len(updated),
        "requested": len(body.point_ids),
        # A requested id that is not the caller's tenant's simply does not come
        # back. Said out loud rather than reported as a success.
        "not_visible": len(body.point_ids) - len(updated),
        "unit": body.unit,
        "unit_source": None if body.unit is None else "operator",
        "confirmed_by": None if body.unit is None else actor,
    }


# ── Ratings ──────────────────────────────────────────────────────────────────


@bi_router.get(
    "/rating/sites",
    response_model=SiteFactsListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def rating_sites(db: Db, scope: Caller) -> SiteFactsListResponse:
    """Sites this store has been told about, with their rating inputs.

    Read from `site_facts` — the local read-model of `neubit_control.sites`, fed
    by the site-facts event mirror (pipeline contract §18). Nothing here opens
    core's database, and nothing here invents a fact: a site with no area shows a
    null area, which is what the screen turns into "cannot rate".
    """
    return SiteFactsListResponse(items=await rt.sites(db, _tenant(scope)))


@bi_router.get(
    "/rating",
    response_model=RatingResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def rating(
    db: Db,
    scope: Caller,
    site_id: uuid.UUID,
    point_id: Annotated[list[uuid.UUID] | None, Query()] = None,
    days: Annotated[int, Query(ge=1, le=1096)] = 30,
) -> RatingResponse:
    """EPI for one site over a window — or the reasons it cannot be computed.

    THE INPUTS, AND WHO OWNS EACH:

    * **kWh** — measured, but only counted from points an operator has CONFIRMED
      are kilowatt-hour registers (`unit_source = 'operator'`). A unit the wire
      happened to send is not somebody standing behind it.
    * **Area** — `site_facts.gross_floor_area_sqm`, mirrored from core, typed by
      an operator in Configurations → Sites. NULL blocks the rating outright.
    * **Which meters** — the CALLER's, passed as `point_id`. There is no stored
      fact saying which register measures the whole supply, and picking one by
      tag would be a fabrication; summing everything would double-count an
      incomer against its own sub-meters. So the operator names them and the
      response shows each one's arithmetic.

    WHAT IT REFUSES TO DO: no default area, no estimated area, no national
    average, no partial score. Every missing input becomes a line in `blocked`
    and the `epi` field stays null.
    """
    tenant = _tenant(scope)
    end = dt.datetime.now(dt.timezone.utc)
    start = end - dt.timedelta(days=days)

    all_sites = await rt.sites(db, tenant)
    site = next((s for s in all_sites if s["site_id"] == site_id), None)
    if site is None:
        raise ForbiddenError("no such site in this tenant's reporting store")

    candidates = await rt.candidate_meters(db, tenant, site_id)
    by_id = {c["point_id"]: c for c in candidates}

    chosen: list[uuid.UUID] = []
    unusable: list[str] = []
    for pid in point_id or []:
        if pid in by_id and pid not in chosen:
            chosen.append(pid)
        elif pid not in by_id:
            # Named but not usable: not at this site, retired, or — the common
            # case — nobody has confirmed it is in kWh.
            unusable.append(str(pid))

    blocked: list[str] = []
    if not chosen:
        blocked.append(
            "No meter selected. Choose the kWh registers that make up this site's "
            "incoming supply — the platform holds no fact saying which meter that "
            "is, and guessing from a tag would be an invention."
            if candidates
            else (
                "No point at this site has a CONFIRMED kWh unit. A rating counts "
                "only registers an operator has confirmed are kilowatt-hours; the "
                "wire carries no unit, so until somebody confirms one there is "
                "nothing to add up."
            )
        )
    if unusable:
        blocked.append(
            f"{len(unusable)} selected point(s) are not confirmed kWh registers at "
            f"this site and were not counted."
        )

    meters: list[dict] = []
    if chosen:
        regs = await rt.registers(db, tenant, point_ids=chosen, start=start, end=end)
        meters = [rt.meter_row(by_id[p], regs.get(p)) for p in chosen]

    ok = [m for m in meters if m["status"] == "ok"]
    if meters and not ok:
        blocked.append(
            "None of the selected meters produced a usable delta over this window "
            "— see each meter's own reason below."
        )

    area = site["gross_floor_area_sqm"]
    if area is None:
        blocked.append(
            "Cannot rate — no built-up area recorded for this site. An EPI is "
            "kWh per square metre per year; record the gross floor area in "
            "Configurations → Sites and this becomes computable. Nothing is "
            "defaulted or estimated in the meantime."
        )

    epi = None
    cost = None
    if ok and area:
        measured = sum(float(m["consumption_kwh"] or 0.0) for m in ok)
        first = min(m["first_bucket"] for m in ok)
        last = max(m["last_bucket"] for m in ok)
        # Days of readings actually covered — NOT the window asked for. A 30-day
        # request over 20 hours of data must annualise from the 20 hours and say
        # so, not pretend it saw a month.
        days_covered = max((last - first).total_seconds() / 86400.0, 0.0)
        if days_covered <= 0:
            blocked.append(
                "The selected meters span less than one hourly bucket, so there is "
                "no interval to annualise over."
            )
        else:
            factor = 365.0 / days_covered
            annualised = measured * factor
            value = annualised / float(area)
            epi = {
                "epi_kwh_per_sqm_year": value,
                "measured_kwh": measured,
                "days_covered": days_covered,
                "annualised_kwh": annualised,
                "area_sqm": float(area),
                "annualisation_factor": factor,
                "formula": (
                    f"{measured:,.1f} kWh measured over {days_covered:.2f} days "
                    f"× (365 / {days_covered:.2f}) = {annualised:,.1f} kWh/yr, "
                    f"÷ {float(area):,.0f} m² = {value:,.1f} kWh/m²/yr"
                ),
            }
            tariff = site["energy_tariff_per_kwh"]
            currency = site["tariff_currency"]
            if tariff and currency:
                cost = {
                    "amount": measured * float(tariff),
                    "currency": currency,
                    "tariff_per_kwh": float(tariff),
                    "formula": (
                        f"{measured:,.1f} kWh × {float(tariff):g} {currency}/kWh = "
                        f"{measured * float(tariff):,.2f} {currency} for the measured window"
                    ),
                }

    return RatingResponse(
        site=site,
        start=start,
        end=end,
        resolution=rt.RESOLUTION,
        resolution_reason=rt.RESOLUTION_REASON,
        meters=meters,
        epi=epi,
        cost=cost,
        benchmark=rt.benchmark_state(),
        blocked=blocked,
    )


# ── The dashboard builder ────────────────────────────────────────────────────
#
# Three routes and no fourth: what datasets exist, what one of them contains, and
# run a widget's state against it. There is deliberately NO route that accepts
# SQL — see `spec.py` and the builder contract §3. The generator lives in
# `sqlgen.py` and runs here, on the server, or it does not run.


def _allowed(who: Principal, ds: registry.Dataset) -> bool:
    """Whether this caller may read this dataset. Each dataset declares its own
    permission (contract §2), so `bi.read` is the IoT dataset's key rather than a
    blanket gate over everything the builder can see."""
    return who.grants(ds.permission)


@bi_router.get("/datasets")
async def datasets(db: Db, who: Who) -> dict:
    """What this caller can chart.

    Read straight from the registry table, so a dataset a domain registered five
    minutes ago is here now — no release of this service, which is the whole point
    of the registry (contract §2). Datasets the caller may not read are omitted
    rather than shown-and-refused: an inventory of other people's data is itself
    information.
    """
    found = await registry.load(db)
    # Publish the permission keys to core's catalog so a role can grant them.
    # Best-effort and debounced; a chart never waits on it.
    await permsync.sync(list(found.values()))
    items = [ds.public() for ds in found.values() if _allowed(who, ds)]
    return {
        "total": len(items),
        "items": items,
        "spec_version": widget_spec.SPEC_VERSION,
        # Everything the editor needs to render its pickers without hard-coding a
        # list that can drift from what the server accepts.
        "aggregates": list(get_args(registry.BuilderAggregate)),
        "filter_ops": list(get_args(builder.FilterOp)),
        "max_series": builder.MAX_SERIES,
        "max_rows": builder.MAX_ROWS,
        "max_hours": builder.MAX_HOURS,
    }


@bi_router.get("/datasets/{key}")
async def dataset(key: str, db: Db, who: Who) -> dict:
    ds = await registry.get(db, key)
    if not _allowed(who, ds):
        raise ForbiddenError(f"missing permission(s): {ds.permission}")
    return ds.public()


@bi_router.get("/datasets/{key}/values")
async def dataset_values(
    key: str,
    db: Db,
    scope: Caller,
    who: Who,
    column: str,
    search: str | None = None,
    hours: Annotated[int, Query(ge=1, le=24 * 90)] = 24 * 7,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
) -> dict:
    """The distinct values of one DIMENSION, for a filter picker.

    Without this the builder would be a form full of free-text boxes: a person
    filtering on `category` has to know the gateway spells it `hvac`. It is the
    same generated-SQL path as everything else — `column` is a dimension KEY that
    must exist in the registry, never a column name that reaches SQL unchecked.
    """
    ds = await registry.get(db, key)
    if not _allowed(who, ds):
        raise ForbiddenError(f"missing permission(s): {ds.permission}")
    return await ex.distinct_values(
        db,
        _tenant(scope),
        ds,
        column=column,
        search=search,
        hours=hours,
        limit=limit,
    )


@bi_router.post("/query", response_model=QueryResult)
async def query(db: Db, scope: Caller, who: Who, body: dict) -> QueryResult:
    """Execute ONE widget's BUILDER STATE and return its data.

    This is the read path behind every dashboard widget. It lives here, not in the
    dashboards service, for the same reason the rest of this router does: pipeline
    contract §7 gives the readings schema one owner, and the owner serves its own
    reads. The dashboards service stores widget definitions and never opens this
    database.

    The body is a widget SPEC — a structured description of a dataset, some
    columns, an aggregate, a window and a resolution. **It is not SQL and there is
    no field in which SQL can arrive**: every model is `extra="forbid"`, so a body
    carrying `sql` or `where` is a 400 naming the field. The server generates the
    statement (`sqlgen.py`); the client never sees one except as a read-only echo
    on the result.

    Gating is per DATASET, not per router: each dataset declares the permission
    required to read it, and the tenant comes from the token claim and never from
    the request. A spec naming another tenant's rows returns nothing, because
    every generated statement carries the tenant bind.

    The body may also carry a DASHBOARD CONTEXT (`{spec, context}`) — the page's
    global filters, its variables and its shared window. That context is merged
    into the widget's builder STATE before validation, so everything the page
    contributes is checked by the same rules and BOUND by the same generator as
    everything the widget's author wrote. It is emphatically not substituted into
    a query string; `context.py` is the whole argument for why, and what to check.
    """
    spec, ctx = widget_spec.parse_request(body)
    ds = await registry.get(db, spec.query.dataset)
    if not _allowed(who, ds):
        raise ForbiddenError(f"missing permission(s): {ds.permission}")
    # BEFORE `validated`: a filter the page contributed must face the same
    # comparability and window rules as one the widget carries, and a page filter
    # that pins an incomparable measure to one series legitimately makes an
    # otherwise-refused widget answerable.
    notes = context.resolve(spec, ctx, ds)
    spec.query.validated(ds)
    result = await ex.run(db, _tenant(scope), ds, spec)
    result.context_notes = [n.model_dump() for n in notes]
    return result


@bi_router.get("/query/capabilities")
async def capabilities(db: Db, who: Who) -> dict:
    """What this build's spec supports — the builder reads it instead of guessing.

    A frontend that hard-codes the aggregate list drifts from the backend the
    moment one is added or removed. Serving it means the widget editor's options
    and the validator that rejects them can never disagree.
    """
    found = await registry.load(db)
    return {
        "spec_version": widget_spec.SPEC_VERSION,
        "shape": "table",
        "aggregates": list(get_args(registry.BuilderAggregate)),
        "filter_ops": list(get_args(builder.FilterOp)),
        "datasets": [
            {"key": ds.key, "name": ds.name} for ds in found.values() if _allowed(who, ds)
        ],
        # Chart types THIS BUILD's UI draws. The executor does not validate `viz`
        # at all (see spec.py), so this list is advisory: it tells the editor what
        # to offer, and adding to it never invalidates a stored dashboard.
        "viz": ["line", "bar", "stat", "table"],
        "max_series": builder.MAX_SERIES,
        "max_rows": builder.MAX_ROWS,
        "max_hours": builder.MAX_HOURS,
    }


@bi_router.get("/whoami", dependencies=[Depends(require_permission(PERM_READ))])
async def whoami(scope: Caller) -> dict:
    """What tenant this caller's queries are filtered by. For diagnosis only."""
    return {
        "tenant_id": str(scope.tenant_id) if scope.tenant_id else None,
        "is_platform": scope.is_platform,
    }


from .metrics import metrics_router as _metrics_router; bi_router.include_router(_metrics_router)  # noqa: E401,E402,E702 — metric registry (/bi/metrics/*), owned by app/api/metrics.py
