"""Bulk unit confirmation by pattern — and the five things it must never do.

576 of this estate's 766 live points have no confirmed unit, and a number with no
unit cannot be summed, averaged or rated. The tags are extremely regular, so the
backlog is a pattern job. That is the easy half.

The hard half is that a unit IS meaning, and a bulk lever is the fastest possible
way to write meaning nobody asserted. Everything below is that half:

* a pattern PROPOSES; only a human confirms, and nothing is auto-applied;
* a pattern never overwrites a unit a human already confirmed;
* a pattern that matches a STATE (`OnOff STS`) or an AMBIGUITY (`KWL1_A`, which
  names power and ends in the amps suffix) proposes no unit AND cannot be
  applied — a fabricated unit on a boolean is the failure this product exists to
  avoid, and it does not announce itself, it just makes totals quietly wrong;
* `dry_run` writes nothing at all;
* everything is tenant-scoped, in the candidate read AND in the write.

The pure half of this suite calls `match_pattern`/`suggest` directly. The half
that needs a database uses `FakeDb`, which imitates exactly four statements and
fails loudly on a fifth — including, deliberately, the TENANT predicate: it
filters rows by `:tenant` only when the SQL it was handed actually contains the
predicate, so deleting that predicate from a query makes another tenant's rows
appear here rather than passing quietly.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid

import pytest

from app.api import units as un
from app.api.schemas import ConfirmUnitsRequest

from conftest import PREFIX, auth, client

UTC = dt.timezone.utc
T1 = uuid.UUID("11111111-1111-1111-1111-111111111111")
T2 = uuid.UUID("22222222-2222-2222-2222-222222222222")


def run(coro):
    """The house pattern (see test_metric_dataset.py): drive one coroutine."""
    return asyncio.run(coro)


# ── The catalogue, read against real tags off the live estate ────────────────
#
# Every tag below was taken from `neubit_reporting.points` on this deployment. A
# regex tested only against tags invented for the test is a regex tested against
# itself.

FAMILIES = [
    # (tag, pattern key, unit)
    ("1FYC1_IWT", "chilled_water_temp", "degC"),
    ("1FYC1_OWT", "chilled_water_temp", "degC"),
    ("4FKC2_IWT", "chilled_water_temp", "degC"),
    ("5FYorkChiller1_OWT", "chilled_water_temp", "degC"),
    ("1FYC1_AmbTemp", "ambient_temp", "degC"),
    ("2FYorkChiller1_AmbTemp", "ambient_temp", "degC"),
    ("4FSP1_Inv_Temp", "inverter_temp", "degC"),
    ("1FYC1_EM_kW", "active_power_kw", "kW"),
    ("1FYC1 EM - Total kW", "active_power_kw", "kW"),
    ("4FKC1_ EM _Total kW", "active_power_kw", "kW"),
    ("TOT KW", "active_power_kw", "kW"),
    ("4FSP1_Tot_DC_kW", "active_power_kw", "kW"),
    ("KW_L1", "active_power_phase_kw", "kW"),
    ("KWL3", "active_power_phase_kw", "kW"),
    ("1FYC1_EM_kVAh", "apparent_energy_kvah", "kVAh"),
    ("1FChiller1EM_kVAh", "apparent_energy_kvah", "kVAh"),
    ("KVAH", "apparent_energy_kvah", "kVAh"),
    ("1FYorkChiller1EM_kWh", "active_energy_kwh", "kWh"),
    ("KWH_kwh", "active_energy_kwh", "kWh"),
    ("TodayKWH", "active_energy_kwh", "kWh"),
    ("4FSP1_This_Year_KWH", "active_energy_kwh", "kWh"),
    ("TOTKVA_kva", "apparent_power_kva", "kVA"),
    ("4F_Incomer1_TOTkVA", "apparent_power_kva", "kVA"),
    ("1FYC1_Run Hours", "run_hours", "h"),
    ("Run Hours", "run_hours", "h"),
    ("1FYC1_SysLoad", "system_load_percent", "percent"),
    ("PF_pf", "power_factor", ""),
    ("4F_Incomer1_PF", "power_factor", ""),
    ("Freq_Hz", "frequency_hz", "Hz"),
    ("Hz", "frequency_hz", "Hz"),
    ("VoltL1_V", "voltage_v", "V"),
    ("4FSP1_DCVolt1_V", "voltage_v", "V"),
    ("CurrL1_A", "current_a", "A"),
    ("4F_Incomer1_CurrAvg_A", "current_a", "A"),
]


@pytest.mark.parametrize("tag,key,unit", FAMILIES)
def test_each_pattern_family_reads_the_estates_own_tags(tag, key, unit):
    got = un.match_pattern(tag, "num")
    assert got is not None, f"no pattern matched `{tag}`"
    assert got.key == key
    assert got.unit == unit
    assert got.kind == un.KIND_UNIT


def test_the_three_system_load_spellings_are_one_decision():
    # `SysLoad`, `Sys Load`, `SystemLoad` — one measurement on ONE chiller,
    # spelled three ways by the gateway. If matching is not robust to this, the
    # operator confirms the same thing three times and the third spelling is the
    # one that gets forgotten.
    for tag in ("1FYC1_SysLoad", "1FYC1_Sys Load", "2FYC1_SystemLoad", "SYS Load"):
        got = un.match_pattern(tag, "num")
        assert got is not None, f"no pattern matched `{tag}`"
        assert got.key == "system_load_percent", tag
        assert got.unit == "percent", tag


def test_a_bare_load_is_not_a_system_load():
    # The other half of the same rule, and the reason the regex is not `.*load$`.
    # A bare `Load` on an energy meter is as likely to be kW as a percentage.
    # Matching it would put `percent` on four points nobody asked about — which
    # is what "robust without becoming loose" has to mean in practice.
    assert un.match_pattern("Load", "num") is None


# ── Rule 3: a state is not a measurement ─────────────────────────────────────


@pytest.mark.parametrize(
    "tag",
    [
        "1FYC1_OnOff STS",
        "4FKC1_On Off STS",
        "On Off STS",
        "1FKC2_OnOff",
        "1FKhemChiller2EM_OnOff",
    ],
)
def test_a_state_tag_proposes_no_unit_at_all(tag):
    got = un.match_pattern(tag, "num")
    assert got is not None, f"the state pattern should still CLAIM `{tag}`"
    assert got.kind == un.KIND_STATE
    assert got.unit is None
    assert got.proposes_unit is False
    # And the per-point suggestion says so rather than going silent: "matched a
    # state" and "matched nothing" are different answers and the screen has to
    # be able to tell them apart.
    assert un.suggest(tag, "num")["unit"] is None


def test_run_hours_is_a_duration_and_on_off_beside_it_is_not():
    # These two tags sit two apart on the same chiller. `Run Hours` IS hours;
    # `OnOff STS` is not anything. Getting this pair wrong puts `h` on a boolean.
    assert un.match_pattern("1FYC1_Run Hours", "num").unit == "h"
    assert un.match_pattern("1FYC1_OnOff STS", "num").unit is None


def test_work_mode_is_an_enumeration_not_a_quantity():
    got = un.match_pattern("4FSP1_Work_Mode", "num")
    assert got.kind == un.KIND_STATE
    assert got.unit is None


# ── Rule 5: ambiguity says so and proposes nothing ───────────────────────────


@pytest.mark.parametrize(
    "tag,key",
    [
        # Named in volts, suffixed in amps — one half is a typo, and nothing
        # here gets to pick which.
        ("VoltAvg_A", "ambiguous_voltage_named_in_amps"),
        ("BpVoltL1_A", "ambiguous_voltage_named_in_amps"),
        # Named in current, suffixed in volts.
        ("CurrL1_V", "ambiguous_current_named_in_volts"),
        ("BattCurrL1_V", "ambiguous_current_named_in_volts"),
        # Named in kilowatts, suffixed in amps.
        ("KWL1_A", "ambiguous_power_named_in_amps"),
        # Neither `kWh` nor `kVAh`: active and apparent energy are different
        # quantities and this tag does not say which it is.
        ("4F_Incomer1_kWAh", "ambiguous_energy_register_spelling"),
        ("KWVH", "ambiguous_energy_register_spelling"),
        # A volume or a volumetric rate. The datasheet decides, not the tag.
        ("Cum_Flow", "ambiguous_flow"),
        ("Flow Rate", "ambiguous_flow"),
    ],
)
def test_an_ambiguous_tag_proposes_nothing_and_says_why(tag, key):
    got = un.match_pattern(tag, "num")
    assert got is not None
    assert got.key == key
    assert got.kind == un.KIND_AMBIGUOUS
    assert got.unit is None
    assert got.proposes_unit is False
    # It must SAY so — the basis is what the operator reads.
    assert got.basis


def test_the_collision_beats_the_general_suffix():
    # Order is the whole mechanism. `KWL1_A` ends in `_A`, so the plain current
    # rule would hand it `A` the moment it were consulted first — and the tag
    # says kilowatts. If this ever flips, 3 power channels quietly become amps.
    keys = [p.key for p in un.PATTERNS]
    assert keys.index("ambiguous_power_named_in_amps") < keys.index("current_a")
    assert keys.index("ambiguous_voltage_named_in_amps") < keys.index("current_a")
    assert keys.index("ambiguous_current_named_in_volts") < keys.index("voltage_v")
    assert un.match_pattern("KWL1_A", "num").unit is None


def test_a_tag_no_pattern_can_read_matches_nothing():
    # Not a defect. `Batt_Time_Rem` and `Point1` are tags nobody here can read,
    # and the honest report is that they remain one-by-one work.
    for tag in ("Batt_Time_Rem", "Batt_Cap_Rem", "Point1", "Last_Year"):
        assert un.match_pattern(tag, "num") is None
        assert un.suggest(tag, "num") is None


def test_a_text_point_matches_nothing_whatever_its_tag_says():
    # A unit on a string is meaningless. The tag would otherwise match on shape.
    assert un.match_pattern("KWH_kwh", "text") is None
    assert un.suggest("KWH_kwh", "text") is None


def test_power_factor_asserts_an_empty_unit_not_a_missing_one():
    # `""` and `None` are opposite claims here and the difference is the point:
    # power factor is a ratio and HAS no unit, which is a confirmable fact,
    # whereas a state has no unit because it is not a quantity.
    pf = un.match_pattern("PF", "num")
    assert pf.unit == ""
    assert pf.proposes_unit is True
    assert un.match_pattern("On Off STS", "num").unit is None


def test_a_period_total_is_still_kwh_because_the_reset_is_a_role():
    # `TodayKWH` resets daily and a lifetime register does not — a true and
    # important distinction, and one that `metric_registry/roles.py` already
    # owns (`energy_period_total` vs `energy_register`). Both are in kWh.
    # Splitting it here too would put one judgement in two places.
    assert un.match_pattern("TodayKWH", "num").unit == "kWh"
    assert un.match_pattern("KWH", "num").unit == "kWh"


# ── A scripted session ───────────────────────────────────────────────────────


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def all(self):
        return list(self._rows)


# The fragment that identifies each statement. Matched against the RENDERED SQL,
# so a renamed query fails loudly here rather than quietly answering with the
# wrong table's rows.
FRAGMENTS = {
    "last_known": "FROM readings_1h r",
    "confirm": "UPDATE points p",
    "candidates": "AND p.type = 'num'",
    "visible": "SELECT p.point_id, p.point_tag, p.device_tag, p.category, p.unit, p.unit_source",
    "liveness": "coalesce(sib.tags",
}

TENANT_PREDICATE = "p.tenant_id = CAST(:tenant AS uuid)"


def point(tag, *, tenant=T1, unit=None, unit_source=None, kind="num", category="hvac"):
    return {
        "point_id": uuid.uuid4(),
        "point_tag": tag,
        "device_tag": "YC-1",
        "category": category,
        "type": kind,
        "unit": unit,
        "unit_source": unit_source,
        "site_id": None,
        "site_name": None,
        "tenant_id": tenant,
    }


class FakeDb:
    """Four statements, scripted from one list of point rows.

    The TENANT filter is applied here only when the statement it was handed
    actually carries `p.tenant_id = CAST(:tenant AS uuid)`. That is deliberate:
    it means a query that loses its tenant predicate does not quietly keep
    passing these tests — it starts returning the other tenant's rows, which is
    what the scope tests assert against.
    """

    def __init__(self, rows, values=None):
        self.rows = rows
        self.values = values or {}
        self.asked_values: list[list[str]] = []
        self.updates: list[dict] = []
        self.committed = 0

    def _scoped(self, sql, params):
        if TENANT_PREDICATE not in sql or not params.get("tenant"):
            return list(self.rows)
        return [r for r in self.rows if str(r["tenant_id"]) == str(params["tenant"])]

    async def execute(self, clause, params=None):
        sql = " ".join(str(clause).split())
        params = params or {}
        for name, frag in FRAGMENTS.items():
            if " ".join(frag.split()) not in sql:
                continue
            if name == "last_known":
                # A reading per point only where a test put one — `self.values`
                # maps point_id -> value. Absent means nothing read lately.
                self.asked_values.append(sorted(str(p) for p in params["pids"]))
                want = {str(p) for p in params["pids"]}
                return _Result(
                    [
                        {"point_id": pid, "value": v, "at": dt.datetime(2026, 9, 20, tzinfo=UTC)}
                        for pid, v in self.values.items()
                        if str(pid) in want
                    ]
                )
            if name == "candidates":
                rows = [r for r in self._scoped(sql, params) if r["type"] == "num"]
                if "p.category = :category" in sql:
                    rows = [r for r in rows if r["category"] == params.get("category")]
                # Same discipline as the tenant filter: applied only when the SQL
                # actually carries the predicate, so a query that loses it starts
                # returning another building's rows instead of quietly passing.
                if "p.site_id = CAST(:site AS uuid)" in sql:
                    rows = [r for r in rows if str(r["site_id"]) == params.get("site")]
                return _Result(rows)
            if name == "visible":
                want = {str(p) for p in params["pids"]}
                return _Result([r for r in self._scoped(sql, params) if str(r["point_id"]) in want])
            if name == "liveness":
                # Every point is healthily reporting unless a test says
                # otherwise; the not-reporting challenge has its own suite
                # (test_intake_guard.py) and is not what is under test here.
                now = dt.datetime.now(UTC)
                want = {str(p) for p in params["pids"]}
                return _Result(
                    [
                        {
                            **r,
                            "first_seen_at": now - dt.timedelta(days=30),
                            "last_reading_at": now,
                            "siblings": [],
                        }
                        for r in self.rows
                        if str(r["point_id"]) in want
                    ]
                )
            if name == "confirm":
                want = {str(p) for p in params["pids"]}
                hit = [r for r in self._scoped(sql, params) if str(r["point_id"]) in want]
                for r in hit:
                    r["unit"] = params["unit"]
                    r["unit_source"] = None if params["clear"] else "operator"
                self.updates.append({"pids": sorted(want), "unit": params["unit"]})
                return _Result([{"point_id": r["point_id"]} for r in hit])
        raise AssertionError(f"unrecognised statement: {sql[:160]}")

    async def commit(self):
        self.committed += 1


# ── Rule 2: a pattern never overwrites a human ───────────────────────────────


def test_a_pattern_never_targets_a_unit_a_human_already_confirmed():
    db = FakeDb(
        [
            point("1FYC1_IWT"),
            point("1FYC1_OWT"),
            # Already ruled on. It matches the pattern and must NOT be written.
            point("4FKC2_IWT", unit="degC", unit_source="operator"),
        ]
    )
    pattern, eligible, already = run(
        un.pattern_targets(db, T1, key="chilled_water_temp")
    )
    assert pattern.unit == "degC"
    assert sorted(r["point_tag"] for r in eligible) == ["1FYC1_IWT", "1FYC1_OWT"]
    assert [r["point_tag"] for r in already] == ["4FKC2_IWT"]


def test_a_unit_that_arrived_on_the_wire_is_not_a_confirmation():
    # `unit_source='reading'` is the gateway talking, not a person. It is still
    # eligible — the whole feature exists because nothing on this estate has
    # ever asserted a unit.
    db = FakeDb([point("1FYC1_IWT", unit="C", unit_source="reading")])
    _, eligible, already = run(un.pattern_targets(db, T1, key="chilled_water_temp"))
    assert len(eligible) == 1
    assert already == []


def test_the_catalogue_counts_eligible_and_already_confirmed_apart():
    db = FakeDb(
        [
            point("1FYC1_IWT"),
            point("1FYC1_OWT", unit="degC", unit_source="operator"),
            point("1FYC1_OnOff STS"),
            point("Point1"),
        ]
    )
    out = run(un.pattern_catalogue(db, T1))
    by_key = {p["key"]: p for p in out["patterns"]}
    water = by_key["chilled_water_temp"]
    # Two numbers, never one. 2 matched / 1 eligible / 1 done is a different
    # state from 2 matched / 2 eligible, and a single figure could not say which.
    assert water["matched"] == 2
    assert water["eligible"] == 1
    assert water["already_confirmed"] == 1
    # Sampled from the ELIGIBLE rows — those are the ones about to be acted on.
    assert water["sample_tags"] == ["1FYC1_IWT"]
    # A state pattern is in the catalogue and proposes nothing.
    assert by_key["state_on_off"]["unit"] is None
    assert by_key["state_on_off"]["proposes_unit"] is False
    # And the tag nobody can read is counted as unmatched, not as done.
    assert out["totals"]["unmatched"] == 1
    assert out["unmatched_sample"] == ["Point1"]


def test_the_catalogue_carries_every_eligible_point_with_what_it_reads():
    """The console checks EVERY reading against the unit's plausible range, and
    a check run on a sample would let the sixty-first meter hide behind a green
    tick. So every eligible point comes back, each with its last known value —
    and a point that read nothing lately comes back with NONE, never 0."""
    live, quiet = point("1FYC1_IWT"), point("1FYC1_OWT")
    done = point("4FKC2_IWT", unit="degC", unit_source="operator")
    db = FakeDb([live, quiet, done], values={live["point_id"]: 6.8})
    out = run(un.pattern_catalogue(db, T1))
    water = {p["key"]: p for p in out["patterns"]}["chilled_water_temp"]
    got = {p["point_tag"]: p["value"] for p in water["points"]}
    assert got == {"1FYC1_IWT": 6.8, "1FYC1_OWT": None}
    # A confirmed point is not work, is not listed, and is not even read for.
    assert str(done["point_id"]) not in db.asked_values[0]


def test_names_no_convention_claims_come_back_as_points_to_ask_about():
    odd = point("Point1")
    db = FakeDb([odd, point("Load", unit="kW", unit_source="operator")], values={odd["point_id"]: 3.2})
    out = run(un.pattern_catalogue(db, T1))
    assert [(p["point_tag"], p["value"]) for p in out["unmatched_points"]] == [("Point1", 3.2)]


def test_the_values_are_read_off_the_hourly_aggregate_within_a_month():
    """Raw `readings` is compressed; the one-hour lookback `/bi/points` uses
    would leave most of this estate's quiet points blank, which is the question
    left unanswered."""
    sql = " ".join(str(un._LAST_KNOWN_SQL).split())
    assert "FROM readings_1h r" in sql
    assert "make_interval(days => :days)" in sql
    assert un.LAST_KNOWN_DAYS == 30


def test_the_catalogue_writes_nothing():
    db = FakeDb([point("1FYC1_IWT")])
    run(un.pattern_catalogue(db, T1))
    assert db.updates == []
    assert db.committed == 0


# ── Rule 4: tenant scope ─────────────────────────────────────────────────────


def test_a_pattern_only_ever_sees_the_callers_own_points():
    db = FakeDb([point("1FYC1_IWT", tenant=T1), point("4FKC2_IWT", tenant=T2)])
    _, eligible, _ = run(un.pattern_targets(db, T1, key="chilled_water_temp"))
    assert [r["point_tag"] for r in eligible] == ["1FYC1_IWT"]


def test_the_write_carries_the_same_tenant_bind_as_every_read():
    mine = point("1FYC1_IWT", tenant=T1)
    theirs = point("4FKC2_IWT", tenant=T2)
    db = FakeDb([mine, theirs])
    # The other tenant's id, named explicitly. The statement must drop it.
    updated = run(
        un.confirm_units(
            db, T1, point_ids=[mine["point_id"], theirs["point_id"]], unit="degC", actor="u1"
        )
    )
    assert updated == [mine["point_id"]]
    assert theirs["unit"] is None


def test_a_category_filter_narrows_the_pattern_to_that_category():
    # The preview and the write must be able to name the SAME set; `hvac` is the
    # worst backlog on this estate (28 of 176 confirmed) and is worked on its own.
    db = FakeDb(
        [point("1FYC1_IWT", category="hvac"), point("4FKC2_IWT", category="water")]
    )
    _, eligible, _ = run(
        un.pattern_targets(db, T1, key="chilled_water_temp", category="hvac")
    )
    assert [r["point_tag"] for r in eligible] == ["1FYC1_IWT"]


# ── The route ────────────────────────────────────────────────────────────────


@pytest.fixture
def wired(app):
    """The real app, the real permission gate, a scripted session.

    `conftest.app` hands the app a session that fails on contact — right for a
    refusal test and useless here, so the override is replaced.
    """
    from reporting.db import get_db

    state: dict = {}

    def install(rows):
        db = FakeDb(rows)
        state["db"] = db

        async def _override():
            yield db

        app.dependency_overrides[get_db] = _override
        return db

    yield app, install


def post(app, body, **kw):
    async def go():
        async with client(app) as c:
            return await c.post(
                f"{PREFIX}/bi/units/confirm",
                json=body,
                headers=auth(tenant_id=T1, permissions=["bi.read", "bi.manage"], **kw),
            )

    return run(go())


def get_patterns(app, query=""):
    async def go():
        async with client(app) as c:
            return await c.get(
                f"{PREFIX}/bi/units/patterns{query}",
                headers=auth(tenant_id=T1, permissions=["bi.read"]),
            )

    return run(go())


def test_the_catalogue_endpoint_reports_each_patterns_live_backlog(wired):
    app, install = wired
    install([point("1FYC1_IWT"), point("1FYC1_OWT"), point("1FYC1_OnOff STS")])
    r = get_patterns(app)
    assert r.status_code == 200
    by_key = {p["key"]: p for p in r.json()["patterns"]}
    assert by_key["chilled_water_temp"]["eligible"] == 2
    assert by_key["chilled_water_temp"]["unit"] == "degC"
    assert by_key["state_on_off"]["kind"] == "state"
    assert by_key["state_on_off"]["unit"] is None


def test_a_pattern_applies_the_unit_the_operator_was_shown(wired):
    app, install = wired
    db = install([point("1FYC1_IWT"), point("1FYC1_OWT")])
    r = post(app, {"pattern": "chilled_water_temp"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["updated"] == 2
    assert body["unit"] == "degC"
    assert body["unit_source"] == "operator"
    assert db.updates[0]["unit"] == "degC"
    assert all(row["unit_source"] == "operator" for row in db.rows)


def test_the_rows_a_human_already_ruled_on_are_reported_apart_from_the_applied(wired):
    app, install = wired
    db = install(
        [point("1FYC1_IWT"), point("4FKC2_IWT", unit="K", unit_source="operator")]
    )
    r = post(app, {"pattern": "chilled_water_temp"})
    body = r.json()
    assert body["updated"] == 1
    assert body["skipped_already_confirmed_count"] == 1
    assert [s["point_tag"] for s in body["skipped_already_confirmed"]] == ["4FKC2_IWT"]
    # And the pre-existing assertion survived untouched. "applied 2" here would
    # have been a lie AND a silent overwrite of a person's decision.
    assert [r_["unit"] for r_ in db.rows if r_["point_tag"] == "4FKC2_IWT"] == ["K"]


def test_dry_run_writes_nothing(wired):
    app, install = wired
    db = install([point("1FYC1_IWT"), point("1FYC1_OWT")])
    r = post(app, {"pattern": "chilled_water_temp", "dry_run": True})
    body = r.json()
    assert body["dry_run"] is True
    assert body["updated"] == 0
    assert body["would_update_count"] == 2
    # The session never saw an UPDATE and never committed.
    assert db.updates == []
    assert db.committed == 0
    assert all(row["unit"] is None for row in db.rows)


def test_dry_run_names_the_whole_set_not_just_its_size(wired):
    # A count is what an operator decides on; the names are what let them find
    # the one row that does not belong before they write to 80 of them.
    app, install = wired
    install([point("1FYC1_IWT"), point("1FYC1_OWT")])
    body = post(app, {"pattern": "chilled_water_temp", "dry_run": True}).json()
    assert sorted(w["label"] for w in body["would_update"]) == [
        "YC-1 / 1FYC1_IWT",
        "YC-1 / 1FYC1_OWT",
    ]


def test_a_state_pattern_cannot_be_applied_in_bulk(wired):
    app, install = wired
    db = install([point("1FYC1_OnOff STS"), point("On Off STS")])
    r = post(app, {"pattern": "state_on_off"})
    # 422 is what `kernel.errors` renders a ValidationError as; the CODE is the
    # part a client branches on and the part that must not drift.
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "PATTERN_PROPOSES_NO_UNIT"
    assert db.updates == []


def test_an_ambiguous_pattern_cannot_be_applied_in_bulk(wired):
    app, install = wired
    db = install([point("KWL1_A")])
    r = post(app, {"pattern": "ambiguous_power_named_in_amps"})
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "PATTERN_PROPOSES_NO_UNIT"
    assert db.updates == []


def test_an_unknown_pattern_is_a_refusal_not_a_silent_no_op(wired):
    # A client that misspelt the key must not be told it succeeded on zero rows.
    app, install = wired
    install([point("1FYC1_IWT")])
    r = post(app, {"pattern": "chilled_water_tempp"})
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "UNKNOWN_UNIT_PATTERN"


def test_a_pattern_cannot_be_aimed_at_an_arbitrary_unit(wired):
    # The unit written is the one the catalogue proposed and the screen showed.
    # Otherwise the displayed proposal is decoration.
    app, install = wired
    install([point("1FYC1_IWT")])
    r = post(app, {"pattern": "chilled_water_temp", "unit": "kWh"})
    assert r.status_code == 422, r.text


def test_a_pattern_and_a_point_list_together_are_refused(wired):
    app, install = wired
    p = point("1FYC1_IWT")
    install([p])
    r = post(app, {"pattern": "chilled_water_temp", "point_ids": [str(p["point_id"])]})
    assert r.status_code == 422, r.text


def test_neither_selector_is_refused(wired):
    app, install = wired
    install([point("1FYC1_IWT")])
    assert post(app, {}).status_code == 422


def test_the_explicit_point_list_still_works_and_still_clears(wired):
    app, install = wired
    p = point("1FYC1_IWT", unit="degC", unit_source="operator")
    db = install([p])
    r = post(app, {"point_ids": [str(p["point_id"])], "unit": None})
    assert r.status_code == 200, r.text
    assert r.json()["updated"] == 1
    assert p["unit_source"] is None
    assert db.committed == 1


def test_a_pattern_is_refused_to_a_caller_without_bi_manage(app):
    # The gate is a dependency and a dependency can be declared and never
    # reached. `conftest.app` hands this request a session that fails on
    # contact, so a 403 is proof it never got as far as a query.
    async def go():
        async with client(app) as c:
            return await c.post(
                f"{PREFIX}/bi/units/confirm",
                json={"pattern": "chilled_water_temp"},
                headers=auth(tenant_id=T1, permissions=["bi.read"]),
            )

    assert run(go()).status_code == 403


def test_the_catalogue_is_refused_to_a_caller_without_bi_read(app):
    async def go():
        async with client(app) as c:
            return await c.get(
                f"{PREFIX}/bi/units/patterns", headers=auth(tenant_id=T1, permissions=[])
            )

    assert run(go()).status_code == 403


# ── The request shape itself ─────────────────────────────────────────────────


def test_the_request_refuses_both_selectors_before_any_route_sees_it():
    with pytest.raises(ValueError):
        ConfirmUnitsRequest(pattern="active_power_kw", point_ids=[uuid.uuid4()])


def test_the_request_refuses_a_unit_beside_a_pattern_even_when_it_is_null():
    # `unit: null` means CLEAR. Aimed at a pattern that is either a no-op or a
    # mass retraction nobody reviewed, so it is rejected on being SENT rather
    # than on being non-null.
    with pytest.raises(ValueError):
        ConfirmUnitsRequest(pattern="active_power_kw", unit=None)
    # Omitted entirely is the normal case and must still be accepted.
    assert ConfirmUnitsRequest(pattern="active_power_kw").pattern == "active_power_kw"



# ── One building's backlog ───────────────────────────────────────────────────
#
# The building view previews a pattern for ONE site, so the write must act on
# that same site's points or the operator confirms a set they were never shown.
# Both halves are selected by `_candidates`, and these tests hold both to it.

SITE_A = uuid.UUID("aaaaaaaa-0000-0000-0000-00000000000a")
SITE_B = uuid.UUID("bbbbbbbb-0000-0000-0000-00000000000b")


def at(row, site):
    return {**row, "site_id": site}


def test_a_building_catalogue_counts_only_that_buildings_points(wired):
    app, install = wired
    install([at(point("1FYC1_IWT"), SITE_A), at(point("2FYC1_IWT"), SITE_B)])
    r = get_patterns(app, f"?site_id={SITE_A}")
    assert r.status_code == 200, r.text
    by_key = {p["key"]: p for p in r.json()["patterns"]}
    assert by_key["chilled_water_temp"]["eligible"] == 1


def test_a_building_confirm_writes_only_what_that_building_previewed(wired):
    app, install = wired
    db = install([at(point("1FYC1_IWT"), SITE_A), at(point("2FYC1_IWT"), SITE_B)])
    r = post(app, {"pattern": "chilled_water_temp", "site_id": str(SITE_A)})
    assert r.status_code == 200, r.text
    assert r.json()["updated"] == 1
    written = {row["point_tag"] for row in db.rows if row["unit_source"] == "operator"}
    assert written == {"1FYC1_IWT"}


def test_the_route_does_not_drop_the_readings_on_the_way_out():
    """The service returned every point with its reading and the route's
    response model, which did not name them, dropped them. The Units screen got
    no readings, built no questions, and told an operator who had pressed
    nothing that every number had a unit. This asserts at the RESPONSE MODEL,
    which is where they were lost."""
    import app.api.schemas as S

    pid = uuid.uuid4()
    row = {
        "key": "voltage_v", "label": "Voltage", "kind": "unit", "unit": "V",
        "proposes_unit": True, "basis": "b", "matched": 1, "eligible": 1,
        "already_confirmed": 0, "sample_tags": [], "categories": [],
        "points": [{"point_id": pid, "point_tag": "VoltL1_V", "device_tag": "D",
                    "value": 231.4, "at": None}],
    }
    out = S.UnitPatternsResponse(
        patterns=[row],
        totals={"points": 1, "matched": 1, "unmatched": 1, "eligible": 1, "already_confirmed": 0},
        unmatched_points=[{"point_id": pid, "point_tag": "Load", "device_tag": "D", "value": None}],
    ).model_dump()
    assert out["patterns"][0]["points"][0]["value"] == 231.4
    assert out["unmatched_points"][0]["point_tag"] == "Load"
    # A point that read nothing stays NONE through the model — never 0.
    assert out["unmatched_points"][0]["value"] is None
