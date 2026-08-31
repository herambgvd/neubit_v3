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


class SiteCategoryCount(BaseModel):
    """One category's device/point counts within a site (or the unplaced row)."""

    category: str | None
    devices: int
    points: int


class SiteAlerts(BaseModel):
    """Alert volume attributed to one site over a bounded window.

    Attribution is through the DEVICE's placement (an alert carries no site of
    its own); an alert on an unplaced or unknown device counts to the unplaced
    pseudo-row, never to a site it was not pinned on. `by_severity` keys are the
    gateway's own vocabulary (`critical` / `warning` / `info`), untranslated.
    """

    hours: int
    total: int = 0
    by_severity: dict[str, int] = Field(default_factory=dict)


class SiteKwh(BaseModel):
    """The measured-consumption slot, gated on operator-confirmed kWh units.

    `status`:
      * `blocked`  — zero confirmed registers (this deployment's state); the
        slot renders "—" with `reason` naming the fix, never 0 kWh.
      * `no_data`  — registers confirmed but none produced a usable delta.
      * `measured` — `consumption_kwh` is a real `last − first` sum over the
        confirmed registers, with the double-counting caveat in `reason`.
    """

    confirmed_points: int
    window_hours: int
    consumption_kwh: float | None = None
    status: str
    reason: str


class SiteRow(BaseModel):
    """One leaderboard row: a site from the `site_facts` mirror — or the
    unplaced pseudo-row (`site_id: null`), which is a real state, not filler.

    `score` is NULL until the metric registry defines one; the field exists so
    the screen reads a SLOT rather than hardcoding a dash, and a future score
    lights it up without a frontend change. `city` / `gross_floor_area_sqm`
    are the mirror's facts and NULL means NOT RECORDED.
    """

    site_id: uuid.UUID | None
    site_name: str | None
    placed: bool
    is_active: bool | None = None
    gross_floor_area_sqm: float | None = None
    city: str | None = None
    occupancy: int | None = None
    devices: int
    points: int
    points_reporting: int
    last_seen_at: dt.datetime | None = None
    categories: list[SiteCategoryCount] = Field(default_factory=list)
    alerts: SiteAlerts
    score: float | None = None
    score_reason: str | None = None
    kwh: SiteKwh


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
    # The leaderboard's row set: every site the `site_facts` mirror carries plus
    # the unplaced pseudo-row. Shaped for N sites — one site is simply N=1.
    sites: list[SiteRow] = Field(default_factory=list)
    site_alert_hours: int = 24


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
# The request/response shapes for the BI placement screen used to live here. They
# are gone with the screen and its routes: a placement is stated ONCE, on the
# Sites floor plan, and `device_locations` is now a read-model of core's
# `device_placements` (see `app/placement_sync.py`).
#
# `PlacementSummary` above STAYS. It is a READ over `points` on `/bi/summary`, and
# it is still true whichever surface wrote the placement: placed / unplaced is a
# fact about this store, not about a screen.


# ── Correlation ──────────────────────────────────────────────────────────────
#
# Insights & Correlation. See `queries.correlation_pairs` for the arithmetic and
# the four rules it enforces. What matters HERE is that every field a reader
# needs in order to distrust a coefficient is on the response beside it:
#
#   • `n`                   how many buckets actually overlapped
#   • `resolution`          which store answered, printed, never downgraded
#   • `status` / `reason`   why a coefficient is absent, in words
#   • `frozen`              a one-value series, whose r is UNDEFINED, not 0
#
# There is no `strength` word, no "significant" flag and no p-value. A p-value
# over autocorrelated building time-series with an n the operator did not choose
# would be a stronger claim than the data supports, and this file does not make
# claims the store cannot back.


class CorrelationSeries(BaseModel):
    """One of the series being compared, and its shape over the window."""

    point_id: uuid.UUID
    point_tag: str | None
    device_tag: str | None
    category: str | None
    # Passed through exactly as stored. Null on every point that no operator has
    # confirmed a unit for — and never needed by the coefficient, which is
    # dimensionless.
    unit: str | None
    # Buckets this series filled inside the window. 0 = it reported nothing.
    buckets: int
    distinct_values: int
    # One distinct value over the whole window: the series never moved, so its
    # standard deviation is 0 and every correlation involving it is undefined.
    frozen: bool
    min: float | None = None
    max: float | None = None
    mean: float | None = None
    first_bucket: dt.datetime | None = None
    last_bucket: dt.datetime | None = None


class CorrelationPair(BaseModel):
    """One unordered pair. `r` is present only when it is actually defined."""

    a: uuid.UUID
    b: uuid.UUID
    # Overlapping buckets. Reported even when `r` is null, because "they never
    # overlapped" and "they overlapped 400 times and one side was flat" are
    # different facts and must not render the same.
    n: int
    r: float | None = None
    # "ok" | "no_overlap" | "too_few" | "undefined_frozen"
    status: str
    # Plain words for the screen. Always set, including when status is "ok".
    reason: str
    overlap_start: dt.datetime | None = None
    overlap_end: dt.datetime | None = None


class ScatterSample(BaseModel):
    t: dt.datetime
    a: float
    b: float


class CorrelationResponse(BaseModel):
    resolution: str
    resolution_reason: str
    start: dt.datetime
    end: dt.datetime
    min_buckets: int
    series: list[CorrelationSeries]
    pairs: list[CorrelationPair]
    # Only when exactly two series were asked for: the aligned bucket pairs the
    # coefficient was computed from, so the picture and the number come out of
    # one definition of "overlapping".
    samples: list[ScatterSample] = Field(default_factory=list)
    samples_truncated: bool = False


