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


class PlacementSummary(BaseModel):
    """How much of the live estate is anchored in space.

    Reported even when the answer is "none of it". A floor-wise surface with no
    rows looks broken; "0 of 314 points are placed" is a fact, and it is the one
    that tells an operator what to do next.

    The three counts are INDEPENDENT, not nested: a point can legitimately carry a
    site and no floor (a rooftop meter belongs to the building rather than to a
    storey), so `with_site >= with_floor` is not assumed anywhere.
    """

    points: int
    with_site: int
    with_floor: int
    with_zone: int
    # Live points that cannot answer a floor-wise question at all.
    unplaced: int


class FloorRow(BaseModel):
    """One floor of the estate — plus the UNPLACED bucket, as `floor_id: null`.

    The unplaced group is a row rather than an omission, for the same reason
    `/bi/devices` answers an empty `category`: "the points nothing has placed" is
    a real question, and dropping them would make the floors look like the whole
    estate.
    """

    floor_id: uuid.UUID | None
    floor_name: str | None
    site_name: str | None
    devices: int
    points: int
    points_reporting: int
    last_seen_at: dt.datetime | None


class SummaryResponse(BaseModel):
    tenant_id: uuid.UUID | None
    generated_at: dt.datetime
    fresh_minutes: int
    categories: list[CategoryRow]
    total_devices: int
    total_points: int
    total_points_reporting: int
    # Points EXCLUDED from every count above: retired explicitly, or last seen
    # longer ago than `retire_after_days`. Their readings are untouched — this is
    # a count of what stopped being counted, not of what was deleted.
    total_points_retired: int = 0
    # The horizon in force (days). 0 = horizon off, explicit retirement only.
    retire_after_days: int = 0
    # Oldest / newest reading actually stored for this tenant, so a screen can
    # say what window it is allowed to ask about instead of guessing.
    first_reading_at: dt.datetime | None
    last_reading_at: dt.datetime | None
    readings_last_hour: int
    # Spatial anchoring. See `PlacementSummary` — this is stated rather than
    # implied, because nothing populates `points.floor_id` yet and a screen must
    # be able to say "unplaced" instead of quietly bucketing everything into one
    # floor that does not exist.
    placement: PlacementSummary | None = None
    floors: list[FloorRow] = Field(default_factory=list)


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
    # When an operator retired this point (NULL = never explicitly retired).
    retired_at: dt.datetime | None = None
    # True when the point is retired by EITHER route — explicitly, or by falling
    # past the `last_seen_at` horizon. Only ever true on a listing that ASKED for
    # retired rows; the default listing excludes them from the results entirely.
    retired: bool = False
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


# ── Faults & alerts ──────────────────────────────────────────────────────────
#
# Projected from the gateway's own alert feed by the reporting-projector; see
# `reporting/migrations/versions/0007_iot_alerts_projection.py` for the recipe and
# for the two facts that are on the wire and deliberately NOT here:
#
#   • `acked` — always false at publish time (acknowledging is a store-only
#     mutation in the gateway that publishes nothing), so MTTA is not computable
#     from this feed and no field pretends otherwise.
#
# The device's CATEGORY used to be the second entry in that list. It is on the
# wire now (pipeline contract §3, "The alert body") and in the store (migration
# `0011_iot_alerts_identity`), so a fault IS attributable to energy vs hvac vs
# water. Two things about it stay honest:
#
#   • it is OPTIONAL, so an alert from an unclassified device — or one replayed
#     from an outbox row written before the wire carried it — has none. That
#     renders as absent, never as "other";
#   • it is what the DEVICE is, not what the alert is about. Nothing here infers
#     a category from a point address or a message.


class AlertRow(BaseModel):
    """One alert exactly as the gateway raised it."""

    ts: dt.datetime
    alert_id: uuid.UUID
    # conflux's severity vocabulary: critical | warning | info.
    severity: str | None
    # conflux's alert type: rule | comm_fail | range | stale | recovered.
    alert_type: str | None
    device_tag: str | None
    # What the device IS. Optional on the wire and therefore nullable here: an
    # unclassified device, or an alert older than the wire change, has neither.
    device_category: str | None = None
    device_type: str | None = None
    # The stable identities behind the tags. `point_id` is the join onto
    # `readings`/`points` that §15 recorded as impossible — `src.addr` was the only
    # link and it is a topic path, not a key. Both optional, both nullable.
    device_id: uuid.UUID | None = None
    point_id: uuid.UUID | None = None
    # The source address of the point that faulted (`aeonhwj/B2_Main Incomer/CAvg_A`).
    point_addr: str | None
    # Free text from the gateway, including the measured value. Rendered verbatim:
    # it is the one place the number that tripped the rule is stated, and the
    # gateway's own words are the honest ones.
    message: str | None
    conn_slug: str | None
    proto: str | None


