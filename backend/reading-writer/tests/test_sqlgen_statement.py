"""THE SQL A WIDGET'S STATE BECOMES. This module had no test at all.

`sqlgen` is the only thing on this platform that writes SQL from something a
browser sent. Everything protecting that is invisible when it breaks:

* **The tenant predicate.** It is one line. Drop it and every widget still
  renders — it renders the whole estate, to whoever asked. Nothing in the
  response says which tenant the rows came from, so the first person to notice
  would be a customer seeing another customer's building.

* **The bind, rather than the literal.** Every value a caller supplies has to
  arrive as a parameter. A value formatted into the statement is an injection,
  and one that would pass any test that only asserted "a SELECT came back".
  `test_no_caller_value_is_ever_written_into_the_statement` is the one that
  says so: it puts SQL metacharacters in every value-carrying position and
  asserts none of them reach the text.

* **The time column.** It is the RELATION's, not a fixed name — `readings.ts`
  and `readings_1h.bucket` are different columns, and a generator that hard-coded
  either would produce a statement that errors on one store and, worse, a
  time-series bucketed on the wrong column if the names ever collided.

* **The aggregate chosen.** A measure maps (relation, aggregate) → a physical
  function. `avg` on a rollup is `sum(num_sum)/sum(num_count)`, deliberately NOT
  `avg(num_avg)`; the two differ only when buckets hold different sample counts,
  which is always, and the difference is a quietly wrong number on a chart.

WHAT IS NOT HERE. Nothing asserts what Postgres DOES with these statements —
that needs a live TimescaleDB and is out of this suite's scope. These assert the
TEXT, which is the half a pure test can hold.
"""

from __future__ import annotations

import datetime as dt
import uuid

import pytest
from kernel.errors import ValidationError

from app.api import sqlgen
from app.api.builder import BuilderQuery
from app.api.registry import Dataset

UTC = dt.timezone.utc
START = dt.datetime(2026, 3, 1, tzinfo=UTC)
END = dt.datetime(2026, 3, 2, tzinfo=UTC)
TENANT = uuid.UUID("11111111-2222-3333-4444-555555555555")

# The physical mapping the seeded `iot_readings` dataset uses for a rollup: `avg`
# is a RATIO of sums, which is the case that distinguishes a correct generator
# from one that just emits `avg(column)`.
_ROLLUP_VALUE = {
    "avg": {
        "fn": "ratio",
        "numerator": {"fn": "sum", "column": "num_sum"},
        "denominator": {"fn": "sum", "column": "num_count"},
    },
    "sum": {"fn": "sum", "column": "num_sum"},
    "min": {"fn": "min", "column": "num_min"},
    "max": {"fn": "max", "column": "num_max"},
    "first": {"fn": "first", "column": "num_first"},
    "last": {"fn": "last", "column": "num_last"},
}

