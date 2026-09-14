"""The Portfolio leaderboard: every row present, and every blank explained.

WHY THIS FILE EXISTS. `queries.sites_breakdown` assembles one row per site out
of four independent queries, and the failure mode is never an error — it is a
row quietly missing, or a slot quietly filled in.

  * A site the point store knows but the mirror does not still has to appear, or
    real devices vanish from the estate view with nothing saying so.
  * The UNPLACED pseudo-row is a fact ("121 points no site owns"), not clutter,
    and it is the one row that is not a site — so it must not acquire a score or
    a placement.
  * `kwh` is BLOCKED until an operator has confirmed kWh registers. Rendering 0
    would be a measurement nobody made, and this deployment is in exactly that
    state today.
  * A CCEI refusal rides along WHOLE — status, reason and every component — so
    the screen can explain itself input by input. Nothing here rounds a refusal
    into a number.

The database is scripted per statement, matched on a fragment the module itself
wrote (the `metric_fakes` pattern), so a query this leaderboard should not have
run is a loud failure rather than an extra round trip. The metric evaluator and
the Ratings arithmetic are seams here, not subjects: they have their own tests
and both need Postgres to assert honestly.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid

import pytest

from app.api import queries as q

UTC = dt.timezone.utc
TENANT = uuid.UUID("11111111-2222-3333-4444-555555555555")
SITE_A = uuid.UUID("aaaaaaaa-0000-0000-0000-00000000000a")
SITE_B = uuid.UUID("bbbbbbbb-0000-0000-0000-00000000000b")


def run(coro):
    return asyncio.run(coro)


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def all(self):
        return list(self._rows)


_FRAGMENTS = {
    "facts": "FROM site_facts f",
    "by_site": "AS kwh_points",
    "categories": "GROUP BY p.site_id, p.category",
    "alerts": "FROM iot_alerts a",
}


class ScriptedDb:
    """Rows per statement; anything unscripted is an AssertionError naming it."""

    def __init__(self, **script):
        unknown = set(script) - set(_FRAGMENTS)
        if unknown:
            raise AssertionError(f"no such scripted query: {sorted(unknown)}")
        self.script = script
        self.asked: list[str] = []

    async def execute(self, clause, params=None):
        sql = str(clause)
        for name, frag in _FRAGMENTS.items():
            if frag in sql:
                if name not in self.script:
                    raise AssertionError(
                        f"the leaderboard ran the `{name}` query, which this test "
                        f"did not script"
                    )
                self.asked.append(name)
                return _Result(self.script[name])
        raise AssertionError(f"unrecognised statement: {' '.join(sql.split())[:160]}")


def _by_site(site_id, **over) -> dict:
    row = {
        "site_id": site_id, "site_name": "from points", "devices": 3, "points": 12,
        "points_reporting": 11, "last_seen_at": dt.datetime(2026, 3, 1, tzinfo=UTC),
        "kwh_points": 0,
    }
    row.update(over)
    return row


def _fact(site_id, **over) -> dict:
    row = {"site_id": site_id, "site_name": "HQ", "is_active": True,
           "gross_floor_area_sqm": 1200.0, "city": "Bengaluru", "occupancy": 200}
    row.update(over)
    return row


@pytest.fixture
def no_metric(monkeypatch):
    """The CCEI seam, refusing. Every leaderboard test that is not ABOUT the
    score gets a stated refusal, so a score slot that acquired a number would
    have had to invent it here."""
    from app.metric_registry import evaluator as ev

    async def _refuse(db, tenant, key, **kw):
        raise ev.EvaluationError("no ccei definition is effective")

    monkeypatch.setattr(ev, "evaluate", _refuse)
    return ev


def _breakdown(db) -> list[dict]:
    params = {"tenant": str(TENANT), "fresh": 15, "retire_days": 30}
    nofresh = {"tenant": str(TENANT), "retire_days": 30}
    return run(q.sites_breakdown(db, TENANT, params, nofresh))


# ── the kWh slot: blocked, no data, or measured — never a zero ───────────────


def test_a_site_with_no_confirmed_register_is_blocked_and_says_what_to_confirm():
    """ZERO confirmed registers is the state this deployment is in. Rendering it
    as `0 kWh` would be a measurement nobody made, sitting on a leaderboard
    beside sites that really did measure zero."""
    out = q._site_kwh(0, None)
    assert out["status"] == "blocked"
    assert out["consumption_kwh"] is None
    assert "Ratings" in out["reason"]


def test_a_site_with_registers_but_no_usable_delta_is_no_data_and_distinguishes_itself():
    """`blocked` is a config job and `no_data` is a field job. Collapsing them
    into one blank sends the operator to the wrong screen."""
    out = q._site_kwh(3, None)
    assert out["status"] == "no_data"
    assert out["confirmed_points"] == 3
    assert out["consumption_kwh"] is None


def test_a_measured_figure_states_its_window_its_register_count_and_its_caveat():
    """A sum over every confirmed register can double-count an incomer against
    its own sub-meters. The number is still worth showing; shipping it without
    that sentence is what makes it a claim instead of an estimate."""
    out = q._site_kwh(2, 418.5)
    assert out["status"] == "measured"
    assert out["consumption_kwh"] == 418.5
    assert out["window_hours"] == q.SITE_ALERT_HOURS
    assert "double-count" in out["reason"]


def test_a_measured_zero_is_reported_as_measured_and_not_as_missing():
    """A building that genuinely drew nothing — a site shut for the window — is
    a measurement. Treating 0.0 as absence would erase it."""
    assert q._site_kwh(1, 0.0)["status"] == "measured"


# ── grouping the supporting queries ──────────────────────────────────────────


def test_categories_are_grouped_under_their_own_site_including_the_unplaced_one():
    out = q._categories_by_site([
        {"site_id": SITE_A, "category": "energy", "devices": 2, "points": 9},
        {"site_id": SITE_A, "category": "hvac", "devices": 1, "points": 3},
        {"site_id": None, "category": "energy", "devices": 4, "points": 40},
    ])
    assert [c["category"] for c in out[SITE_A]] == ["energy", "hvac"]
    assert out[None][0]["points"] == 40


def test_alert_counts_keep_their_severity_split_as_well_as_the_total():
    """The chip shows a total and the queue filters by severity. Deriving one
    from the other later means two screens disagreeing about the same 24h."""
    out = q._alerts_by_site([
        {"site_id": SITE_A, "severity": "critical", "alerts": 2},
        {"site_id": SITE_A, "severity": "warning", "alerts": 5},
    ])
    assert out[SITE_A] == {"total": 7, "by_severity": {"critical": 2, "warning": 5}}


def test_an_alert_with_no_severity_is_counted_under_unknown_and_not_dropped():
    """An alert nobody classified is still an alert. Dropping it makes the chip
    disagree with the queue, and the queue is the one somebody acts on."""
    out = q._alerts_by_site([{"site_id": SITE_A, "severity": None, "alerts": 3}])
    assert out[SITE_A]["by_severity"] == {"unknown": 3}
    assert out[SITE_A]["total"] == 3


# ── one row, with every slot the screen reads ────────────────────────────────


def test_a_row_carries_every_slot_even_when_the_mirror_knows_nothing():
    """The screen reads slots, not keys it might not find. A missing key is a
    frontend crash; a NULL renders as "—" with its reason."""
    row = q._site_row(SITE_A, None, {}, {}, {})
    assert set(row) >= {
        "site_id", "site_name", "placed", "is_active", "gross_floor_area_sqm",
        "city", "occupancy", "devices", "points", "points_reporting",
        "last_seen_at", "categories", "alerts", "score", "score_reason",
        "score_detail", "kwh",
    }
    assert row["devices"] == 0 and row["points"] == 0
    assert row["score"] is None and row["score_reason"] is None


def test_the_mirrors_site_name_wins_over_the_one_denormalised_onto_points():
    """Core owns the name. `points.site_name` is a copy taken when the device
    was placed, so a renamed site would keep showing its old name here."""
    row = q._site_row(SITE_A, _fact(SITE_A, site_name="HQ"),
                      {SITE_A: _by_site(SITE_A, site_name="stale")}, {}, {})
    assert row["site_name"] == "HQ"


def test_a_site_the_mirror_has_not_named_falls_back_to_what_the_points_say():
    row = q._site_row(SITE_A, None, {SITE_A: _by_site(SITE_A, site_name="from points")}, {}, {})
    assert row["site_name"] == "from points"


def test_the_unplaced_pseudo_row_is_marked_unplaced():
    assert q._site_row(None, None, {}, {}, {})["placed"] is False
    assert q._site_row(SITE_A, None, {}, {}, {})["placed"] is True


# ── the whole leaderboard ────────────────────────────────────────────────────


def test_every_mirrored_site_appears_even_with_nothing_placed_there(no_metric):
    """A site exists on the leaderboard because core published it. Building the
    list from the POINTS instead would hide a building nobody has wired yet —
    which is precisely the one somebody needs to see."""
    db = ScriptedDb(facts=[_fact(SITE_A), _fact(SITE_B)], by_site=[], categories=[], alerts=[])
    out = _breakdown(db)
    assert [r["site_id"] for r in out] == [SITE_A, SITE_B]
    assert all(r["points"] == 0 for r in out)


def test_a_site_the_points_know_but_the_mirror_does_not_is_still_listed(no_metric):
    """Should not happen — placement writes come from core, which also feeds the
    mirror. A row silently dropped here would hide real, reporting devices."""
    db = ScriptedDb(facts=[], by_site=[_by_site(SITE_A, points=12)], categories=[], alerts=[])
    out = _breakdown(db)
    assert [r["site_id"] for r in out] == [SITE_A]
    assert out[0]["points"] == 12 and out[0]["is_active"] is None


def test_the_unplaced_points_are_reported_as_their_own_last_row(no_metric):
    """"121 points no site owns" is a fact. Folding them into a site would
    misstate both; leaving them out would make the totals not add up."""
    db = ScriptedDb(
        facts=[_fact(SITE_A)],
        by_site=[_by_site(SITE_A), _by_site(None, points=121)],
        categories=[], alerts=[],
    )
    out = _breakdown(db)
    assert [r["site_id"] for r in out] == [SITE_A, None]
    assert out[-1]["points"] == 121 and out[-1]["placed"] is False


def test_an_empty_unplaced_bucket_is_not_shown_as_a_row(no_metric):
    db = ScriptedDb(
        facts=[_fact(SITE_A)],
        by_site=[_by_site(SITE_A), _by_site(None, points=0)],
        categories=[], alerts=[],
    )
    assert [r["site_id"] for r in _breakdown(db)] == [SITE_A]


def test_the_unplaced_row_says_why_it_has_no_score_instead_of_leaving_it_blank(no_metric):
    """A score is a site's. The row still needs a sentence, or the screen shows
    a dash that looks like a failure of the scoring."""
    db = ScriptedDb(facts=[], by_site=[_by_site(None, points=5)], categories=[], alerts=[])
    out = _breakdown(db)
    assert out[0]["score"] is None
    assert "belong to no site" in out[0]["score_reason"]


def test_the_unplaced_row_never_asks_the_metric_registry_for_a_score(monkeypatch):
    """Evaluating `ccei` for site NULL is a question with no subject. The seam
    raises if it is called, which is the assertion."""
    from app.metric_registry import evaluator as ev

    async def _never(*a, **kw):
        raise AssertionError("the leaderboard evaluated a score for the unplaced row")

    monkeypatch.setattr(ev, "evaluate", _never)
    db = ScriptedDb(facts=[], by_site=[_by_site(None, points=5)], categories=[], alerts=[])
    assert _breakdown(db)[0]["score"] is None


def test_no_consumption_is_measured_for_a_site_with_no_confirmed_register(monkeypatch):
    """`_site_consumption` is the expensive half — it reads the hourly rollup
    over every candidate meter. Running it for a site with nothing confirmed
    would cost a query per site to produce a blocked slot anyway."""
    from app.api import rating as rt

    async def _never(*a, **kw):
        raise AssertionError("candidate meters were read for an unconfirmed site")

    monkeypatch.setattr(rt, "candidate_meters", _never)
    from app.metric_registry import evaluator as ev
    monkeypatch.setattr(ev, "evaluate", _refusing_evaluate)

    db = ScriptedDb(facts=[_fact(SITE_A)], by_site=[_by_site(SITE_A, kwh_points=0)],
                    categories=[], alerts=[])
    assert _breakdown(db)[0]["kwh"]["status"] == "blocked"


async def _refusing_evaluate(db, tenant, key, **kw):
    from app.metric_registry import evaluator as ev

    raise ev.EvaluationError("no ccei definition is effective")


def test_a_site_with_confirmed_registers_reports_the_measured_figure(monkeypatch):
    from app.api import rating as rt
    from app.metric_registry import evaluator as ev

    async def _meters(db, tenant, site_id):
        return [{"point_id": "p1"}, {"point_id": "p2"}]

    async def _registers(db, tenant, *, point_ids, start, end):
        return {"p1": object(), "p2": object()}

    def _meter_row(meter, reg):
        # One register usable, one not — the sum must be of the usable ones only.
        if meter["point_id"] == "p1":
            return {"status": "ok", "consumption_kwh": 120.0}
        return {"status": "decreasing", "consumption_kwh": None}

    monkeypatch.setattr(rt, "candidate_meters", _meters)
    monkeypatch.setattr(rt, "registers", _registers)
    monkeypatch.setattr(rt, "meter_row", _meter_row)
    monkeypatch.setattr(ev, "evaluate", _refusing_evaluate)

    db = ScriptedDb(facts=[_fact(SITE_A)], by_site=[_by_site(SITE_A, kwh_points=2)],
                    categories=[], alerts=[])
    kwh = _breakdown(db)[0]["kwh"]
    assert kwh["status"] == "measured"
    assert kwh["consumption_kwh"] == 120.0


def test_a_site_whose_every_register_is_unusable_reports_no_data_and_not_zero(monkeypatch):
    """Summing nothing gives 0.0 in python and "the building used no energy" on
    a screen. `_site_consumption` returns None instead, and that is the whole
    difference."""
    from app.api import rating as rt
    from app.metric_registry import evaluator as ev

    async def _meters(db, tenant, site_id):
        return [{"point_id": "p1"}]

    async def _registers(db, tenant, **kw):
        return {}

    monkeypatch.setattr(rt, "candidate_meters", _meters)
    monkeypatch.setattr(rt, "registers", _registers)
    monkeypatch.setattr(rt, "meter_row", lambda m, r: {"status": "decreasing",
                                                       "consumption_kwh": None})
    monkeypatch.setattr(ev, "evaluate", _refusing_evaluate)

    db = ScriptedDb(facts=[_fact(SITE_A)], by_site=[_by_site(SITE_A, kwh_points=1)],
                    categories=[], alerts=[])
    kwh = _breakdown(db)[0]["kwh"]
    assert kwh["status"] == "no_data" and kwh["consumption_kwh"] is None


# ── the score slot relays the registry, and never rounds it ──────────────────


def _ev(status, **item):
    async def _run(db, tenant, key, **kw):
        return {
            "metric": "ccei", "version": 3,
            "items": [{"status": status, **item}],
        }

    return _run


def test_a_scored_site_carries_the_number_and_the_arithmetic_that_produced_it(monkeypatch):
    from app.metric_registry import evaluator as ev

    monkeypatch.setattr(
        ev, "evaluate",
        _ev("ok", value=72.5, arithmetic="0.4 × a(80) + 0.6 × b(67.5) = 72.5",
            components=[{"metric": "a"}]),
    )
    db = ScriptedDb(facts=[_fact(SITE_A)], by_site=[], categories=[], alerts=[])
    row = _breakdown(db)[0]
    assert row["score"] == 72.5
    assert "0.4 × a(80)" in row["score_reason"]
    assert row["score_detail"]["version"] == 3
    assert row["score_detail"]["status"] == "ok"


def test_a_refused_score_stays_none_and_carries_every_component_that_refused(monkeypatch):
    """The screen renders a dash it can explain input by input. Rounding this to
    a number — or to a bare "no score" — is how a building with two missing
    sensors ends up indistinguishable from one with none."""
    from app.metric_registry import evaluator as ev

    monkeypatch.setattr(
        ev, "evaluate",
        _ev("blocked", value=None, reason="2 of 3 component(s) did not evaluate",
            components=[{"metric": "epi", "status": "missing_role"}]),
    )
    db = ScriptedDb(facts=[_fact(SITE_A)], by_site=[], categories=[], alerts=[])
    row = _breakdown(db)[0]
    assert row["score"] is None
    assert "blocked" in row["score_reason"]
    assert row["score_detail"]["components"][0]["metric"] == "epi"


def test_a_site_the_evaluator_returns_no_item_for_says_so_rather_than_scoring_zero(
    monkeypatch,
):
    from app.metric_registry import evaluator as ev

    async def _empty(db, tenant, key, **kw):
        return {"metric": "ccei", "version": 3, "items": []}

    monkeypatch.setattr(ev, "evaluate", _empty)
    db = ScriptedDb(facts=[_fact(SITE_A)], by_site=[], categories=[], alerts=[])
    row = _breakdown(db)[0]
    assert row["score"] is None
    assert "reporting mirror" in row["score_reason"]


def test_no_ccei_definition_at_all_is_a_stated_reason_and_not_a_failed_request(
    no_metric,
):
    """One undefined metric must not 500 the whole leaderboard: every other
    figure on it is still true."""
    db = ScriptedDb(facts=[_fact(SITE_A), _fact(SITE_B)], by_site=[], categories=[],
                    alerts=[])
    out = _breakdown(db)
    assert len(out) == 2
    assert all(r["score"] is None and r["score_reason"].startswith("no score:") for r in out)
