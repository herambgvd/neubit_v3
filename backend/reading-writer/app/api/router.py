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
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from kernel.auth import Scope, get_scope, require_permission
from kernel.errors import ValidationError
from reporting.db import get_db
from sqlalchemy.ext.asyncio import AsyncSession

from . import execute as ex
from . import queries as q
from . import spec as widget_spec
from .schemas import (
    ActivityBucket,
    DeviceListResponse,
    PointListResponse,
    SeriesResponse,
    SummaryResponse,
)
from .spec import QueryResult

# The permission key this API gates on. Registered in core's catalog
# (`app/auth/permissions.py`, group "Building Intelligence") so a tenant admin can
# actually grant it in the role editor — a key no catalog knows about can only
# ever be held by a wildcard admin.
PERM_READ = "bi.read"

bi_router = APIRouter(prefix="/bi", tags=["Building Intelligence"])

Db = Annotated[AsyncSession, Depends(get_db)]
Caller = Annotated[Scope, Depends(get_scope)]


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
    with_latest: bool = True,
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
    )
    return PointListResponse(
        total=total,
        items=rows,
        latest_lookback_minutes=q.LATEST_LOOKBACK_MINUTES,
    )


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


# ── Widget query (the dashboard builder's executor) ───────────────────────────


@bi_router.post(
    "/query",
    response_model=QueryResult,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def query(db: Db, scope: Caller, body: dict) -> QueryResult:
    """Execute ONE widget spec and return its data.

    This is the read path behind every dashboard widget. It lives here, not in
    the dashboards service, for the same reason the rest of this router does:
    contract §7 gives the readings schema one owner, and the owner serves its own
    reads. The dashboards service stores widget definitions and never opens this
    database.

    The body is a widget spec (`app.api.spec`) — a STRUCTURED description of a
    scope, a metric, a window, a rollup and a chart type. It is deliberately not
    SQL; see that module for why, at length.

    POST rather than GET because a spec is a nested object with a point-id list,
    and encoding that into a query string would be a second, lossy serialisation
    of a shape that is already defined. Nothing here writes — the verb is about
    the request body, not the effect.

    Gating is identical to every other route on this router: `bi.read`, the
    `analytics` module, an unexpired licence, and a tenant taken from the token
    claim and never from the request. A spec naming another tenant's points
    resolves to zero points, because the scope query is tenant-filtered before a
    single reading is read.
    """
    return await ex.run(db, _tenant(scope), widget_spec.parse(body))


@bi_router.get(
    "/query/capabilities",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def capabilities() -> dict:
    """What this build's spec supports — the builder reads it instead of guessing.

    A frontend that hard-codes the metric list drifts from the backend the moment
    one is added or removed. Serving it means the widget editor's options and the
    validator that rejects them can never disagree.
    """
    return {
        "spec_version": widget_spec.SPEC_VERSION,
        "kinds": ["series", "aggregate"],
        "metrics": ["avg", "min", "max", "last", "first", "count"],
        "rollups": ["auto", "1m", "1h", "raw"],
        "scope_types": ["points", "device", "category", "all"],
        "group_by": ["point", "device", "category"],
        # Chart types THIS BUILD's UI draws. The executor does not validate `viz`
        # at all (see spec.py), so this list is advisory: it tells the editor what
        # to offer, and adding to it never invalidates a stored dashboard.
        "viz": ["line", "bar", "stat", "table"],
        "max_series": widget_spec.MAX_SERIES,
        "max_rows": widget_spec.MAX_ROWS,
        "max_hours": widget_spec.MAX_HOURS,
        "raw_max_minutes": q.RAW_MAX_MINUTES,
        # The rule a builder must show rather than let a user discover as a 400.
        "grouped_metrics": ["count"],
    }


@bi_router.get("/whoami", dependencies=[Depends(require_permission(PERM_READ))])
async def whoami(scope: Caller) -> dict:
    """What tenant this caller's queries are filtered by. For diagnosis only."""
    return {
        "tenant_id": str(scope.tenant_id) if scope.tenant_id else None,
        "is_platform": scope.is_platform,
    }
