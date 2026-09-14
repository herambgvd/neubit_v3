"""What a SAVED v1 widget becomes — and that it still executes afterwards.

WHY THIS FILE EXISTS. `builder.migrate_v1` runs on every read of the four
widgets on the existing "Building Overview" dashboard. Nobody re-saves them, so
whatever this function produces IS the dashboard from now on. Two ways that goes
wrong and neither raises:

  * a field is DROPPED — the widget still draws, it just draws something else.
    A scope filter lost widens one device's chart to the whole estate; a lost
    `ignore_window` retimes a tile its author deliberately pinned;
  * the produced state does not VALIDATE — and then the widget goes blank, which
    `migrate_v1` promises in its own docstring never to do ("deliberately
    total").

So every case here asserts the migrated state BOTH as a dict (the field is
there, and says what v1 said) and through `BuilderQuery.validated()` against the
REAL seeded `iot_readings` definition — the one the 0004 migration inserts, read
out of the revision file rather than retyped, so a dataset that renames a
dimension out from under this map fails here instead of on somebody's dashboard.

No database: `migrate_v1` is a pure dict→dict, and `validated()` only reads the
definition.
"""

from __future__ import annotations

import importlib.util
import pathlib

import pytest
import reporting.models
from kernel.errors import ValidationError

from app.api import builder as b
from app.api.registry import Dataset


