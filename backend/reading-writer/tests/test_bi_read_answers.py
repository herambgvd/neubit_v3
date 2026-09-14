"""WHAT THE /bi READ SURFACE ANSWERS — the refusals, not the happy numbers.

`test_route_inventory.py` asks whether each route is REACHABLE. This asks what a
caller who gets through is handed, and it concentrates on the shape the routes
are built around: **absence renders as absence, and it says which absence.**

That rule is the whole of this API's honesty story, and it is the half that
cannot be seen in a screenshot. A correlation of 0.0 and "these two series never
overlapped" look identical on a chart; a five-star rating built on dead meters
looks exactly like a five-star rating. The functions below are where the two are
told apart, and every one of them is a pure function over rows that have already
been fetched — so they can be asked without a database, which is the only way to
hold "one series is frozen and the other is silent" open on demand.

WHAT IS NOT HERE. Nothing asserts what the SQL returns; the statements read the
`readings` hypertable and `corr()` is Postgres arithmetic, both of which need a
live TimescaleDB. The queries are stubbed where a route is driven end to end, and
what is asserted is the trip from a row to a response.
"""

from __future__ import annotations

import datetime as dt
import uuid

import pytest
from kernel.auth import Principal, Scope
from kernel.errors import ValidationError

from app.api import queries as q
from app.api import registry, router as r

UTC = dt.timezone.utc


def at(day: int, hour: int = 0) -> dt.datetime:
    return dt.datetime(2026, 3, day, hour, tzinfo=UTC)


A, B, C = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()


def meta(pid, *, point="SAT", device="AHU-1", unit=None, category="hvac") -> dict:
    return {"point_id": pid, "point_tag": point, "device_tag": device,
            "category": category, "unit": unit}


def stats(*, n=10, distinct=5, lo=1.0, hi=9.0, mean=5.0) -> dict:
    return {"n": n, "distinct_values": distinct, "min": lo, "max": hi, "mean": mean,
            "first_bucket": at(1), "last_bucket": at(2)}


# ── the tenant a query is filtered by ────────────────────────────────────────


class TestTenantFromTheToken:
    def test_a_tenant_caller_is_scoped_to_their_own_claim(self):
        t = uuid.uuid4()
        assert r._tenant(Scope(tenant_id=t, is_superadmin=False)) == t

    def test_a_platform_superadmin_is_scoped_to_nothing(self):
        """None is read by the queries as "no tenant filter". It is the ONLY way
        to see across tenants, and it comes from the token, never the request."""
        assert r._tenant(Scope(tenant_id=None, is_superadmin=True)) is None

    def test_a_tenantless_ordinary_token_fails_closed(self):
        """The dangerous case. A non-superadmin with no tenant claim cannot be
        scoped to anything — falling through to None would hand that caller the
        super-admin's unfiltered view of the whole platform."""
        scope = Scope(tenant_id=None, is_superadmin=False)
        with pytest.raises(ValidationError, match="no tenant"):
            r._tenant(scope)


class TestWindow:
    def test_a_naive_timestamp_is_read_as_utc_rather_than_as_local(self):
        """The store is timestamptz. A naive datetime compared against it drifts
        by the server's offset, and the chart is silently shifted by hours."""
        start, end = r._window(dt.datetime(2026, 3, 1), dt.datetime(2026, 3, 2), 24)
        assert start.tzinfo is not None
        assert end.tzinfo is not None
        assert start == at(1)
        assert end == at(2)

    def test_an_omitted_start_is_the_default_span_back_from_the_end(self):
        _, end = r._window(None, at(2), 24)
        start, _ = r._window(None, at(2), 24)
        assert end - start == dt.timedelta(hours=24)

    def test_an_inverted_window_is_refused_rather_than_returning_nothing(self):
        """`start > end` matches no rows, so the chart draws an empty panel and
        the caller is told nothing about why."""
        later, earlier = at(2), at(1)
        with pytest.raises(ValidationError, match="before"):
            r._window(later, earlier, 24)


