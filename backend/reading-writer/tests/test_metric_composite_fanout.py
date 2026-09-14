"""Fanning a metric out over sites and devices, and composing what comes back.

WHY THIS FILE EXISTS. `test_metric_evaluator_refusals` covers the vocabulary —
each reason, distinguishable. This covers the SHAPE that carries it: `evaluate`
asks a metric of a whole estate, and every layer between the request and a leaf
refusal is a place the refusal can be lost.

The rules being protected, all of them "a refusal beats a number":

  * **A composite of a refusal is a refusal.** A weighted sum that skipped the
    components that did not evaluate would still produce a number, on a smaller
    denominator, with nothing saying so — a building missing two sensors would
    score like one missing none.
  * **Every component's own status rides along.** The dash the screen renders
    has to explain itself input by input, so the parts survive even when the
    whole refuses.
  * **One bad leaf does not fail the request.** A component named ahead of its
    metric is how a pack normally grows; the composite says which part is
    missing rather than 500-ing the portfolio.
  * **A site is asked for by id or not at all.** Asking for a site that is not
    in this tenant's mirror is an error, never an empty success that reads as
    "this building has no data".

The database is `metric_fakes`' scripted session, extended with per-KEY
definitions so a nested `evaluate` cannot be answered with its parent's row. A
query no test scripted is a loud failure, which is what makes "it read the
readings before it had bound a role" visible.
"""

from __future__ import annotations

import uuid

import pytest
from metric_fakes import FRAGMENTS, agg, at, pid, point, run

from app.metric_registry import evaluator as ev

SITE_A = uuid.UUID("aaaaaaaa-0000-0000-0000-00000000000a")
SITE_B = uuid.UUID("bbbbbbbb-0000-0000-0000-00000000000b")
DEV_1 = uuid.UUID("dddddddd-0000-0000-0000-000000000001")
DEV_2 = uuid.UUID("dddddddd-0000-0000-0000-000000000002")


class MetricDb:
    """The scripted session, with `definitions` keyed by the metric asked for.

    `metric_fakes.FakeDb` answers every definition lookup with one row set,
    which is fine for a single metric and wrong for a composite: the nested
    `evaluate` for each component would be handed its PARENT's definition and
    recurse. Keying on `:key` is what makes a composite testable at all — and a
    component this test did not define comes back as absent, which is the
    `not_defined` state rather than an accident.
    """

    def __init__(self, *, definitions=None, **script):
        unknown = set(script) - set(FRAGMENTS)
        if unknown:
            raise AssertionError(f"no such scripted query: {sorted(unknown)}")
        self.definitions = definitions or {}
        self.script = script
        self.asked: list[str] = []

    # `devices` FIRST: a device discovery scoped to a site carries
    # `p.site_id = CAST(:site AS uuid)`, which is also the `site_roles`
    # fragment — so a plain dict walk matches the wrong statement and the
    # scripted rows for one query answer another.
    _ORDER = ["devices"] + [k for k in FRAGMENTS if k != "devices"]

    async def execute(self, clause, params=None):
        sql = str(clause)
        for name in self._ORDER:
            frag = FRAGMENTS[name]
            if frag not in sql:
                continue
            self.asked.append(name)
            if name == "definitions":
                defn = self.definitions.get(params["key"])
                return _Result([defn] if defn else [])
            if name not in self.script:
                raise AssertionError(
                    f"the evaluator ran the `{name}` query, which this test did "
                    f"not script — it should not have got that far"
                )
            rows = self.script[name]
            if name == "aggs":
                want = set(params["pids"])
                return _Result([r for r in rows if str(r["point_id"]) in want])
            return _Result(rows)
        raise AssertionError(f"unrecognised statement: {' '.join(sql.split())[:160]}")


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def all(self):
        return list(self._rows)


def _defn(key, **over) -> dict:
    body = {
        "key": key, "version": 1, "effective_from": at(1), "kind": "formula",
        "applies_to": {"scope": "device"},
        "inputs": {"kwh": {"role": "energy_total", "unit": "kWh"}},
        "formula": "kwh", "components": None, "output": {"unit": "kWh"},
        "guards": [], "display": None,
    }
    body.update(over)
    return body


def _site(site_id, name) -> dict:
    return {"site_id": site_id, "site_name": name,
            "gross_floor_area_sqm": 1000.0, "occupancy": 100}


# ── compose: the weighted sum, and the refusal that replaces it ──────────────