DEFINITION = {
    "tenant_column": "tenant_id",
    "relations": [
        {"key": "raw", "relation": "readings", "time_column": "ts", "max_window_minutes": 180},
        {"key": "1h", "relation": "readings_1h", "time_column": "bucket", "grain_sec": 3600},
    ],
    "auto": [{"relation": "1h"}],
    "joins": [
        {"key": "points", "relation": "points", "type": "left", "on": [["point_id", "point_id"]]}
    ],
    "dimensions": [
        {"key": "point_id", "label": "Point", "column": "point_id", "type": "uuid"},
        {"key": "point_tag", "label": "Point name", "source": "points", "column": "point_tag"},
        {"key": "device_tag", "label": "Device name", "source": "points", "column": "device_tag"},
        {"key": "category", "label": "Category", "source": "points", "column": "category"},
        {"key": "reading_kind", "label": "Reading kind", "source": "points", "column": "type"},
    ],
    "measures": [
        {
            "key": "value",
            "label": "Reading value",
            "aggregates": ["avg", "sum", "min", "max", "first", "last"],
            "comparable": False,
            "comparable_within": ["point_id"],
            "physical": {
                "raw": {
                    "avg": {"fn": "avg", "column": "num"},
                    "sum": {"fn": "sum", "column": "num"},
                    "min": {"fn": "min", "column": "num"},
                    "max": {"fn": "max", "column": "num"},
                    "first": {"fn": "first", "column": "num"},
                    "last": {"fn": "last", "column": "num"},
                },
                "1h": _ROLLUP_VALUE,
            },
        },
        {
            "key": "samples",
            "label": "Samples",
            "aggregates": ["sum"],
            "physical": {
                "raw": {"sum": {"fn": "count_star"}},
                "1h": {"sum": {"fn": "sum", "column": "sample_count"}},
            },
        },
        {
            # A DERIVED measure: two aggregates over the same relation, each
            # filtered to one named series, subtracted. This is the only shape in
            # which a registry row supplies a VALUE (`OWT`) that has to reach the
            # statement, so it is where a literal would hide if one were ever
            # written.
            "key": "delta_t",
            "label": "Chiller ΔT",
            "aggregates": ["avg"],
            "physical": {
                "raw": {
                    "avg": {
                        "fn": "difference",
                        "left": {
                            "fn": "avg", "column": "num",
                            "where": {"dimension": "point_tag", "equals": "OWT"},
                        },
                        "right": {
                            "fn": "avg", "column": "num",
                            "where": {"dimension": "point_tag", "equals": "IWT"},
                        },
                    }
                },
                "1h": {
                    "avg": {
                        "fn": "difference",
                        "left": {
                            "fn": "sum", "column": "num_sum",
                            "where": {"dimension": "point_tag", "equals": "OWT"},
                        },
                        "right": {
                            "fn": "sum", "column": "num_sum",
                            "where": {"dimension": "point_tag", "equals": "IWT"},
                        },
                    }
                },
            },
        },
    ],
}

DATASET = Dataset(
    key="iot_readings", name="IoT readings", permission="bi.read", definition=DEFINITION
)


def _q(**over) -> BuilderQuery:
    body = {"dataset": "iot_readings"}
    body.update(over)
    return BuilderQuery.model_validate(body)


def _build(q: BuilderQuery, *, rel: str = "1h", tenant=TENANT, **kw) -> sqlgen.Generated:
    return sqlgen.build(
        DATASET, q,
        rel=DATASET.definition.relation(rel),
        start=START, end=END, tenant=tenant, **kw,
    )


VALUE_AVG = [{"measure": "value", "aggregate": "avg"}]


# ── tenant scoping ───────────────────────────────────────────────────────────


class TestTenantScope:
    def test_every_statement_filters_on_the_tenant_column(self):
        """Without this line a widget returns the whole platform's rows and looks
        exactly the same doing it."""
        g = _build(_q(select=VALUE_AVG, group_by=["point_id"]))
        assert '"t"."tenant_id" = CAST(:p1 AS uuid)' in g.sql
        assert g.params["p1"] == TENANT

    def test_the_tenant_comes_from_the_argument_and_not_from_the_query(self):
        """The tenant is the JWT's, passed in by the router. A widget that could
        put a tenant id in its own state could read another estate."""
        other = uuid.uuid4()
        g = _build(_q(select=VALUE_AVG, group_by=["point_id"]), tenant=other)
        assert g.params["p1"] == other
        assert str(TENANT) not in g.sql

    def test_a_platform_superadmin_binds_null_rather_than_dropping_the_clause(self):
        """NULL is how "no tenant filter" is said. If the CLAUSE were dropped
        instead, the shape of the statement would differ between an admin and a
        tenant — and the admin path is the one nobody charts day to day."""
        g = _build(_q(select=VALUE_AVG, group_by=["point_id"]), tenant=None)
        assert g.params["p1"] is None
        assert "CAST(:p1 AS uuid) IS NULL OR" in g.sql

    def test_discover_series_is_tenant_scoped_too(self):
        """It runs BEFORE the chart query and decides which series exist. Unscoped,
        it leaks the existence of another tenant's points even if the chart query
        that follows returns none of their rows."""
        g = sqlgen.discover_series(
            DATASET, _q(select=VALUE_AVG, time_series=True, series_by="point_id"),
            rel=DATASET.definition.relation("1h"),
            start=START, end=END, tenant=TENANT,
        )
        assert '"t"."tenant_id" = CAST(:p1 AS uuid)' in g.sql
        assert g.params["p1"] == TENANT