# ── correlation: which points, and at which grain ────────────────────────────


class TestCorrelationInputs:
    def test_the_same_point_named_twice_is_not_two_series(self):
        """A caller who ticks one point twice would otherwise get a matrix of it
        against itself, whose r is 1.0 and means nothing."""
        with pytest.raises(ValidationError, match="two distinct"):
            r._correlation_points([A, A])

    def test_a_matrix_wider_than_the_ceiling_is_refused_with_the_count(self):
        """Pair count is quadratic. The refusal names both numbers so the caller
        can act on it instead of guessing at the limit."""
        with pytest.raises(ValidationError) as exc:
            r._correlation_points([uuid.uuid4() for _ in range(q.MAX_CORRELATION_POINTS + 1)])
        assert str(q.MAX_CORRELATION_POINTS) in str(exc.value)

    def test_the_order_the_caller_asked_in_is_the_order_returned(self):
        """The pair list is built off this order, and a legend that reorders
        itself between requests is unreadable."""
        assert r._correlation_points([B, A, C, A]) == [B, A, C]

    def test_raw_is_refused_by_name_rather_than_silently_downgraded(self):
        """Correlating raw samples correlates whatever happened to share a
        timestamp, which is a different question from the one the screen asks.
        A silent swap to a rollup would answer a question nobody asked."""
        start, end = at(1), at(2)
        with pytest.raises(ValidationError, match="never on raw"):
            r._correlation_resolution("raw", start, end)

    def test_a_named_resolution_is_honoured_and_says_why_it_is_the_one(self):
        """The reason is printed beside the chart. `1m` is materialized-only and
        its newest couple of minutes may be missing — a caller reading a live
        number off it has to be told."""
        res, why = r._correlation_resolution("1m", at(1), at(2))
        assert res == "1m"
        assert "materialized-only" in why

    def test_auto_defers_to_the_shared_chooser(self):
        """One place decides which store answers a window. A second copy of the
        rule here would drift from `/bi/series` and the two screens would chart
        the same window at different grains."""
        assert r._correlation_resolution("auto", at(1), at(1, 1)) == q.choose_resolution(
            at(1), at(1, 1)
        )


# ── correlation: a series that never moved is not a series with no data ──────


class TestCorrelationSeries:
    def test_a_series_that_reported_one_value_all_window_is_marked_frozen(self):
        """Every kWh register on this estate is flat. A frozen series has zero
        standard deviation, so Pearson's r is undefined — and reporting that as
        0.0 would be a confident claim of "no relationship"."""
        out = r._correlation_series([A], {A: meta(A)}, {A: stats(n=40, distinct=1)})
        assert out["series"][0]["frozen"] is True
        assert out["frozen"] == {A}

    def test_a_series_with_no_buckets_is_silent_and_not_frozen(self):
        """Two different faults with two different fixes: a frozen register is
        wired and stuck, a silent one is not reporting at all."""
        out = r._correlation_series([A], {A: meta(A)}, {})
        row = out["series"][0]
        assert row["buckets"] == 0
        assert row["frozen"] is False
        assert out["silent"] == {A}
        assert out["frozen"] == set()
        assert row["min"] is row["max"] is row["mean"] is None

    def test_a_varying_series_is_neither(self):
        """The negative case, and it matters most: a rule that flagged healthy
        series would be switched off, taking the real protection with it."""
        out = r._correlation_series([A], {A: meta(A)}, {A: stats()})
        assert out["frozen"] == set()
        assert out["silent"] == set()
        assert out["series"][0]["buckets"] == 10

    def test_each_series_carries_the_labels_a_reader_needs_to_identify_it(self):
        out = r._correlation_series([A], {A: meta(A, point="SAT", device="AHU-1")}, {A: stats()})
        assert (out["series"][0]["point_tag"], out["series"][0]["device_tag"]) == ("SAT", "AHU-1")


# ── correlation: every pair says what it is, or why it is nothing ────────────


def _pairs(rows, metas, frozen=(), silent=(), points=(A, B), resolution="1h"):
    return r._correlation_pairs(list(points), rows, metas, set(frozen), set(silent), resolution)