def test_a_composite_of_components_that_all_evaluated_is_their_weighted_sum():
    out = ev._compose(
        {"output": {"unit": "", "dimension": "dimensionless"}},
        [{"metric": "a", "weight": 0.4, "status": "ok", "value": 80.0},
         {"metric": "b", "weight": 0.6, "status": "ok", "value": 50.0}],
    )
    assert out["status"] == "ok"
    assert out["value"] == pytest.approx(62.0)
    assert out["arithmetic"] == "0.4 × a(80) + 0.6 × b(50) = 62"


def test_the_composite_shows_its_working_so_a_score_can_be_checked_by_hand():
    """A score with no arithmetic is a number an operator has to trust. The
    string is the audit trail, and it is the only one there is."""
    out = ev._compose({}, [{"metric": "epi", "weight": 1.0, "status": "ok", "value": 7.5}])
    assert "1 × epi(7.5) = 7.5" in out["arithmetic"]


def test_one_refused_component_refuses_the_whole_composite_and_names_it():
    """Skipping it and re-normalising the weights would produce a plausible
    score on a smaller denominator — a building missing two sensors scoring like
    one missing none, with nothing in the response saying so."""
    out = ev._compose(
        {},
        [{"metric": "a", "weight": 0.5, "status": "ok", "value": 80.0},
         {"metric": "b", "weight": 0.5, "status": "missing_role",
          "value": None, "reason": "no point is confirmed in role `co2`"}],
    )
    assert out["status"] == "blocked"
    assert out["value"] is None
    assert "1 of 2 component(s) did not evaluate" in out["reason"]
    assert "`b` missing_role: no point is confirmed in role `co2`" in out["reason"]


def test_a_refused_composite_still_carries_every_component_it_tried():
    """The screen renders a dash it can explain input by input. Dropping the
    parts leaves "blocked" and nowhere to go."""
    parts = [{"metric": "a", "weight": 1.0, "status": "no_data", "value": None,
              "reason": "absence is absence"}]
    assert ev._compose({}, parts)["components"] == parts


def test_a_composite_carries_the_unit_and_dimension_its_definition_declares():
    """Nothing here invents a unit; it repeats the one the definition states."""
    out = ev._compose(
        {"output": {"unit": "kWh/m²", "dimension": "energy_intensity"}},
        [{"metric": "a", "weight": 1.0, "status": "ok", "value": 1.0}],
    )
    assert out["unit"] == "kWh/m²"
    assert out["dimension"] == "energy_intensity"


# ── a device-scope component combined across a site's devices ────────────────


def test_a_site_with_no_applicable_device_refuses_rather_than_scoring_zero():
    """"No AHU at this site" is not "this site's AHUs are perfect". The mean of
    an empty list is the kind of zero that makes an unmonitored building look
    like the best one on the leaderboard."""
    out = ev._component_over_devices("ahu_efficiency", [])
    assert out["status"] == "missing_role"
    assert out["value"] is None
    assert "no applicable device at this site" in out["reason"]


def test_devices_that_all_evaluated_combine_as_their_arithmetic_mean():
    out = ev._component_over_devices(
        "x",
        [{"device_id": DEV_1, "device_tag": "AHU-1", "status": "ok", "value": 10.0},
         {"device_id": DEV_2, "device_tag": "AHU-2", "status": "ok", "value": 20.0}],
    )
    assert out["status"] == "ok"
    assert out["value"] == pytest.approx(15.0)
    assert "over 2 device(s)" in out["arithmetic"]


def test_one_refusing_device_refuses_the_component_and_names_every_one_of_them():
    """Averaging the devices that did work would silently answer about a subset
    of the building. The refusal names the tags so the field job is findable."""
    out = ev._component_over_devices(
        "x",
        [{"device_id": DEV_1, "device_tag": "AHU-1", "status": "ok", "value": 10.0},
         {"device_id": DEV_2, "device_tag": "AHU-2", "status": "no_data",
          "value": None, "reason": "no samples in the window"}],
    )
    assert out["status"] == "blocked"
    assert "1 of 2 device(s) refused" in out["reason"]
    assert "AHU-2 (no_data: no samples in the window)" in out["reason"]


def test_a_refusing_device_with_no_tag_is_named_by_its_id_rather_than_by_none():
    out = ev._component_over_devices(
        "x",
        [{"device_id": DEV_1, "device_tag": None, "status": "no_data",
          "value": None, "reason": "no samples"}],
    )
    assert str(DEV_1) in out["reason"]


# ── nesting has a floor ──────────────────────────────────────────────────────