def _seeded_iot_definition() -> dict:
    """The `iot_readings` definition as the 0004 migration seeds it.

    Read from the revision file for the same reason `test_schema_completeness`
    does: a copy retyped into a test drifts, and the drift is invisible until a
    migrated widget names a dimension the live dataset no longer publishes.
    """
    path = (
        pathlib.Path(reporting.models.__file__).resolve().parent.parent
        / "migrations"
        / "versions"
        / "0004_dashboard_datasets.py"
    )
    spec = importlib.util.spec_from_file_location("_mig0004", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.IOT_DEFINITION


DATASET = Dataset(
    key="iot_readings",
    name="IoT readings",
    permission="bi.read",
    definition=_seeded_iot_definition(),
)


def _migrate(**query) -> dict:
    return b.migrate_v1({"query": query})


def _spec(raw: dict) -> b.BuilderSpec:
    """The migrated dict as the model the executor is handed."""
    return b.BuilderSpec.model_validate(raw)


def _validated(raw: dict) -> b.BuilderQuery:
    return _spec(raw).query.validated(DATASET)


def _filters(raw: dict) -> list[dict]:
    return raw["query"]["filters"]


# ── the promise: every v1 shape still executes ───────────────────────────────


# One entry per shape a stored v1 `query` can actually have: each scope type
# (including the degenerate and the unrecognised), each kind, each grouping,
# and the two metric families (a value aggregate and the sample tally).
_STORED_V1_QUERIES = [
    {"metric": "avg", "kind": "series",
     "scope": {"type": "points", "point_ids": ["11111111-1111-1111-1111-111111111111"]}},
    {"metric": "avg", "kind": "series", "scope": {"type": "points", "point_ids": []}},
    {"metric": "count", "kind": "series",
     "scope": {"type": "device", "device_id": "22222222-2222-2222-2222-222222222222"}},
    {"metric": "last", "kind": "series", "scope": {"type": "device", "device_tag": "AHU-1"}},
    {"metric": "min", "kind": "series", "scope": {"type": "device"}},
    {"metric": "max", "kind": "series", "scope": {"type": "category", "category": "energy"}},
    {"metric": "first", "kind": "series", "scope": {"type": "category", "category": ""}},
    {"metric": "avg", "kind": "series", "scope": {"type": "all"}},
    {"metric": "avg", "kind": "series", "scope": {"type": "a_scope_v1_never_had"}},
    {"metric": "avg", "kind": "series"},
    {"metric": "avg", "kind": "table", "group_by": "point", "scope": {"type": "all"}},
    {"metric": "count", "kind": "table", "group_by": "point", "scope": {"type": "all"}},
    {"metric": "avg", "kind": "table", "group_by": "device", "scope": {"type": "all"}},
    {"metric": "avg", "kind": "table", "group_by": "category", "scope": {"type": "all"}},
    {"metric": "avg", "kind": "table", "group_by": "a_grouping_v1_never_had",
     "scope": {"type": "all"}},
    {"metric": "a_metric_v1_never_had", "kind": "table", "scope": {"type": "all"}},
    {"kind": "a_kind_v1_never_had", "scope": {"type": "all"}},
    {},
]


@pytest.mark.parametrize("stored", _STORED_V1_QUERIES, ids=range(len(_STORED_V1_QUERIES)))
def test_every_stored_v1_shape_migrates_into_state_that_validates(stored):
    """`migrate_v1` promises to be TOTAL: a combination that raises — or that
    produces a spec the validator rejects — is a saved dashboard going blank on
    read, and there is no user action that fixes it."""
    assert _validated(b.migrate_v1({"query": stored})) is not None


# ── the metric map ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("metric", ["avg", "min", "max", "first", "last"])
def test_a_value_metric_keeps_its_own_aggregate_rather_than_defaulting_to_avg(metric):
    """A v1 "max" tile that migrates to an average shows a plausible, smaller
    number with nothing anywhere saying it changed question."""
    raw = _migrate(metric=metric, kind="series", scope={"type": "all"})
    assert raw["query"]["select"] == [{"measure": "value", "aggregate": metric}]


def test_v1_count_becomes_a_sum_of_samples_and_not_a_count_of_values():
    """v1's `count` was a TALLY OF READINGS, not a physical quantity. Mapping it
    to `count` of `value` would count only the numeric rows and call the result
    the same thing; mapping it to `samples` is what v1 actually displayed."""
    raw = _migrate(metric="count", kind="series", scope={"type": "all"})
    assert raw["query"]["select"] == [{"measure": "samples", "aggregate": "sum"}]


def test_a_metric_this_map_has_never_seen_falls_back_to_average_rather_than_failing():
    raw = _migrate(metric="median", kind="series", scope={"type": "all"})
    assert raw["query"]["select"] == [{"measure": "value", "aggregate": "avg"}]


def test_a_value_metric_is_restricted_to_numeric_points_and_count_is_not():
    """v1 restricted value metrics to `num` points — a text point has no `num`
    and would be a permanently blank row. A COUNT of readings is meaningful for
    text points too, so applying the same filter would undercount."""
    assert {"column": "reading_kind", "op": "=", "value": "num"} in _filters(
        _migrate(metric="avg", scope={"type": "all"})
    )
    assert not any(
        f["column"] == "reading_kind" for f in _filters(_migrate(metric="count", scope={"type": "all"}))
    )


# ── the scope, which is the half that decides WHICH ROWS ─────────────────────


def test_a_points_scope_carries_every_id_it_named():
    ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"]
    raw = _migrate(metric="avg", scope={"type": "points", "point_ids": ids})
    assert {"column": "point_id", "op": "in", "values": ids} in _filters(raw)


def test_a_points_scope_with_no_ids_still_emits_the_empty_in_rather_than_no_filter():
    """An `in` over nothing selects nothing, which is what a v1 widget scoped to
    zero points showed. Dropping the filter instead would silently widen the
    tile to every point in the tenant — the single most damaging thing this
    migration could do, and the one that looks most like a working chart."""
    raw = _migrate(metric="avg", scope={"type": "points", "point_ids": []})
    assert {"column": "point_id", "op": "in", "values": []} in _filters(raw)


def test_a_device_scope_prefers_the_id_over_the_tag_when_it_has_both():
    """A tag is a label an operator can re-use; the id is the device. When v1
    stored both, the id is the one that still means the same device."""
    raw = _migrate(
        metric="avg",
        scope={
            "type": "device",
            "device_id": "22222222-2222-2222-2222-222222222222",
            "device_tag": "AHU-1",
        },
    )
    assert {
        "column": "device_id",
        "op": "=",
        "value": "22222222-2222-2222-2222-222222222222",
    } in _filters(raw)
    assert not any(f["column"] == "device_tag" for f in _filters(raw))


def test_a_device_scope_with_only_a_tag_filters_on_the_tag():
    raw = _migrate(metric="avg", scope={"type": "device", "device_tag": "AHU-1"})
    assert {"column": "device_tag", "op": "=", "value": "AHU-1"} in _filters(raw)


@pytest.mark.parametrize("category", ["", None])
def test_the_unclassified_category_migrates_to_is_null_and_not_to_an_empty_string(
    category,
):
    """v1 spelled "the points nothing has classified" as `category=""`. As an
    equality filter that matches no row in Postgres, so the tile would go empty
    — a real group of points disappearing without an error."""
    raw = _migrate(metric="avg", scope={"type": "category", "category": category})
    assert {"column": "category", "op": "is null"} in _filters(raw)


def test_a_named_category_migrates_to_an_equality_filter():
    raw = _migrate(metric="avg", scope={"type": "category", "category": "energy"})
    assert {"column": "category", "op": "=", "value": "energy"} in _filters(raw)


def test_the_all_scope_narrows_nothing_beyond_the_numeric_restriction():
    """"All" meant the tenant's whole estate in v1 and must not acquire a
    narrowing here; the tenant predicate is `sqlgen`'s job, not a filter."""
    assert _filters(_migrate(metric="avg", scope={"type": "all"})) == [
        {"column": "reading_kind", "op": "=", "value": "num"}
    ]


def test_a_scope_type_this_migration_has_never_seen_produces_no_scope_filter():
    """Pinned deliberately, because it is the shape with the worst failure mode:
    an unrecognised scope narrows NOTHING, so such a widget would silently show
    the whole estate. Nothing in v1 can store one today — this is the assertion
    that has to be revisited the moment something can."""
    assert _filters(_migrate(metric="avg", scope={"type": "floor", "floor_id": "3"})) == [
        {"column": "reading_kind", "op": "=", "value": "num"}
    ]


def test_a_missing_scope_defaults_to_points_and_therefore_selects_nothing():
    """`scope` absent is treated as `points` with no ids, i.e. an empty `in`.
    Asserted so the defaulting is a decision on record rather than a surprise:
    the failure mode of the alternative (no filter) is a widened chart."""
    assert {"column": "point_id", "op": "in", "values": []} in _filters(
        _migrate(metric="avg")
    )


# ── the series shape ─────────────────────────────────────────────────────────


def test_a_v1_series_splits_by_point_and_legends_by_tag_rather_than_by_uuid():
    """v1's legend showed `point_tag`. Dropping to raw uuids would be a
    regression dressed up as generalisation."""
    q = _migrate(metric="avg", kind="series", scope={"type": "all"})["query"]
    assert q["time_series"] is True
    assert q["series_by"] == "point_id"
    assert q["series_label"] == "point_tag"


def test_a_series_limit_is_capped_at_the_series_ceiling_instead_of_failing_validation():
    """A stored v1 limit of 50 is legal as a ROW limit and illegal as a SERIES
    limit. Capping keeps the widget drawing; passing it through would raise
    `a split time-series draws at most 24 series` on every read."""
    q = _migrate(metric="avg", kind="series", scope={"type": "all"}, limit=50)["query"]
    assert q["limit"] == b.MAX_SERIES
    _validated({"spec_version": 2, "viz": "line", "query": q, "options": {}})


def test_a_series_limit_below_the_ceiling_is_left_alone():
    q = _migrate(metric="avg", kind="series", scope={"type": "all"}, limit=5)["query"]
    assert q["limit"] == 5


def test_the_min_max_band_is_carried_from_v1_options_into_query_state():
    """`band` moved from a presentation option to executable state — the server
    answers it with two measured columns. A migration that left it in `options`
    would quietly stop drawing an envelope somebody asked for."""
    raw = b.migrate_v1(
        {"query": {"metric": "avg", "kind": "series", "scope": {"type": "all"}},
         "options": {"band": True}}
    )
    assert raw["query"]["band"] is True
    assert raw["options"] == {"band": True}


def test_no_band_is_asserted_rather_than_left_unset_when_v1_did_not_ask_for_one():
    raw = _migrate(metric="avg", kind="series", scope={"type": "all"})
    assert raw["query"]["band"] is False


# ── the grouped-table shape ──────────────────────────────────────────────────


def test_a_per_point_table_keeps_the_metric_column_and_names_it_after_the_metric():
    q = _migrate(metric="max", kind="table", group_by="point", scope={"type": "all"})["query"]
    assert {"measure": "value", "aggregate": "max", "alias": "max"} in q["select"]
    assert q["group_by"] == ["point_id", "point_tag", "device_tag"]


def test_a_per_point_table_is_ordered_by_the_last_column_it_selected():
    """v1 ordered a grouped aggregate by sample volume, descending. `select_index`
    is positional, so an off-by-one here sorts the table by the METRIC and
    silently reorders every leaderboard built on it."""
    q = _migrate(metric="avg", kind="table", group_by="point", scope={"type": "all"})["query"]
    assert q["select"][q["order_by"][0]["select_index"]]["alias"] == "samples"
    assert q["order_by"][0]["dir"] == "desc"


@pytest.mark.parametrize("group_by, dim", [("device", "device_tag"), ("category", "category")])
def test_a_table_grouped_above_the_point_reports_sample_volume_only(group_by, dim):
    """Pinned because it is a DROPPED COLUMN, not an oversight: `value` declares
    itself incomparable outside a point, so selecting `avg(value)` grouped by
    device would be refused by `_check_comparability` and the widget would go
    blank. v1 showed a count here; this asserts the count is still what arrives,
    so the day the dataset gains a comparable measure this test is the one that
    says the shape was deliberate."""
    q = _migrate(metric="avg", kind="table", group_by=group_by, scope={"type": "all"})["query"]
    assert q["select"] == [
        {"dimension": dim, "alias": group_by},
        {"measure": "samples", "aggregate": "sum", "alias": "samples"},
    ]
    assert q["group_by"] == [dim]


def test_a_group_by_this_migration_has_never_seen_falls_back_to_the_per_point_table():
    """The per-point table is the only fallback that keeps every stored metric
    visible, so an unknown grouping degrades to more detail rather than less."""
    q = _migrate(metric="avg", kind="table", group_by="floor", scope={"type": "all"})["query"]
    assert q["group_by"] == ["point_id", "point_tag", "device_tag"]


# ── everything else the stored spec said ─────────────────────────────────────


def test_the_stored_rollup_becomes_the_resolution_and_auto_is_the_default():
    """A v1 widget pinned to `1h` must not silently start reading `1m`: the two
    weight samples differently and the numbers do not agree."""
    assert _migrate(metric="avg", scope={"type": "all"}, rollup="1h")["query"]["resolution"] == "1h"
    assert _migrate(metric="avg", scope={"type": "all"})["query"]["resolution"] == "auto"


def test_the_stored_window_survives_the_migration_rather_than_resetting_to_six_hours():
    q = _migrate(metric="avg", scope={"type": "all"}, window={"last_hours": 48})["query"]
    assert q["window"] == {"last_hours": 48}


def test_a_v1_spec_with_no_window_gets_the_documented_six_hour_default():
    assert _migrate(metric="avg", scope={"type": "all"})["query"]["window"] == {"last_hours": 6}


def test_the_viz_is_carried_and_defaults_to_line():
    assert b.migrate_v1({"query": {"scope": {"type": "all"}}, "viz": "bar"})["viz"] == "bar"
    assert b.migrate_v1({"query": {"scope": {"type": "all"}}})["viz"] == "line"


@pytest.mark.parametrize(
    "key, value",
    [
        ("ignore_filters", ["site"]),
        ("ignore_all_filters", True),
        ("ignore_window", True),
    ],
)
def test_a_dashboard_context_opt_out_is_carried_across_and_not_dropped(key, value):
    """These say "this tile deliberately ignores the page". Dropping one makes
    the widget follow a filter or a window its author explicitly excluded it
    from — and it still renders, so nobody finds out."""
    q = _migrate(metric="avg", scope={"type": "all"}, **{key: value})["query"]
    assert q[key] == value


@pytest.mark.parametrize("key", ["ignore_filters", "ignore_all_filters", "ignore_window"])
def test_an_opt_out_v1_never_stated_is_left_absent_rather_than_asserted_as_false(key):
    """A genuinely old spec has none of these. Writing a default in would be
    this migration ASSERTING something the author never said; the model's own
    default is the one place that decision belongs."""
    assert key not in _migrate(metric="avg", scope={"type": "all"})["query"]


def test_the_result_is_a_v2_spec_and_says_so():
    raw = _migrate(metric="avg", scope={"type": "all"})
    assert raw["spec_version"] == 2
    assert _spec(raw).spec_version == 2


def test_an_empty_v1_spec_migrates_rather_than_raising():
    """The degenerate stored row — `{}` — is what a half-written widget looks
    like. It must produce something that executes, not a KeyError on read."""
    assert _validated(b.migrate_v1({})) is not None


def test_a_migrated_spec_carries_no_key_the_v2_models_would_reject():
    """`extra="forbid"` everywhere means a stray key from this migration is a
    400 at render time, not a warning. Validating the whole spec is the check."""
    raw = _migrate(metric="count", kind="table", group_by="device", scope={"type": "all"})
    assert _spec(raw).query.dataset == "iot_readings"


def test_a_migrated_spec_that_cannot_validate_is_visible_as_such():
    """The guard on this file's own method: `_validated` must actually be able
    to fail, or every "it validates" assertion above is vacuous."""
    q = b.BuilderQuery.model_validate(
        {"dataset": "iot_readings", "select": [{"dimension": "not_a_dimension"}]}
    )
    with pytest.raises(ValidationError):
        q.validated(DATASET)