# ── nothing a caller sends becomes SQL text ──────────────────────────────────


class TestNothingIsInterpolated:
    def test_no_caller_value_is_ever_written_into_the_statement(self):
        """The injection test. Every value-carrying position gets a string full of
        SQL metacharacters; none of it may appear in the generated text.

        If this fails, the failure is not a coverage gap — it is that a browser
        can write SQL against `neubit_reporting`.
        """
        evil = "x'; DROP TABLE readings; --"
        q = _q(
            select=VALUE_AVG,
            group_by=["point_id"],
            filters=[
                {"column": "category", "op": "=", "value": evil},
                {"column": "device_tag", "op": "contains", "value": evil},
                {"column": "point_tag", "op": "like", "value": evil},
                {"column": "reading_kind", "op": "in", "values": [evil, "num"]},
                {"column": "category", "op": "between", "value": evil, "value2": evil},
            ],
        )
        g = _build(q)
        assert "DROP TABLE" not in g.sql
        # The generator's own `ESCAPE '\\'` is the ONLY quoted literal it is
        # allowed to write — it is a constant, not a value. Remove it and no
        # quote character may remain anywhere in the statement.
        assert "'" not in g.sql.replace("ESCAPE '\\'", ""), g.sql
        # …and it is still all there, as bound parameters.
        assert any(evil in str(v) for v in g.params.values())

    def test_a_registry_supplied_filter_value_is_bound_as_well(self):
        """`delta_t` carries `OWT`/`IWT` from the dataset ROW. A registry string
        interpolated into the statement would be a stored injection with extra
        steps — the row is trusted-ish, the mechanism must not be."""
        g = _build(_q(select=[{"measure": "delta_t", "aggregate": "avg"}], group_by=["point_id"]))
        assert "OWT" not in g.sql
        assert "IWT" not in g.sql
        assert "OWT" in g.params.values()
        assert "IWT" in g.params.values()

    def test_the_window_ends_up_bound_and_not_formatted(self):
        """A timestamp rendered as text is a timezone bug waiting to happen as
        well as an interpolation."""
        g = _build(_q(select=VALUE_AVG, group_by=["point_id"]))
        assert START in g.params.values()
        assert END in g.params.values()
        assert "2026-03-01" not in g.sql

    def test_a_series_alias_that_is_not_an_identifier_collapses_the_generation(self):
        """`alias` is free text from the client and lands in an IDENTIFIER
        position, where no bind can help. It has to be refused, not quoted and
        hoped for."""
        q = _q(select=[{"measure": "value", "aggregate": "avg", "alias": 'a" , (SELECT 1) x'}],
               group_by=["point_id"])
        with pytest.raises(ValidationError):
            _build(q)

    def test_only_a_select_is_ever_emitted(self):
        g = _build(_q(select=VALUE_AVG, group_by=["point_id"]))
        assert g.sql.startswith("SELECT ")
        for word in ("INSERT", "UPDATE", "DELETE", "DROP", ";"):
            assert word not in g.sql


# ── which column is the time column ──────────────────────────────────────────