def test_a_composite_nested_too_deep_is_refused_rather_than_recursing():
    """A pack can name itself, directly or in a cycle. Without the depth guard
    that is a recursion that ends the worker, not the request."""
    depth = ev._MAX_COMPOSITE_DEPTH
    device = run(ev._evaluate_composite(MetricDb(), None, {}, pid(1), at(1), at(2), "1h", depth))
    site = run(ev._evaluate_site_composite(
        MetricDb(), None, {}, _site(SITE_A, "HQ"), at(1), at(2), "1h", depth
    ))
    for out in (device, site):
        assert out["status"] == "blocked"
        assert f"deeper than {depth}" in out["reason"]


# ── the site fan-out ─────────────────────────────────────────────────────────


_SITE_COMPOSITE = _defn(
    "ccei",
    kind="composite",
    applies_to={"scope": "site"},
    components=[{"metric": "leaf", "weight": 1.0}],
    inputs=None,
    formula=None,
    display={"components": {"leaf": {"label": "Leaf metric",
                                     "blocked_by": "no sensor is installed",
                                     "source": "spec §3"}}},
)


def test_a_metric_asked_of_the_whole_portfolio_returns_one_item_per_site():
    """One request, one row per building. Returning the first site's answer for
    the estate is the shape of bug that reads as "all our sites score 41"."""
    db = MetricDb(
        definitions={"ccei": _SITE_COMPOSITE},
        sites=[_site(SITE_A, "HQ"), _site(SITE_B, "Annexe")],
    )
    out = run(ev.evaluate(db, None, "ccei", start=at(1), end=at(2)))
    assert [i["site_id"] for i in out["items"]] == [str(SITE_A), str(SITE_B)]
    assert [i["site_name"] for i in out["items"]] == ["HQ", "Annexe"]


def test_each_site_carries_its_own_outcome_rather_than_a_shared_one():
    """Every item is evaluated independently, so one building's missing sensor
    must not blank the building next door."""
    db = MetricDb(definitions={"ccei": _SITE_COMPOSITE},
                  sites=[_site(SITE_A, "HQ"), _site(SITE_B, "Annexe")])
    items = run(ev.evaluate(db, None, "ccei", start=at(1), end=at(2)))["items"]
    assert all(i["status"] == "blocked" for i in items)
    assert all(i["components"][0]["status"] == "not_defined" for i in items)


def test_a_component_named_but_not_defined_is_reported_with_the_packs_own_sentence():
    """"no metric `leaf` is effective" is true and useless. When the pack
    documents the component, the operator learns whether the gap is a field job,
    a config job or a build job — and those need three different people."""
    db = MetricDb(definitions={"ccei": _SITE_COMPOSITE}, sites=[_site(SITE_A, "HQ")])
    part = run(ev.evaluate(db, None, "ccei", start=at(1), end=at(2)))["items"][0]["components"][0]
    assert part["status"] == "not_defined"
    assert part["reason"] == (
        "Leaf metric is not defined — no sensor is installed (source: spec §3)"
    )


def test_asking_for_a_site_that_is_not_in_this_tenants_mirror_is_an_error():
    """An empty success would render as "this building has no data", which is a
    statement about a building that is not this tenant's to make."""
    db = MetricDb(definitions={"ccei": _SITE_COMPOSITE}, sites=[])
    asking = ev.evaluate(db, None, "ccei", site_id=SITE_A, start=at(1), end=at(2))
    with pytest.raises(ev.EvaluationError, match="no such site"):
        run(asking)


def test_a_portfolio_with_no_sites_at_all_is_an_empty_item_list_not_an_error():
    """Nothing has been placed yet. That is a true and ordinary state of a new
    deployment, and it is not the same as asking for a site that does not
    exist."""
    db = MetricDb(definitions={"ccei": _SITE_COMPOSITE}, sites=[])
    assert run(ev.evaluate(db, None, "ccei", start=at(1), end=at(2)))["items"] == []


# ── the device fan-out ───────────────────────────────────────────────────────


_DEVICE_METRIC = _defn("epi", applies_to={"scope": "device", "category": "hvac"})


def test_a_named_device_is_evaluated_without_discovering_the_estate():
    """The caller already said which device. Running the discovery query anyway
    costs a scan per request — and the scripted session has no `devices` entry,
    so running it is the failure."""
    db = MetricDb(definitions={"epi": _DEVICE_METRIC}, device_roles=[])
    out = run(ev.evaluate(db, None, "epi", device_id=DEV_1, start=at(1), end=at(2)))
    assert "devices" not in db.asked
    assert [i["device_id"] for i in out["items"]] == [str(DEV_1)]
    assert out["items"][0]["status"] == "missing_role"


