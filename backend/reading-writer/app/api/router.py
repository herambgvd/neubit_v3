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

from fastapi import APIRouter, Depends, Query, Request
from kernel.auth import Principal, Scope, get_principal, get_scope, require_permission
from kernel.errors import ForbiddenError, ValidationError
from reporting.db import get_db
from sqlalchemy.ext.asyncio import AsyncSession

from . import builder
from . import context
from . import execute as ex
from . import permsync
from . import placement as pl
from . import queries as q
from . import registry
from . import spec as widget_spec
from .schemas import (
    ActivityBucket,
    AlertListResponse,
    DeviceListResponse,
    PlaceDevicesRequest,
    PlacementDeviceListResponse,
    PlacePointsRequest,
    PointListResponse,
    ResetPointsRequest,
    SeriesResponse,
    SummaryResponse,
    UnplaceDevicesRequest,
)
from .spec import TableResult as QueryResult

# The permission key this API gates on. Registered in core's catalog
# (`app/auth/permissions.py`, group "Building Intelligence") so a tenant admin can
# actually grant it in the role editor — a key no catalog knows about can only
# ever be held by a wildcard admin.
PERM_READ = "bi.read"
# The WRITE key. Two things use it, and they are the same kind of decision:
# retiring a point (what is part of the estate) and PLACING a device (where that
# part of the estate is). Both are an operator's statement about the building
# rather than a reading of it, and neither ever touches a measurement — a
# placement writes a dimension row and nothing else. Registered in core's catalog
# beside bi.read, so a role can actually grant it.
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
# The write half of the spatial axis, and the thing that made `points`' six
# spatial columns (migration 0008) more than an empty frame.
#
# The truth is ONE ROW PER DEVICE (`device_locations`, migration 0010), because a
# placement is a fact about a box rather than about each of the box's
# measurements: this estate is 29 devices and 314 points, and every point of
# `4F_Solar_Panel01` is in the same room. `points.site_id` / `floor_id` /
# `zone_id` are a derivation of that row, which is also how a point that reports
# for the FIRST TIME inherits its device's placement.
#
# Three rules run through every route below:
#
# 1. **Names come from core, never from the client.** Every id is resolved
#    against core's own `/sites` / `/floors` / `/zones` with the CALLER's token
#    and the label is copied from the answer. See `placement.py`.
# 2. **Unplaced is a state, not a gap.** Nothing here defaults a device to a
#    floor, infers one from its tag, or hides a device that has none.
# 3. **A placement is never overwritten by a reading.** The writer's points
#    upsert does not name these columns at all, and the reconcile it runs reads
#    only `device_locations`. Contract §11's no-clobber rule, kept.


def _bearer(request: Request) -> str:
    """The caller's own Authorization header, forwarded to core for verification.

    Deliberately the caller's token and not a system one: placing a device into a
    site the caller cannot read should fail, and reusing core's own scoping is
    how that is guaranteed rather than reimplemented here.
    """
    header = request.headers.get("authorization")
    if not header:
        raise ValidationError("missing Authorization header")
    return header


@bi_router.get(
    "/placement/devices",
    response_model=PlacementDeviceListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def placement_devices(
    db: Db,
    scope: Caller,
    placed: str | None = None,
    search: str | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> PlacementDeviceListResponse:
    """The placement worklist: every reporting device, and where it is or is not.

    `placed=unplaced` is the screen's default view and the honest one — it is the
    work. `placed` filters on whether a `device_locations` row EXISTS rather than
    on `floor_id IS NULL`, because "placed on a site with no floor" is a real
    answer (a rooftop meter) and must not read as unplaced.

    Each row carries `tag_prefix`, the leading token of the gateway's device tag.
    It groups the list; it never fills in a floor. Nothing on this platform maps
    `4F` to a floor id, and `4F-3F AC DB` names two floors anyway.
    """
    tenant = _tenant(scope)
    total, rows = await q.placement_devices(
        db, tenant, placed=placed, search=search, limit=limit, offset=offset
    )
    overview = await q.placement_overview(db, tenant)
    return PlacementDeviceListResponse(total=total, items=rows, overview=overview)


@bi_router.post(
    "/placement/devices",
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def place_devices(
    request: Request, db: Db, scope: Caller, who: Who, body: PlaceDevicesRequest
) -> dict:
    """Place one or more devices in one site / floor / zone.

    BULK IS THE SHAPE, not an add-on: the list is what makes this usable, because
    an operator asked to place 29 devices one at a time does not place any of
    them. The devices in one call all go to the SAME place — heterogeneous bulk
    would be a batch of unrelated decisions wearing one request's clothes.

    The response names any `device_ids` the store has never seen rather than
    reporting success for them: this API places devices that have REPORTED, and a
    typo must not look like a placement.
    """
    where = await pl.resolve_location(
        bearer=_bearer(request),
        site_id=body.site_id,
        floor_id=body.floor_id,
        zone_id=body.zone_id,
    )
    return await pl.place_devices(
        db,
        _tenant(scope),
        device_ids=body.device_ids,
        where=where,
        placed_by=who.user_id,
        source="operator",
    )


@bi_router.post(
    "/placement/devices/unplace",
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def unplace_devices(db: Db, scope: Caller, body: UnplaceDevicesRequest) -> dict:
    """Remove a placement. The device's points go back to UNPLACED.

    A separate route rather than a nullable field on the place call, so that an
    omitted `site_id` can never be destructive. Points carrying an explicit
    point-level override keep it — that override never came from this row.
    """
    return await pl.unplace_devices(db, _tenant(scope), device_ids=body.device_ids)


@bi_router.post(
    "/placement/points",
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def place_points(
    request: Request, db: Db, scope: Caller, body: PlacePointsRequest
) -> dict:
    """Override the device's placement for named points.

    The escape hatch for the sub-meter that genuinely is not where its panel is.
    A point placed this way is marked and the device-level reconcile never
    touches it again — including when its device is re-placed or unplaced.
    """
    where = await pl.resolve_location(
        bearer=_bearer(request),
        site_id=body.site_id,
        floor_id=body.floor_id,
        zone_id=body.zone_id,
    )
    return await pl.place_points(db, _tenant(scope), point_ids=body.point_ids, where=where)


@bi_router.post(
    "/placement/points/reset",
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def reset_points(db: Db, scope: Caller, body: ResetPointsRequest) -> dict:
    """Drop a point-level override so the point follows its device again.

    If the device is placed the point lands where the device is; if it is not,
    the point lands UNPLACED. One statement decides both, so the two states can
    never disagree.
    """
    return await pl.reset_points(db, _tenant(scope), point_ids=body.point_ids)


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