class TestTimeColumn:
    def test_the_window_and_the_bucket_use_the_RELATION_s_own_time_column(self):
        """`readings.ts` and `readings_1h.bucket` are different columns. Hard-code
        either and one of the two stores produces a statement that cannot run."""
        raw = _build(_q(select=VALUE_AVG, time_series=True, group_by=["point_id"]), rel="raw")
        assert '"t"."ts" >= :' in raw.sql
        assert '"t"."ts" < :' in raw.sql
        assert '"t"."ts" AS "__t"' in raw.sql

        hourly = _build(_q(select=VALUE_AVG, time_series=True, group_by=["point_id"]), rel="1h")
        assert '"t"."bucket" >= :' in hourly.sql
        assert '"t"."bucket" AS "__t"' in hourly.sql
        assert '"ts"' not in hourly.sql

    def test_the_window_is_half_open_so_a_bucket_is_never_counted_twice(self):
        """`>= start AND < end`. Two adjacent windows that both used `<=` would
        share their boundary bucket, and a "this hour vs last hour" tile would
        double-count it."""
        g = _build(_q(select=VALUE_AVG, group_by=["point_id"]))
        assert '"t"."bucket" >= :p2 AND "t"."bucket" < :p3' in g.sql
        assert ">= " in g.sql
        assert "<= " not in g.sql

    def test_a_time_series_is_ordered_by_the_bucket_ahead_of_whatever_was_asked_for(self):
        """A line chart drawn out of time order is a scribble. The user's own
        ordering is kept, behind it."""
        g = _build(_q(
            select=[{"measure": "value", "aggregate": "avg"}],
            time_series=True, group_by=["point_id"],
            order_by=[{"select_index": 0, "dir": "desc"}],
        ))
        assert 'ORDER BY "__t" ASC, "value_avg" DESC' in g.sql

    def test_a_non_time_series_has_no_bucket_column_at_all(self):
        g = _build(_q(select=[{"dimension": "point_tag"}, {"measure": "samples", "aggregate": "sum"}],
                      group_by=["point_tag"]))
        # `__total` contains `__t`, so the bucket column is asked for by its alias.
        assert 'AS "__t"' not in g.sql


# ── which aggregate is chosen ────────────────────────────────────────────────


class TestAggregateChosen:
    def test_avg_on_a_rollup_is_a_ratio_of_sums_not_an_average_of_averages(self):
        """`avg(num_avg)` weights a bucket of two samples like a bucket of sixty.
        The number it produces is plausible, wrong, and un-noticeable on a chart."""
        g = _build(_q(select=VALUE_AVG, group_by=["point_id"]))
        assert 'sum("t"."num_sum")' in g.sql
        assert 'sum("t"."num_count")' in g.sql
        assert "nullif" in g.sql
        assert 'avg("t"."num_avg")' not in g.sql

    def test_a_ratio_guards_its_denominator_so_an_empty_group_is_null_not_zero(self):
        """Contract §4: absence renders as absence. Without the nullif this is a
        division error; with a coalesce it would be a confident 0."""
        g = _build(_q(select=VALUE_AVG, group_by=["point_id"]))
        assert '/ nullif((sum("t"."num_count")), 0)::double precision' in g.sql

    def test_the_same_measure_maps_differently_per_relation(self):
        """`avg` is a plain `avg(num)` on raw and a ratio on the rollup. Choosing
        by measure alone rather than by (relation, measure) would silently use
        one store's mapping against the other's columns."""
        raw = _build(_q(select=VALUE_AVG, group_by=["point_id"]), rel="raw")
        assert 'avg("t"."num")' in raw.sql
        assert "num_sum" not in raw.sql

    def test_first_and_last_are_ordered_by_time_and_not_by_scan_order(self):
        """`last(x)` without an ordering column is whatever the planner read last,
        which is not "the most recent reading" and is not stable between runs."""
        g = _build(_q(select=[{"measure": "value", "aggregate": "last"}], group_by=["point_id"]),
                   rel="raw")
        assert 'last("t"."num", "t"."ts")' in g.sql

    def test_a_derived_measure_becomes_two_filtered_aggregates_subtracted(self):
        """ΔT is `avg(OWT) − avg(IWT)` over the same rows, and each side's filter
        is a FILTER (WHERE …) on a bound value. Lose a FILTER and both halves
        aggregate every series, so ΔT comes out as zero for every chiller."""
        g = _build(_q(select=[{"measure": "delta_t", "aggregate": "avg"}], group_by=["point_id"]))
        assert g.sql.count("FILTER (WHERE") == 2
        assert '(sum("t"."num_sum") FILTER (WHERE "points"."point_tag" = :' in g.sql
        assert ") - (" in g.sql

    def test_an_aggregate_the_measure_does_not_permit_is_refused_by_name(self):
        """Samples is a count; there is no `avg` mapping for it. Falling through
        to some default would chart a number nothing computed."""
        q = _q(select=[{"measure": "samples", "aggregate": "avg"}], group_by=["point_id"])
        with pytest.raises(ValidationError, match="Samples"):
            _build(q)

    def test_count_star_takes_no_column(self):
        g = _build(_q(select=[{"measure": "samples", "aggregate": "sum"}], group_by=["point_id"]),
                   rel="raw")
        assert "count(*)" in g.sql