def test_with_no_device_named_every_applicable_device_gets_its_own_item():
    db = MetricDb(
        definitions={"epi": _DEVICE_METRIC},
        devices=[{"device_id": DEV_1, "device_tag": "AHU-1"},
                 {"device_id": DEV_2, "device_tag": "AHU-2"}],
        device_roles=[],
    )
    out = run(ev.evaluate(db, None, "epi", start=at(1), end=at(2)))
    assert [i["device_tag"] for i in out["items"]] == ["AHU-1", "AHU-2"]
    assert all(i["status"] == "missing_role" for i in out["items"])


def test_a_device_with_no_tag_still_gets_an_item_keyed_by_its_id():
    """A tag is optional on `points`. Keying the item on it would drop the
    device from the response entirely."""
    db = MetricDb(definitions={"epi": _DEVICE_METRIC},
                  devices=[{"device_id": DEV_1, "device_tag": None}], device_roles=[])
    item = run(ev.evaluate(db, None, "epi", start=at(1), end=at(2)))["items"][0]
    assert item["device_id"] == str(DEV_1)
    assert "device_tag" not in item


@pytest.mark.parametrize(
    "applies_to, expected",
    [
        ({}, {}),
        ({"category": "hvac"}, {"category": "hvac"}),
        ({"device_type": "ahu"}, {"device_type": "ahu"}),
        ({"category": "hvac", "device_type": "ahu"},
         {"category": "hvac", "device_type": "ahu"}),
    ],
)
def test_the_definitions_applies_to_narrows_which_devices_are_asked(applies_to, expected):
    """`applies_to` is the difference between "every AHU" and "every device in
    the building". A filter dropped here would evaluate a chiller metric against
    a door sensor and report `missing_role` for the whole estate."""
    seen = {}

    class Spy(MetricDb):
        async def execute(self, clause, params=None):
            if "SELECT DISTINCT p.device_id" in str(clause):
                seen.update(params)
            return await super().execute(clause, params)

    db = Spy(devices=[])
    run(ev._devices_for(db, None, applies_to))
    assert {k: v for k, v in seen.items() if k in ("category", "device_type")} == expected
    assert seen["limit"] == ev._MAX_DEVICES


def test_a_site_scope_narrows_the_device_discovery_to_that_site():
    """A device-scope metric asked of one site must not fan out over the estate
    and report another building's AHUs under this site's heading."""
    seen = {}

    class Spy(MetricDb):
        async def execute(self, clause, params=None):
            if "SELECT DISTINCT p.device_id" in str(clause):
                seen.update(params)
            return await super().execute(clause, params)

    run(ev._devices_for(Spy(devices=[]), None, {}, site_id=SITE_A))
    assert seen["site"] == str(SITE_A)


# ── the envelope every answer travels in ─────────────────────────────────────


def test_a_metric_nothing_defines_is_an_error_naming_the_key_and_the_instant():
    """Version selection is by the window's END, so "no `ccei` is effective"
    depends on WHEN — the instant has to be in the sentence or the operator
    cannot tell a missing metric from a historical window."""
    asking = ev.evaluate(MetricDb(), None, "ccei", start=at(1), end=at(2))
    with pytest.raises(ev.EvaluationError) as exc:
        run(asking)
    assert "`ccei`" in str(exc.value)
    assert at(2).isoformat() in str(exc.value)


def test_the_answer_states_the_version_the_window_and_the_rollup_it_read():
    """A number with no provenance cannot be reproduced. The version says which
    definition computed it, and the resolution says which table — two windows
    read at different grains give different answers to the same question."""
    db = MetricDb(definitions={"ccei": {**_SITE_COMPOSITE, "version": 7}},
                  sites=[_site(SITE_A, "HQ")])
    out = run(ev.evaluate(db, None, "ccei", start=at(1), end=at(1, 2)))
    assert out["metric"] == "ccei"
    assert out["version"] == 7
    assert out["kind"] == "composite"
    assert out["window"] == {"start": at(1), "end": at(1, 2)}
    assert out["resolution"] == "1m"
    assert "1-minute rollup" in out["resolution_reason"]


def test_a_wide_window_is_answered_from_the_hourly_rollup():
    db = MetricDb(definitions={"ccei": _SITE_COMPOSITE}, sites=[_site(SITE_A, "HQ")])
    out = run(ev.evaluate(db, None, "ccei", start=at(1), end=at(11)))
    assert out["resolution"] == "1h"