# ── Units, and the rating built on them ──────────────────────────────────────
#
# `points.unit` is NULL for every point on this deployment (contract §11/§12) and
# a rating is the one surface where that stops being harmless: `kWh / m² / year`
# is a statement about units. These shapes carry the unit AND ITS PROVENANCE,
# because "the operator says this is kWh" and "the wire once sent the string kWh"
# are different claims and only the first one is worth dividing by.
#
# `suggestion` is computed from the TAG at read time and is never stored. See
# `app/api/units.py` for why that line is the whole point of this feature.


class UnitSuggestion(BaseModel):
    """What the tag APPEARS to say. An offer, not a fact."""

    unit: str
    # Shown to the operator verbatim, so they confirm a stated reason rather than
    # a value that appeared from nowhere.
    basis: str


class UnitRow(BaseModel):
    point_id: uuid.UUID
    point_tag: str | None
    device_id: uuid.UUID | None
    device_tag: str | None
    category: str | None
    device_type: str | None
    type: str | None
    # As STORED. Null = nobody has said. An empty string is a real assertion:
    # "this is a ratio and has no unit" (power factor).
    unit: str | None
    # NULL = unconfirmed · "reading" = it arrived in env.u · "operator" = a human
    # asserted it. Only "operator" is accepted as a rating input.
    unit_source: str | None
    unit_confirmed_at: dt.datetime | None = None
    unit_confirmed_by: str | None = None
    site_id: uuid.UUID | None = None
    site_name: str | None = None
    last_seen_at: dt.datetime | None = None
    suggestion: UnitSuggestion | None = None


class UnitCounts(BaseModel):
    points: int
    confirmed: int
    unconfirmed: int


class UnitListResponse(BaseModel):
    counts: UnitCounts
    items: list[UnitRow]


class ConfirmUnitsRequest(BaseModel):
    """Record that a HUMAN says these points are in this unit.

    `point_ids` is EXPLICIT and always a list the operator saw. There is no
    `pattern` field and there must not be one: "apply to everything matching
    `_kw`" expanded on the server is a guess wearing a human's authority. The
    screen expands the pattern, shows the matched rows, and posts their ids.

    `unit = null` CLEARS — unit, source and provenance all go back to NULL and
    the point is unconfirmed again. A mis-typed unit an operator cannot take back
    would silently corrupt every rating computed from it.
    """

    point_ids: list[uuid.UUID] = Field(min_length=1, max_length=1000)
    unit: str | None = Field(default=None, max_length=64)


class SiteFactsRow(BaseModel):
    """A site as the reporting store mirrors it, with its rating inputs.

    Every value is nullable and NULL is NOT RECORDED — the state the Ratings
    screen renders as "cannot rate", with a link to Configurations → Sites.
    """

    site_id: uuid.UUID
    site_name: str | None
    is_active: bool
    gross_floor_area_sqm: float | None = None
    energy_tariff_per_kwh: float | None = None
    tariff_currency: str | None = None
    occupancy: int | None = None
    facts_updated_at: dt.datetime | None = None
    mirrored_at: dt.datetime | None = None
    # Points placed at this site, and how many of them an operator has confirmed
    # are kWh registers. The gap between them is the work.
    points: int = 0
    kwh_points: int = 0


class SiteFactsListResponse(BaseModel):
    items: list[SiteFactsRow]


class MeterRow(BaseModel):
    """One meter's contribution to the total, with the subtraction shown."""

    point_id: uuid.UUID
    point_tag: str | None
    device_tag: str | None
    unit: str | None
    unit_source: str | None
    unit_confirmed_at: dt.datetime | None = None
    unit_confirmed_by: str | None = None
    buckets: int
    first_bucket: dt.datetime | None = None
    last_bucket: dt.datetime | None = None
    first_value: float | None = None
    last_value: float | None = None
    consumption_kwh: float | None = None
    # "ok" | "no_data" | "register_decreased"
    status: str
    reason: str


class EpiResult(BaseModel):
    """The number, and every input that produced it.

    `formula` is the arithmetic as a string, so an operator can check the score
    by hand. A number nobody can audit is not a rating.
    """

    epi_kwh_per_sqm_year: float
    measured_kwh: float
    days_covered: float
    annualised_kwh: float
    area_sqm: float
    formula: str
    # >1 means the window was shorter than a year and the figure is an
    # extrapolation. Stated, never hidden — 20 hours annualised is a projection,
    # not a measurement, and the reader decides what to do with it.
    annualisation_factor: float


class EstimatedCost(BaseModel):
    amount: float
    currency: str
    tariff_per_kwh: float
    formula: str


class BenchmarkState(BaseModel):
    """The band — or, here, the stated absence of one."""

    available: bool
    standard: str | None = None
    version: str | None = None
    reason: str
    what_it_needs: str | None = None


class RatingResponse(BaseModel):
    site: SiteFactsRow
    start: dt.datetime
    end: dt.datetime
    resolution: str
    resolution_reason: str
    meters: list[MeterRow]
    # Present ONLY when every input exists. Null with `blocked` filled otherwise;
    # never a partial score and never a default area.
    epi: EpiResult | None = None
    cost: EstimatedCost | None = None
    benchmark: BenchmarkState
    # Why there is no EPI, in words the screen prints instead of a number.
    blocked: list[str] = Field(default_factory=list)