META = {A: meta(A, point="OWT"), B: meta(B, point="IWT"), C: meta(C, point="kWh")}


class TestCorrelationPairs:
    def test_a_healthy_pair_carries_the_coefficient_and_its_sample_count(self):
        rows = [{"a_id": A, "b_id": B, "n": 20, "r": 0.87,
                 "overlap_start": at(1), "overlap_end": at(2)}]
        (pair,) = _pairs(rows, META)
        assert pair["status"] == "ok"
        assert pair["r"] == pytest.approx(0.87)
        assert "20 aligned 1h buckets" in pair["reason"]

    def test_a_pair_the_query_returned_the_other_way_round_is_still_found(self):
        """The statement returns each unordered pair once, in whichever order it
        chose. A lookup that only tried (a, b) would report half the matrix as
        having no overlap at all."""
        rows = [{"a_id": B, "b_id": A, "n": 20, "r": 0.5,
                 "overlap_start": at(1), "overlap_end": at(2)}]
        (pair,) = _pairs(rows, META)
        assert pair["status"] == "ok"

    def test_a_frozen_series_makes_the_pair_undefined_and_says_it_is_not_zero(self):
        """The sentence matters as much as the status. An operator reading "0"
        concludes the two are unrelated; the truth is that one of them has not
        moved and no coefficient exists."""
        rows = [{"a_id": A, "b_id": B, "n": 20, "r": None,
                 "overlap_start": at(1), "overlap_end": at(2)}]
        (pair,) = _pairs(rows, META, frozen=[A])
        assert pair["status"] == "undefined_frozen"
        assert pair["r"] is None
        assert "not a correlation of zero" in pair["reason"]
        assert "OWT" in pair["reason"]      # WHICH series is stuck

    def test_a_pair_with_too_few_overlapping_buckets_is_refused_not_computed(self):
        """Below a handful of points, r is decided by the arithmetic rather than
        by the building — and it is usually close to ±1, which reads as a strong
        finding."""
        rows = [{"a_id": A, "b_id": B, "n": q.MIN_CORRELATION_BUCKETS - 1, "r": 0.99,
                 "overlap_start": at(1), "overlap_end": at(2)}]
        (pair,) = _pairs(rows, META)
        assert pair["status"] == "too_few"
        assert pair["r"] is None

    def test_a_null_coefficient_over_enough_buckets_is_still_undefined(self):
        """`corr()` goes NULL for a series flat only ACROSS THE OVERLAP, which the
        whole-window distinct-value check cannot see. Passing None through as the
        answer would render as a blank cell that looks like a loading state."""
        rows = [{"a_id": A, "b_id": B, "n": 30, "r": None,
                 "overlap_start": at(1), "overlap_end": at(2)}]
        (pair,) = _pairs(rows, META)
        assert pair["status"] == "undefined_frozen"
        assert "did not vary" in pair["reason"]

    def test_a_pair_with_no_overlap_names_the_series_that_reported_nothing(self):
        """Two series that never met and one series that never reported are
        different problems. Saying only "no overlap" sends the operator to check
        clock alignment on a point that is simply offline."""
        (pair,) = _pairs([], META, silent=[B])
        assert pair["status"] == "no_overlap"
        assert pair["n"] == 0
        assert "IWT" in pair["reason"]
        assert "no numeric bucket" in pair["reason"]

    def test_two_series_that_both_reported_but_never_aligned_say_exactly_that(self):
        (pair,) = _pairs([], META)
        assert "never filled the same bucket" in pair["reason"]

    def test_every_unordered_pair_appears_once_and_no_series_against_itself(self):
        """A matrix with duplicates double-counts; one with self-pairs shows a
        row of 1.0s that means nothing."""
        pairs = _pairs([], META, points=(A, B, C))
        assert len(pairs) == 3
        assert all(p["a"] != p["b"] for p in pairs)
        assert {frozenset((p["a"], p["b"])) for p in pairs} == {
            frozenset((A, B)), frozenset((A, C)), frozenset((B, C))
        }

    def test_a_frozen_series_outranks_a_thin_overlap_in_the_reason_given(self):
        """Both are true; only one is the actionable fault. Reporting "too few
        buckets" for a register that has been stuck for a month sends the
        operator to widen the window, which cannot help."""
        rows = [{"a_id": A, "b_id": B, "n": 1, "r": None,
                 "overlap_start": at(1), "overlap_end": at(2)}]
        (pair,) = _pairs(rows, META, frozen=[A])
        assert pair["status"] == "undefined_frozen"