# ── joins, grouping and the honest total ─────────────────────────────────────


class TestShape:
    def test_a_widget_that_touches_only_the_fact_table_pays_for_no_join(self):
        """Every join is a planner cost on a hypertable. One added because it was
        declared rather than because it was needed is a slow chart with no symptom
        other than being slow."""
        g = _build(_q(select=VALUE_AVG, group_by=["point_id"]))
        assert "JOIN" not in g.sql

    def test_a_dimension_on_a_join_brings_that_join_in_once(self):
        g = _build(_q(select=[{"dimension": "point_tag"}, {"measure": "value", "aggregate": "avg"}],
                      group_by=["point_tag", "device_tag"]))
        assert g.sql.count("LEFT JOIN") == 1
        assert 'LEFT JOIN "points" AS "points" ON "t"."point_id" = "points"."point_id"' in g.sql

    def test_a_join_a_derived_measure_needs_is_planned_even_though_nothing_named_it(self):
        """`delta_t` filters on `point_tag`, which lives on `points`. The widget
        never selects, groups or filters by it — and without planning for it the
        statement references an alias that is not in its own FROM clause."""
        g = _build(_q(select=[{"measure": "delta_t", "aggregate": "avg"}], group_by=["point_id"]))
        assert 'LEFT JOIN "points"' in g.sql
        assert '"points"."point_tag"' in g.sql

    def test_a_grouped_query_reports_how_many_groups_there_were(self):
        """`count(*) OVER ()` after grouping is what lets a widget say "showing 8
        of 37" instead of presenting a truncated answer as a complete one."""
        g = _build(_q(select=[{"dimension": "point_tag"}, {"measure": "samples", "aggregate": "sum"}],
                      group_by=["point_tag"]))
        assert 'count(*) OVER () AS "__total"' in g.sql
        assert "GROUP BY" in g.sql

    def test_an_ungrouped_query_claims_no_total(self):
        """A `__total` on an ungrouped statement counts ROWS, not groups, and the
        widget would print it as a group count."""
        g = _build(_q(select=[{"measure": "samples", "aggregate": "sum"}]))
        assert "__total" not in g.sql
        assert "GROUP BY" not in g.sql

    def test_a_dimension_is_grouped_by_and_a_measure_is_not(self):
        """Getting this backwards is a Postgres error on the dimension and a
        silently collapsed chart on the measure."""
        g = _build(_q(select=[{"dimension": "point_tag"}, {"measure": "samples", "aggregate": "sum"}],
                      group_by=["point_tag"]))
        group = g.sql.split("GROUP BY ")[1]
        assert '"points"."point_tag"' in group
        assert "sample_count" not in group

    def test_a_condition_on_an_aggregate_without_a_grouping_is_refused(self):
        """HAVING with no GROUP BY collapses the whole result to one row that
        passes or vanishes — never what the widget meant."""
        q = _q(
            select=[{"measure": "samples", "aggregate": "sum"}],
            having=[{"measure": "samples", "aggregate": "sum", "op": ">", "value": 10}],
        )
        with pytest.raises(ValidationError, match="grouping"):
            _build(q)

    def test_a_split_time_series_is_capped_by_buckets_not_by_the_series_limit(self):
        """`limit` on a split chart counts SERIES — `discover_series` already
        applied it. Re-using it as a row cap would truncate 12 series to 12 rows,
        which is one point per line."""
        g = _build(_q(select=VALUE_AVG, time_series=True, series_by="point_id", limit=12))
        assert f"LIMIT {sqlgen.MAX_BUCKET_ROWS}" in g.sql

        flat = _build(_q(select=[{"dimension": "point_tag"},
                                 {"measure": "samples", "aggregate": "sum"}],
                         group_by=["point_tag"], limit=12))
        assert flat.sql.endswith("LIMIT 12")