def test_a_definition_with_no_declared_scope_fans_out_over_devices():
    """`applies_to.scope` is optional and the historical default is `device`.
    Defaulting to `site` instead would silently answer a different question for
    every metric written before the site scope existed."""
    db = MetricDb(definitions={"epi": _defn("epi", applies_to={})},
                  devices=[], device_roles=[])
    out = run(ev.evaluate(db, None, "epi", start=at(1), end=at(2)))
    assert out["items"] == []
    assert "devices" in db.asked
    assert "sites" not in db.asked


# ── a leaf that actually computes, under a site composite ────────────────────


_LEAF_OK = _defn(
    "leaf",
    applies_to={"scope": "device"},
    inputs={"kwh": {"role": "energy_total", "unit": "kWh", "aggregation": "avg"}},
    formula="kwh",
)


def _site_parent(**over) -> dict:
    return _defn(
        "ccei", kind="composite", applies_to={"scope": "site"},
        components=[{"metric": "leaf", "weight": 1.0}],
        inputs=None, formula=None, output={"unit": "", "dimension": "dimensionless"},
        **over,
    )


def test_a_site_composite_over_a_device_leaf_reports_the_mean_and_every_device():
    """The whole path in one: site → component → device fan-out → bound role →
    rollup → mean → weighted sum. Each layer can drop the one below it without
    raising, and the only thing that notices is the number."""
    db = MetricDb(
        definitions={"ccei": _site_parent(), "leaf": _LEAF_OK},
        sites=[_site(SITE_A, "HQ")],
        devices=[{"device_id": DEV_1, "device_tag": "AHU-1"}],
        device_roles=[point(1, role="energy_total")],
        aggs=[agg(1, avg=42.0, samples=10)],
        buckets=[],
    )
    item = run(ev.evaluate(db, None, "ccei", site_id=SITE_A, start=at(1), end=at(2)))["items"][0]
    assert item["status"] == "ok"
    assert item["value"] == pytest.approx(42.0)
    part = item["components"][0]
    assert part["metric"] == "leaf"
    assert part["version"] == 1
    assert [d["device_tag"] for d in part["devices"]] == ["AHU-1"]


def test_a_site_composite_refuses_when_its_device_leaf_cannot_bind_a_role():
    """The refusal has to travel three layers up and still say which role, on
    which device, at which site."""
    db = MetricDb(
        definitions={"ccei": _site_parent(), "leaf": _LEAF_OK},
        sites=[_site(SITE_A, "HQ")],
        devices=[{"device_id": DEV_1, "device_tag": "AHU-1"}],
        device_roles=[],
    )
    item = run(ev.evaluate(db, None, "ccei", site_id=SITE_A, start=at(1), end=at(2)))["items"][0]
    assert item["status"] == "blocked"
    assert item["value"] is None
    assert "AHU-1" in item["components"][0]["reason"]
    assert "`energy_total`" in item["components"][0]["devices"][0]["reason"]


def test_a_site_with_no_applicable_device_blocks_the_composite_and_says_so():
    db = MetricDb(
        definitions={"ccei": _site_parent(), "leaf": _LEAF_OK},
        sites=[_site(SITE_A, "HQ")], devices=[],
    )
    item = run(ev.evaluate(db, None, "ccei", site_id=SITE_A, start=at(1), end=at(2)))["items"][0]
    assert item["status"] == "blocked"
    assert "no applicable device at this site" in item["components"][0]["reason"]


def test_the_nested_evaluation_reads_the_same_rollup_the_parent_chose():
    """A component read at a different grain from its parent is a composite of
    two different questions. The resolution is passed down, not re-derived."""
    reads: list[str] = []

    class Spy(MetricDb):
        async def execute(self, clause, params=None):
            sql = str(clause)
            if "AS agg_avg" in sql:
                reads.append("readings_1m" if "readings_1m" in sql else "readings_1h")
            return await super().execute(clause, params)

    db = Spy(
        definitions={"ccei": _site_parent(), "leaf": _LEAF_OK},
        sites=[_site(SITE_A, "HQ")],
        devices=[{"device_id": DEV_1, "device_tag": "AHU-1"}],
        device_roles=[point(1, role="energy_total")],
        aggs=[agg(1, avg=1.0)], buckets=[],
    )
    run(ev.evaluate(db, None, "ccei", site_id=SITE_A, start=at(1), end=at(1, 2)))
    assert reads == ["readings_1m"]