# ── rating: which meters count, and what the EPI is annualised from ──────────


class TestMeterSelection:
    def test_a_named_point_that_is_not_a_candidate_is_reported_rather_than_dropped(self):
        """"Not at this site / retired / unit never confirmed" has to reach the
        caller. Dropped silently, the rating is computed from fewer meters than
        the operator selected and nothing says so."""
        out = r._selected_meters([A, B], {A: meta(A)})
        assert out["chosen"] == [A]
        assert out["unusable"] == [str(B)]

    def test_the_same_meter_named_twice_is_counted_once(self):
        """Counted twice, its kWh are added twice and the EPI is doubled."""
        assert r._selected_meters([A, A], {A: meta(A)})["chosen"] == [A]

    def test_no_meter_and_no_candidate_blames_the_missing_unit_confirmation(self):
        """The wire carries no unit. Until an operator confirms kWh there is
        genuinely nothing to add up, and the message has to say that rather than
        pointing at a role nobody could have bound."""
        why = r._no_meter_reason([])
        assert "CONFIRMED kWh" in why

    def test_no_meter_but_candidates_present_points_at_the_unbound_role(self):
        """The other half. Here there ARE confirmed kWh registers; nobody has
        said which is the supply, and guessing from a tag would be an invention."""
        why = r._no_meter_reason([meta(A)])
        assert "energy_register" in why
        assert "Metric Roles" in why


class TestEpi:
    SITE = {"energy_tariff_per_kwh": None, "tariff_currency": None}

    def _ok(self, kwh, first, last):
        return [{"consumption_kwh": kwh, "first_bucket": first, "last_bucket": last}]

    def test_the_epi_annualises_from_the_days_actually_covered(self):
        """NOT from the window asked for. A 30-day request over 10 days of data
        must scale by 365/10 and say so; scaling by 365/30 would report a third
        of the real intensity as fact."""
        out = r._epi_from(self._ok(1000.0, at(1), at(11)), 100, self.SITE)
        assert out["epi"]["days_covered"] == pytest.approx(10.0)
        assert out["epi"]["annualised_kwh"] == pytest.approx(36500.0)
        assert out["epi"]["epi_kwh_per_sqm_year"] == pytest.approx(365.0)

    def test_the_formula_shows_the_arithmetic_that_produced_the_number(self):
        """An EPI with no working shown cannot be checked, and this one is graded
        against a national benchmark."""
        out = r._epi_from(self._ok(1000.0, at(1), at(11)), 100, self.SITE)
        assert "365" in out["epi"]["formula"]
        assert "kWh/m²/yr" in out["epi"]["formula"]

    def test_a_span_shorter_than_one_bucket_is_blocked_rather_than_extrapolated(self):
        """`365 / 0` is not the problem; `365 / 0.001` is. Annualising a few
        minutes produces an enormous confident number."""
        out = r._epi_from(self._ok(5.0, at(1), at(1)), 100, self.SITE)
        assert out["epi"] is None
        assert out["cost"] is None
        assert out["blocked"], "nothing was blocked, so nothing says why"
        assert "annualise" in out["blocked"][0]

    def test_the_cost_is_priced_on_what_was_MEASURED_not_on_the_annualised_figure(self):
        """The annualised kWh is an extrapolation. Charging for it would present
        a projection as a bill."""
        site = {"energy_tariff_per_kwh": 8.5, "tariff_currency": "INR"}
        out = r._epi_from(self._ok(1000.0, at(1), at(11)), 100, site)
        assert out["cost"]["amount"] == pytest.approx(8500.0)
        assert out["cost"]["currency"] == "INR"

    def test_no_tariff_means_no_cost_rather_than_a_zero(self):
        """A cost of 0 reads as free. Absence renders as absence."""
        out = r._epi_from(self._ok(1000.0, at(1), at(11)), 100, self.SITE)
        assert out["cost"] is None

    def test_a_currency_with_no_rate_prices_nothing(self):
        """Half a tariff is not a tariff, and multiplying by a missing rate would
        quietly be a multiplication by zero."""
        out = r._epi_from(self._ok(1000.0, at(1), at(11)), 100,
                          {"energy_tariff_per_kwh": None, "tariff_currency": "INR"})
        assert out["cost"] is None

    def test_a_meter_reporting_no_consumption_contributes_nothing_and_does_not_throw(self):
        """A NULL `consumption_kwh` is a register that did not move. It is a
        legitimate zero contribution, not a crash and not a dropped meter."""
        ok = [{"consumption_kwh": None, "first_bucket": at(1), "last_bucket": at(11)},
              {"consumption_kwh": 500.0, "first_bucket": at(2), "last_bucket": at(11)}]
        out = r._epi_from(ok, 100, self.SITE)
        assert out["epi"]["measured_kwh"] == pytest.approx(500.0)


