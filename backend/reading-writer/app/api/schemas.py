"""Response shapes for the Building Intelligence read API.

Designed around what the SCREENS need, not around the tables:

* ``Summary``    → the Portfolio tile: one row per category, plus the equipment
                   breakdown inside it.
* ``DeviceRow``  → the device lists on HVAC & Assets / Energy & Metering.
* ``PointRow``   → a device's measurement points, each with its LATEST value.
* ``SeriesPoint``→ one bucket of a chart, read from a ROLLUP.

Two things are deliberately absent and must stay absent:

* **No unit is invented.** ``points.unit`` is NULL for every point on this
  deployment because the source MQTT payloads carry none (contract §11/§12). The
  field is passed through exactly as stored — a blank unit renders blank. A
  guessed ``kW`` on an energy screen is worse than no unit at all.
* **No derived engineering figure** (kWh totals, cost, CO2, efficiency). Nothing
  on the wire says what a point measures, so any such number would be fabricated.
"""

from __future__ import annotations

import datetime as dt
import uuid

from pydantic import BaseModel, Field


class DeviceTypeCount(BaseModel):
    """One equipment kind inside a category, e.g. `chiller` inside `hvac`."""

    device_type: str | None
    devices: int
    points: int


class CategoryRow(BaseModel):
    """One BI category (`energy` / `hvac` / `water`) as it actually reports.

    A category appears here only if a point in it has produced a reading — the
    writer creates a dimension row from a reading and never from configuration
    (contract §6/§12), so this is a distribution of what has REPORTED.
    """

    category: str | None
    devices: int
    points: int
    # Points whose last_seen_at is inside the freshness window. The gap between
    # this and `points` is the honest "how much of the building is quiet" figure.
    points_reporting: int
    last_seen_at: dt.datetime | None
    device_types: list[DeviceTypeCount] = Field(default_factory=list)


class ActivityBucket(BaseModel):
    """One hour of ingest, per category. Read from `readings_1h` (real-time CAgg)."""

    bucket: dt.datetime
    category: str | None
    samples: int
    points: int


class SummaryResponse(BaseModel):
    tenant_id: uuid.UUID | None
    generated_at: dt.datetime
    fresh_minutes: int
    categories: list[CategoryRow]
    total_devices: int
    total_points: int
    total_points_reporting: int
    # Oldest / newest reading actually stored for this tenant, so a screen can
    # say what window it is allowed to ask about instead of guessing.
    first_reading_at: dt.datetime | None
    last_reading_at: dt.datetime | None
    readings_last_hour: int


class DeviceRow(BaseModel):
    device_id: uuid.UUID | None
    device_tag: str | None
    category: str | None
    device_type: str | None
    points: int
    numeric_points: int
    text_points: int
    points_reporting: int
    first_seen_at: dt.datetime | None
    last_seen_at: dt.datetime | None


class DeviceListResponse(BaseModel):
    total: int
    items: list[DeviceRow]


class LatestValue(BaseModel):
    """The most recent raw reading for a point, inside a bounded lookback.

    Read from the RAW table, not a rollup: `readings_1m` is `materialized_only`
    with a ~2 minute freshness floor, and a "current value" tile that is two
    minutes stale is a different (worse) product. The window is bounded, so the
    cost is an index range scan per point, not a table scan.
    """

    ts: dt.datetime
    num: float | None
    txt: str | None
    quality: int


class PointRow(BaseModel):
    point_id: uuid.UUID
    point_tag: str | None
    device_id: uuid.UUID | None
    device_tag: str | None
    category: str | None
    device_type: str | None
    # The reading KIND — "num" or "text". NOT the device type (contract §11).
    type: str | None
    # Engineering unit as STORED. NULL on this deployment, and that is correct.
    unit: str | None
    first_seen_at: dt.datetime | None
    last_seen_at: dt.datetime | None
    latest: LatestValue | None = None


class PointListResponse(BaseModel):
    total: int
    items: list[PointRow]
    # How far back `latest` was allowed to look. A point with no reading in that
    # window comes back with latest=null rather than a stale value dressed as live.
    latest_lookback_minutes: int


class SeriesBucket(BaseModel):
    t: dt.datetime
    # Rollup columns. On resolution="raw" only `last` is set (the sample itself)
    # and count is 1 — so one chart component renders every resolution.
    count: int
    min: float | None = None
    max: float | None = None
    avg: float | None = None
    first: float | None = None
    last: float | None = None
    txt_last: str | None = None


class SeriesRow(BaseModel):
    point_id: uuid.UUID
    point_tag: str | None
    device_tag: str | None
    unit: str | None
    buckets: list[SeriesBucket]


class SeriesResponse(BaseModel):
    # Which store answered: "1m" / "1h" (continuous aggregates) or "raw".
    resolution: str
    # Why, in one line, so a screen can say it out loud instead of implying
    # a precision it does not have.
    resolution_reason: str
    start: dt.datetime
    end: dt.datetime
    series: list[SeriesRow]