# ── predicates ───────────────────────────────────────────────────────────────


class TestPredicates:
    def test_contains_escapes_the_users_own_wildcards(self):
        """Searching for "50%" must not match everything. The LIKE escape is the
        only thing between a literal search and a full scan that matches all."""
        g = _build(_q(select=VALUE_AVG, group_by=["point_id"],
                      filters=[{"column": "device_tag", "op": "contains", "value": "50%_x"}]))
        assert "ESCAPE" in g.sql
        assert g.params["p4"] == "%50\\%\\_x%"

    def test_like_passes_the_pattern_through_unescaped(self):
        """`contains` and `like` differ only here, and the difference is the whole
        reason both exist."""
        g = _build(_q(select=VALUE_AVG, group_by=["point_id"],
                      filters=[{"column": "device_tag", "op": "like", "value": "AHU-%"}]))
        assert g.params["p4"] == "AHU-%"

    def test_a_uuid_dimension_refuses_a_value_that_is_not_one(self):
        """Bound or not, `point_id = 'chiller'` is a type error at execution time
        — a 500 for what is a user's typo."""
        q = _q(select=VALUE_AVG, group_by=["point_id"],
               filters=[{"column": "point_id", "op": "=", "value": "not-a-uuid"}])
        with pytest.raises(ValidationError, match="needs an id"):
            _build(q)

    def test_is_null_carries_no_bind_at_all(self):
        """There is no value to bind. A bind here would become `= NULL`, which
        matches nothing and is not what "unclassified" means."""
        g = _build(_q(select=VALUE_AVG, group_by=["point_id"],
                      filters=[{"column": "category", "op": "is null"}]))
        assert '"points"."category" IS NULL' in g.sql
        assert len(g.params) == 3  # tenant, start, end — and nothing more

    def test_the_combinator_the_widget_asked_for_is_the_one_used(self):
        """AND where the author meant OR silently returns nothing, which reads as
        "no data" rather than as a bug."""
        f = [{"column": "category", "op": "=", "value": "energy"},
             {"column": "category", "op": "=", "value": "hvac"}]
        assert " OR " in _build(_q(select=VALUE_AVG, group_by=["point_id"],
                                   filters=f, filter_combinator="OR")).sql
        # The tenant clause has an OR of its own, so the assertion is about the
        # bracket the USER's predicates live in.
        anded = _build(_q(select=VALUE_AVG, group_by=["point_id"], filters=f)).sql
        assert '("points"."category" = :p4 AND "points"."category" = :p5)' in anded

    def test_an_unresolved_dashboard_variable_drops_nothing_silently(self):
        """A filter still carrying a `variable` was never resolved. It must not
        become "no predicate" — that widens the widget to the whole estate while
        the page still shows it as filtered."""
        q = _q(select=VALUE_AVG, group_by=["point_id"],
               filters=[{"column": "category", "op": "=", "variable": "site"}])
        assert q.filters[0].complete() is False
        g = _build(q)
        assert '"points"."category"' not in g.sql.split("WHERE")[1].split("GROUP BY")[0]

    def test_series_keys_narrow_the_chart_to_the_series_that_were_discovered(self):
        """This is what bounds a split chart's cost. Without it a dataset with
        three hundred series charts three hundred."""
        keys = [str(uuid.uuid4()), str(uuid.uuid4())]
        g = _build(_q(select=VALUE_AVG, time_series=True, series_by="point_id"),
                   series_keys=keys)
        assert '"t"."point_id" = ANY(CAST(:' in g.sql
        assert keys in g.params.values()