class TestBenchmarkBand:
    GRADED = {"band": "5-star", "reason": "graded"}

    def test_a_rating_whose_every_register_is_frozen_is_not_graded(self):
        """An EPI of 0.0 built on stuck meters falls in the BEST band. Five stars
        for a dead meter is the confident-garbage shape this platform refuses."""
        out = r._withhold_band_if_frozen([{"status": "register_frozen"}], self.GRADED)
        assert out["band"] is None
        assert "frozen" in out["reason"]

    def test_a_single_moving_register_is_enough_to_keep_the_grade(self):
        """The negative case. Withholding a band because ONE of six meters is
        stuck would make the screen useless on any real estate."""
        meters = [{"status": "register_frozen"}, {"status": "ok"}]
        assert r._withhold_band_if_frozen(meters, self.GRADED)["band"] == "5-star"

    def test_a_rating_that_was_never_graded_is_left_exactly_as_it_was(self):
        """There is no band to withhold, and overwriting the existing reason
        would replace the real blocker with a frozen-register message."""
        bench = {"band": None, "reason": "no climate zone set"}
        assert r._withhold_band_if_frozen([{"status": "register_frozen"}], bench) == bench

    def test_the_measurement_itself_is_never_withheld_with_the_band(self):
        """The EPI IS the measurement and each meter carries its own status
        beside it. Hiding it would leave the operator with no evidence of the
        problem the withheld band is about."""
        out = r._withhold_band_if_frozen([{"status": "no_data"}], {**self.GRADED, "epi": 12.3})
        assert out["epi"] == 12.3
        assert out["band"] is None


# ── dataset visibility ───────────────────────────────────────────────────────


def _ds(permission: str) -> registry.Dataset:
    return registry.Dataset(
        key="k", name="n", permission=permission,
        definition={
            "relations": [{"key": "1h", "relation": "x", "time_column": "bucket"}],
            "measures": [{"key": "m", "label": "M", "aggregates": ["sum"],
                          "physical": {"1h": {"sum": {"fn": "count_star"}}}}],
        },
    )


def _who(*perms, superadmin=False) -> Principal:
    return Principal(user_id=uuid.uuid4(), tenant_id=uuid.uuid4(),
                     is_superadmin=superadmin, permissions=list(perms))


class TestDatasetVisibility:
    def test_a_dataset_is_gated_on_ITS_OWN_permission_and_not_on_bi_read(self):
        """The point of the registry: a domain registers a dataset with its own
        key. Gating everything on `bi.read` would hand a BI reader every dataset
        any domain ever inserts, including ones that have not shipped yet."""
        assert r._allowed(_who("vms.read"), _ds("vms.read")) is True
        assert r._allowed(_who("bi.read"), _ds("vms.read")) is False

    def test_a_wildcard_admin_sees_everything(self):
        assert r._allowed(_who(superadmin=True), _ds("vms.read")) is True


