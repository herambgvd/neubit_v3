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
# The true last reading time comes from `points.last_seen_at` (the writer touches
# it on ingest) rather than from a bucket start, which would round backwards.
_TOTALS_SQL = text(
    """
    SELECT count(DISTINCT coalesce(p.device_id::text, p.device_tag)) AS devices,
           count(*)                                        AS points,
           count(*) FILTER (
               WHERE p.last_seen_at >= now() - make_interval(mins => :fresh)
           )                                               AS points_reporting,
           min(p.first_seen_at)                            AS first_seen_at,
           max(p.last_seen_at)                             AS last_seen_at
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
    """
)


async def summary(db: AsyncSession, tenant: uuid.UUID | None) -> dict:
    params = {"tenant": str(tenant) if tenant else None, "fresh": FRESH_MINUTES}
    cats = _rows(await db.execute(_SUMMARY_SQL, params))
    types = _rows(await db.execute(_DEVICE_TYPES_SQL, {"tenant": params["tenant"]}))
    extent = _rows(await db.execute(_EXTENT_SQL, {"tenant": params["tenant"]}))
    seen = _rows(await db.execute(_TOTALS_SQL, params))

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
        "categories": categories,
        # From _TOTALS_SQL, not summed from `categories` — see its comment.
        "total_devices": int(row.get("devices") or 0),
        "total_points": int(row.get("points") or 0),
        "total_points_reporting": int(row.get("points_reporting") or 0),
        "first_reading_at": row.get("first_seen_at") or ext.get("first_bucket"),
        "last_reading_at": row.get("last_seen_at"),
        "readings_last_hour": int(ext.get("samples_this_hour") or 0),
    }


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
            {"tenant": str(tenant) if tenant else None, "hours": hours},
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
           max(p.last_seen_at)                             AS last_seen_at
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       {search}
     GROUP BY p.device_id, coalesce(p.device_id::text, p.device_tag)
    {having}
"""


def _device_filters(category: str | None, device_type: str | None, search: str | None):
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
) -> tuple[int, list[dict]]:
    having, search_sql, extra = _device_filters(category, device_type, search)
    base = _DEVICES_SQL.format(search=search_sql, having=having)
    params = {"tenant": str(tenant) if tenant else None, "fresh": FRESH_MINUTES, **extra}

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
           p.device_type, p.type, p.unit, p.first_seen_at, p.last_seen_at
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
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
) -> tuple[int, list[dict]]:
    filters: list[str] = []
    params: dict = {"tenant": str(tenant) if tenant else None}
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
    if search:
        filters.append("AND (p.point_tag ILIKE :search OR p.device_tag ILIKE :search)")
        params["search"] = f"%{search}%"

    base = _POINTS_SQL.format(filters=" ".join(filters))
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
    SELECT p.point_id, p.point_tag, p.device_tag, p.unit
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