class AlertSeverityCount(BaseModel):
    severity: str | None
    alerts: int
    devices: int
    last_at: dt.datetime | None


class AlertCategoryCount(BaseModel):
    """Faults grouped by what the faulting device IS.

    `category` is None for an alert whose device carries no classification. That
    bucket is REAL and is rendered as "unclassified", not folded into another
    category and not dropped — a fault that cannot be attributed is still a fault.
    """

    category: str | None
    alerts: int
    devices: int
    last_at: dt.datetime | None


class AlertListResponse(BaseModel):
    # False when no projection is collecting alerts into this store. A screen says
    # so rather than drawing an empty queue that looks like "no faults".
    available: bool
    unavailable_reason: str | None = None
    window_hours: int
    start: dt.datetime
    end: dt.datetime
    generated_at: dt.datetime
    # Alerts in the whole window, so a truncated list can say "showing 50 of 214".
    total: int
    by_severity: list[AlertSeverityCount] = Field(default_factory=list)
    by_category: list[AlertCategoryCount] = Field(default_factory=list)
    items: list[AlertRow] = Field(default_factory=list)


# ── Placement ────────────────────────────────────────────────────────────────
#
# The write half of the spatial axis. The truth is one row per DEVICE
# (`device_locations`, migration 0010) and `points`' six spatial columns are a
# derivation of it; these shapes are what the placement screen reads and posts.


class PlacementTarget(BaseModel):
    """WHERE something is being placed. Ids only — the NAMES are not accepted.

    A client cannot supply `site_name` / `floor_name` / `zone_name` here, and
    that omission is the point: the server resolves every id against core and
    copies the label from core's answer. A name a client sent is a label nothing
    checked, and `/bi/summary` would report it as fact.

    `floor_id` and `zone_id` are optional and `site_id` is not. A placement that
    names no site is not a placement; a placement that names a site and no floor
    is a rooftop meter, which is a true answer.
    """

    model_config = {"extra": "forbid"}

    site_id: uuid.UUID
    floor_id: uuid.UUID | None = None
    zone_id: uuid.UUID | None = None


class PlaceDevicesRequest(PlacementTarget):
    """Place N devices in one place. Bulk is the default shape, not an extra."""

    device_ids: list[uuid.UUID] = Field(min_length=1)


class UnplaceDevicesRequest(BaseModel):
    """Remove a placement. Separate from placing on purpose: a `site_id: null`
    that meant "clear" would make an omitted field destructive."""

    model_config = {"extra": "forbid"}

    device_ids: list[uuid.UUID] = Field(min_length=1)


class PlacePointsRequest(PlacementTarget):
    """The point-level OVERRIDE — the exception, not the unit of work."""

    point_ids: list[uuid.UUID] = Field(min_length=1)


class ResetPointsRequest(BaseModel):
    """Drop a point-level override; the point follows its device again."""

    model_config = {"extra": "forbid"}

    point_ids: list[uuid.UUID] = Field(min_length=1)


class PlacementDeviceRow(BaseModel):
    """One device on the placement worklist — placed or, honestly, not."""

    device_id: uuid.UUID
    device_tag: str | None
    category: str | None
    device_type: str | None
    points: int
    points_reporting: int
    last_seen_at: dt.datetime | None
    # Points of this device that carry an explicit point-level placement, and so
    # do NOT follow the device. Surfaced because a device that reads as placed
    # while three of its points are elsewhere should say so.
    points_overridden: int
    # False means UNPLACED, which is a state this API reports rather than hides.
    placed: bool
    site_id: uuid.UUID | None = None
    site_name: str | None = None
    floor_id: uuid.UUID | None = None
    floor_name: str | None = None
    zone_id: uuid.UUID | None = None
    zone_name: str | None = None
    placed_at: dt.datetime | None = None
    placed_source: str | None = None
    # The leading token of the gateway's device tag (`B1_Main Incomer` → `B1`).
    # A GROUPING aid for the operator's selection and nothing else: no floor is
    # ever derived from it. See `queries.tag_prefix` for why.
    tag_prefix: str | None = None


class PlacementOverview(BaseModel):
    """The estate's placement state, counted over devices AND over points.

    Both, because they answer different questions: devices are the unit of work
    (how much is left to do) and points are the unit of measurement (how much of
    the data can answer a floor-wise question).
    """

    devices: int
    devices_placed: int
    devices_with_floor: int
    devices_unplaced: int
    points: int
    points_with_floor: int
    points_unplaced: int
    points_overridden: int


class PlacementDeviceListResponse(BaseModel):
    total: int
    items: list[PlacementDeviceRow]
    overview: PlacementOverview