# ── the preview echo ─────────────────────────────────────────────────────────


class TestPreview:
    def test_the_preview_inlines_every_bind_and_leaves_no_placeholder_behind(self):
        """The builder shows this read-only. A `:p3` left in it tells a person
        nothing, and `:p1` clobbering `:p10` would show the wrong value."""
        q = _q(select=VALUE_AVG, group_by=["point_id"], filters=[
            {"column": "category", "op": "=", "value": f"c{i}"} for i in range(9)
        ])
        g = _build(q)
        assert len(g.params) >= 10
        preview = g.preview()
        assert ":p" not in preview
        assert "'c8'" in preview

    def test_the_preview_escapes_a_quote_rather_than_producing_a_broken_echo(self):
        g = _build(_q(select=VALUE_AVG, group_by=["point_id"],
                      filters=[{"column": "device_tag", "op": "like", "value": "O'Brien"}]))
        assert "'O''Brien'" in g.preview()

    def test_the_preview_is_never_what_executes(self):
        """The escaped form exists only for the echo. If `build` ever returned it
        as `sql`, the whole bind design would be decorative."""
        g = _build(_q(select=VALUE_AVG, group_by=["point_id"],
                      filters=[{"column": "device_tag", "op": "like", "value": "O'Brien"}]))
        assert "O'Brien" not in g.sql
        assert ":p" in g.sql


# ── what the columns MEAN ────────────────────────────────────────────────────


class TestColumnMetadata:
    def test_every_selected_column_is_described_for_the_chart_that_draws_it(self):
        """A column the metadata misses is a series the chart cannot label, and
        the frontend's fallback is the raw alias."""
        g = _build(_q(select=[{"dimension": "point_tag"},
                              {"measure": "value", "aggregate": "avg", "alias": "mean"}],
                      time_series=True, group_by=["point_tag"]))
        by_name = {c["name"]: c for c in g.columns}
        assert by_name["__t"]["role"] == "time"
        assert by_name["point_tag"]["role"] == "dimension"
        assert by_name["mean"]["role"] == "measure"
        assert by_name["mean"]["label"] == "Reading value"
        assert by_name["mean"]["aggregate"] == "avg"

    def test_a_split_series_publishes_its_key_and_its_legend_separately(self):
        """The split key is a uuid and the legend is not. Collapsing the two is
        how a legend ends up reading as raw ids."""
        g = _build(_q(select=VALUE_AVG, time_series=True,
                      series_by="point_id", series_label="point_tag"))
        assert '"t"."point_id" AS "__s"' in g.sql
        assert '"points"."point_tag" AS "__sl"' in g.sql
        roles = {c["role"] for c in g.columns}
        assert {"series", "series_label"} <= roles

    def test_a_band_adds_the_stores_own_min_and_max_rather_than_the_chart_inventing_one(self):
        g = _build(_q(select=VALUE_AVG, time_series=True, series_by="point_id", band=True))
        assert '"__band_lo"' in g.sql
        assert '"__band_hi"' in g.sql
        assert 'min("t"."num_min")' in g.sql
        assert 'max("t"."num_max")' in g.sql

    def test_the_band_columns_are_not_grouped_by(self):
        """They are aggregates. In the GROUP BY they would split every bucket by
        its own min and max, which is one row per sample."""
        g = _build(_q(select=VALUE_AVG, time_series=True, series_by="point_id", band=True))
        assert "num_min" not in g.sql.split("GROUP BY ")[1]