# ── over the wire: what /bi/correlation actually hands back ──────────────────
#
# The helpers above are pure and are the whole decision. These drive the ROUTE,
# because two things only the handler does are worth pinning: it resolves labels
# BEFORE reading any measurement (which is how a point belonging to another
# tenant is dropped), and it assembles a response whose refusals survive being
# serialised. A `status` field that the response model quietly dropped would turn
# every refusal into a blank cell.

pytestmark_http = pytest.mark.asyncio


def _scatter_row(i: int) -> dict:
    return {"t": at(1, i % 24), "a": float(i), "b": float(i) * 2}


@pytest.fixture
def scripted(monkeypatch):
    """Script the four statements `/bi/correlation` issues, so the route runs
    with no database. Anything it asks for that a test did not script comes back
    empty rather than raising, because what is under test is the ASSEMBLY."""

    state: dict = {"meta": {}, "stats": {}, "pairs": [], "scatter": [], "asked": []}

    async def point_meta(db, tenant, ids):
        state["asked"].append(("point_meta", tenant, list(ids)))
        return state["meta"]

    async def correlation_stats(db, tenant, **kw):
        state["asked"].append(("stats", tenant, kw))
        return state["stats"]

    async def correlation_pairs(db, tenant, **kw):
        state["asked"].append(("pairs", tenant, kw))
        return state["pairs"]

    async def correlation_scatter(db, tenant, **kw):
        state["asked"].append(("scatter", tenant, kw))
        return state["scatter"]

    monkeypatch.setattr(q, "point_meta", point_meta)
    monkeypatch.setattr(q, "correlation_stats", correlation_stats)
    monkeypatch.setattr(q, "correlation_pairs", correlation_pairs)
    monkeypatch.setattr(q, "correlation_scatter", correlation_scatter)
    return state


TENANT = uuid.uuid4()


def _url(*ids, **params) -> str:
    from conftest import PREFIX

    qs = "&".join([f"point_id={p}" for p in ids] + [f"{k}={v}" for k, v in params.items()])
    return f"{PREFIX}/bi/correlation?{qs}"


@pytest.mark.asyncio
class TestCorrelationOverTheWire:
    async def test_a_refusal_reaches_the_caller_with_its_status_and_its_reason(self, app, scripted):
        """The response model has to carry `status`, `r=null` and `reason`
        through. A model that dropped any of the three would render an undefined
        coefficient as an empty cell indistinguishable from a loading state."""
        from conftest import auth, client

        scripted["meta"] = {A: meta(A, point="OWT"), B: meta(B, point="IWT")}
        scripted["stats"] = {A: stats(n=40, distinct=1), B: stats()}
        scripted["pairs"] = [{"a_id": A, "b_id": B, "n": 40, "r": None,
                              "overlap_start": at(1), "overlap_end": at(2)}]
        async with client(app) as c:
            resp = await c.get(_url(A, B), headers=auth(tenant_id=TENANT, permissions=["bi.read"]))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        (pair,) = body["pairs"]
        assert pair["status"] == "undefined_frozen"
        assert pair["r"] is None
        assert "not a correlation of zero" in pair["reason"]
        assert body["series"][0]["frozen"] is True

    async def test_labels_are_resolved_before_any_measurement_is_read(self, app, scripted):
        """That ordering IS the tenant check: a point whose label does not come
        back is not this caller's, and it must be dropped before a single reading
        is touched. Reading first and filtering after would mean the measurements
        were fetched regardless."""
        from conftest import auth, client

        scripted["meta"] = {}          # neither point belongs to this caller
        async with client(app) as c:
            resp = await c.get(_url(A, B), headers=auth(tenant_id=TENANT, permissions=["bi.read"]))
        assert resp.status_code == 422
        assert [step[0] for step in scripted["asked"]] == ["point_meta"]

    async def test_a_point_belonging_to_another_tenant_is_dropped_not_refused(self, app, scripted):
        """Refusing by name would confirm the id exists. Dropping it and then
        failing the two-point minimum tells the caller nothing about the estate
        next door."""
        from conftest import auth, client

        scripted["meta"] = {A: meta(A)}      # B resolved to nothing
        async with client(app) as c:
            resp = await c.get(_url(A, B), headers=auth(tenant_id=TENANT, permissions=["bi.read"]))
        assert resp.status_code == 422
        assert str(B) not in resp.text

    async def test_the_tenant_the_queries_run_under_is_the_tokens(self, app, scripted):
        """Not a parameter. Every one of the four statements has to be given the
        JWT's tenant, or one of them reads across the whole platform."""
        from conftest import auth, client

        scripted["meta"] = {A: meta(A), B: meta(B)}
        async with client(app) as c:
            await c.get(_url(A, B), headers=auth(tenant_id=TENANT, permissions=["bi.read"]))
        assert scripted["asked"]
        assert all(step[1] == TENANT for step in scripted["asked"])

    async def test_the_scatter_is_only_fetched_for_exactly_two_series(self, app, scripted):
        """A scatter of three series has no axes. Fetching it anyway would be up
        to 2,000 rows read and thrown away on every wide correlation."""
        from conftest import auth, client

        scripted["meta"] = {A: meta(A), B: meta(B), C: meta(C)}
        async with client(app) as c:
            resp = await c.get(_url(A, B, C), headers=auth(tenant_id=TENANT, permissions=["bi.read"]))
        assert resp.status_code == 200
        assert "scatter" not in [step[0] for step in scripted["asked"]]
        assert resp.json()["samples"] == []

    async def test_a_full_scatter_is_flagged_as_truncated(self, app, scripted):
        """Un-flagged, a browser draws a capped sample as if it were the whole
        window, and the visible cloud stops where the cap fell."""
        from conftest import auth, client

        scripted["meta"] = {A: meta(A), B: meta(B)}
        scripted["scatter"] = [_scatter_row(i) for i in range(q.MAX_SCATTER_SAMPLES)]
        async with client(app) as c:
            resp = await c.get(_url(A, B), headers=auth(tenant_id=TENANT, permissions=["bi.read"]))
        assert resp.json()["samples_truncated"] is True

    async def test_a_short_scatter_is_not_flagged(self, app, scripted):
        from conftest import auth, client

        scripted["meta"] = {A: meta(A), B: meta(B)}
        scripted["scatter"] = [_scatter_row(i) for i in range(5)]
        async with client(app) as c:
            resp = await c.get(_url(A, B), headers=auth(tenant_id=TENANT, permissions=["bi.read"]))
        body = resp.json()
        assert body["samples_truncated"] is False
        assert len(body["samples"]) == 5

    async def test_the_response_says_which_store_answered_and_why(self, app, scripted):
        """A caller reading a live number off the 1-minute rollup has to be told
        its newest couple of minutes may be missing."""
        from conftest import auth, client

        scripted["meta"] = {A: meta(A), B: meta(B)}
        async with client(app) as c:
            resp = await c.get(_url(A, B, resolution="1m"),
                               headers=auth(tenant_id=TENANT, permissions=["bi.read"]))
        body = resp.json()
        assert body["resolution"] == "1m"
        assert "materialized-only" in body["resolution_reason"]
        assert body["min_buckets"] == q.MIN_CORRELATION_BUCKETS

    async def test_raw_is_refused_over_the_wire_and_reads_nothing(self, app, scripted):
        """The refusal has to happen before the queries, or asking for raw costs
        a full scan of the hypertable on the way to a 400."""
        from conftest import auth, client

        async with client(app) as c:
            resp = await c.get(_url(A, B, resolution="raw"),
                               headers=auth(tenant_id=TENANT, permissions=["bi.read"]))
        assert resp.status_code == 422
        assert scripted["asked"] == []
