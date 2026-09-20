"""What a reading means — asked only where something computed reads it.

The estate has 494 live points and a screen that lists them cannot be used. The
rules that make this answer small enough to act on:

  * a point is a question only when its suggested role, or its confirmed role,
    is read by an EFFECTIVE metric definition — a platform-seeded definition is
    every tenant's, a tenant's own overrides it, older versions are gone;
  * a suggestion for a role nothing reads is not a question;
  * a point already answered comes back ANSWERED, so it can be taken back;
  * every question carries the metrics that read it and the reading's own latest
    value, and says when there is no value — that press will be challenged;
  * devices with something to answer come first; a device whose readings nothing
    computes with is not listed at all.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid

from app.api import role_asks as ra

FRAGMENTS = {
    "demands": "i.value ? 'role'",
    "points": "LEFT JOIN point_roles r ON r.point_id = p.point_id",
    "latest": "DISTINCT ON (r.point_id)",
}


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def all(self):
        return list(self._rows)


class Db:
    def __init__(self, **script):
        unknown = set(script) - set(FRAGMENTS)
        if unknown:
            raise AssertionError(f"no such scripted query: {sorted(unknown)}")
        self.script = script
        self.asked: list[str] = []
        self.params: dict[str, list] = {}

    async def execute(self, clause, params=None):
        sql = str(clause)
        for name, frag in FRAGMENTS.items():
            if frag in sql:
                if name not in self.script:
                    raise AssertionError(f"the `{name}` query ran, which this test did not script")
                self.asked.append(name)
                self.params.setdefault(name, []).append(params)
                return _Result(self.script[name])
        raise AssertionError(f"unrecognised statement: {sql[:160]}")


TENANT = uuid.uuid4()
SITE = uuid.uuid4()
NOW = dt.datetime(2026, 9, 20, 10, tzinfo=dt.timezone.utc)


def demand(key, role, *, version=1, tenant=None, scope="device"):
    return {"key": key, "version": version, "tenant_id": tenant, "scope": scope, "role": role}


# As the estate really holds them: seeded by the platform, null tenant.
DEMANDS = [
    demand("chiller_delta_t", "inlet_water_temp"),
    demand("chiller_delta_t", "outlet_water_temp"),
    demand("carbon_intensity", "energy_register", scope="site"),
]


def point(tag, device, *, role=None, kind="num", pid=None, unit="degC"):
    return {
        "point_id": pid or uuid.uuid4(), "point_tag": tag, "device_id": uuid.uuid4(),
        "device_tag": device, "type": kind, "unit": unit, "site_id": SITE,
        "site_name": "Aeon Tower", "last_seen_at": NOW, "role": role,
        "role_confirmed_by": "ops@x.io" if role else None,
        "role_confirmed_at": NOW if role else None,
    }


def reading(pid, num):
    return {"point_id": pid, "ts": NOW, "num": num}


def run(**script):
    return asyncio.run(ra.role_asks(Db(**script), TENANT, site_id=SITE))


# ── which readings are questions at all ──────────────────────────────────────


def test_a_platform_seeded_metric_decides_what_is_asked():
    db = Db(demands=[demand("chiller_delta_t", "inlet_water_temp")])
    assert asyncio.run(ra.demands(db, TENANT)) == {"inlet_water_temp": {"chiller_delta_t"}}


def test_a_role_no_effective_metric_reads_is_never_a_question():
    # `KW_L1` suggests active_power, and nothing on this estate reads it.
    wanted = {"inlet_water_temp": {"chiller_delta_t"}}
    assert ra.question_of(point("KW_L1", "4F-3F AC DB", unit="kW"), wanted, None) is None
    assert ra.question_of(point("IWT", "CH1"), wanted, None) is not None


def test_a_question_carries_the_tags_reason_and_who_reads_it():
    q = ra.question_of(point("1FKC2_kWh", "1F Khem Chiller02"), {"energy_register": {"carbon_intensity"}}, None)
    assert q["role"] == "energy_register"
    assert q["role_label"] == "Energy register"
    assert "kWh register" in q["basis"]
    assert q["needed_by"] == ["carbon_intensity"]
    assert q["answered"] is False


def test_an_answered_reading_comes_back_answered_so_it_can_be_taken_back():
    q = ra.question_of(point("IWT", "CH1", role="inlet_water_temp"), {"inlet_water_temp": {"m"}}, {"num": 28.4, "ts": NOW})
    assert (q["answered"], q["role"], q["value"]) == (True, "inlet_water_temp", 28.4)
    assert q["confirmed_by"] == "ops@x.io"


def test_a_reading_answered_as_something_nothing_reads_is_left_alone():
    # `energy_period_total` is confirmed on 12 points of this estate and no
    # effective metric reads it: not a question, and not shown as answered work.
    assert ra.question_of(point("TodayKWH", "M1", role="energy_period_total"), {"energy_register": {"m"}}, None) is None


def test_a_text_point_is_not_a_question():
    assert ra.question_of(point("Status", "CH1", kind="txt"), {"inlet_water_temp": {"m"}}, None) is None


# ── what the reading says right now ──────────────────────────────────────────


def test_a_question_with_no_recent_reading_says_the_press_will_be_challenged():
    pid = uuid.uuid4()
    out = run(demands=DEMANDS, points=[point("IWT", "4F Khem Chiller02", pid=pid)], latest=[])
    [q] = out["devices"][0]["asks"]
    assert (q["value"], q["reporting"]) == (None, False)


def test_the_value_beside_a_question_is_the_readings_own():
    pid = uuid.uuid4()
    out = run(
        demands=DEMANDS,
        points=[point("IWT", "4F Khem Chiller02", pid=pid)],
        latest=[reading(pid, 28.4)],
    )
    [q] = out["devices"][0]["asks"]
    assert (q["value"], q["reporting"], q["unit"]) == (28.4, True, "degC")


def test_no_reading_is_looked_up_for_points_nothing_asks_about():
    out = run(demands=DEMANDS, points=[point("KW_L1", "4F-3F AC DB", unit="kW")])
    assert out["devices"] == []
    assert out["totals"]["asks"] == 0


# ── the worklist ─────────────────────────────────────────────────────────────


def test_devices_with_something_to_answer_come_first():
    ans = point("1FYC1_IWT", "1F York Chiller01", role="inlet_water_temp")
    ask = point("IWT", "4F Khem Chiller02")
    out = run(demands=DEMANDS, points=[ans, ask], latest=[])
    assert [d["device_tag"] for d in out["devices"]] == ["4F Khem Chiller02", "1F York Chiller01"]
    assert out["totals"] == {"points": 2, "devices": 2, "asks": 1, "answered": 1}


def test_a_device_carries_its_own_asks_and_its_own_answers():
    dev = "4F Khem Chiller02"
    out = run(
        demands=DEMANDS,
        points=[
            point("IWT", dev),
            point("OWT", dev),
            point("1FKC2_kWh", dev, role="energy_register", unit="kWh"),
            point("Batt_Cap_Rem", dev, unit="%"),
        ],
        latest=[],
    )
    [d] = out["devices"]
    assert [q["point_tag"] for q in d["asks"]] == ["IWT", "OWT"]
    assert [q["point_tag"] for q in d["answered"]] == ["1FKC2_kWh"]


def test_a_reading_whose_role_the_device_already_answers_says_so():
    # The live rename: `IWT` is a dead generation of `4FKC2_IWT`, which is
    # answered. Binding both counts one sensor twice.
    dev = "4F Khem Chiller02"
    out = run(
        demands=DEMANDS,
        points=[point("IWT", dev), point("4FKC2_IWT", dev, role="inlet_water_temp")],
        latest=[],
    )
    [q] = out["devices"][0]["asks"]
    assert q["same_role_answered"] == ["4FKC2_IWT"]
    assert q["same_role_others"] == []


def test_several_readings_claiming_one_role_name_each_other():
    # 2F York Chiller01, live: three kWh registers, two of them old generations.
    dev = "2F York Chiller01"
    out = run(
        demands=DEMANDS,
        points=[
            point("2FChiller1EM_kWh", dev, unit="kWh"),
            point("2FYC1_EM_kWh", dev, unit="kWh"),
            point("2FYorkChiller1EM_kWh", dev, unit="kWh"),
        ],
        latest=[],
    )
    others = {q["point_tag"]: q["same_role_others"] for q in out["devices"][0]["asks"]}
    assert others["2FYC1_EM_kWh"] == ["2FChiller1EM_kWh", "2FYorkChiller1EM_kWh"]
    assert all(q["same_role_answered"] == [] for q in out["devices"][0]["asks"])


def test_the_roles_something_reads_are_said_with_the_answer():
    out = run(demands=DEMANDS, points=[point("IWT", "CH1")], latest=[])
    assert out["roles_read"] == [
        {"role": "energy_register", "label": "Energy register", "needed_by": ["carbon_intensity"]},
        {"role": "inlet_water_temp", "label": "Entering water temperature", "needed_by": ["chiller_delta_t"]},
        {"role": "outlet_water_temp", "label": "Leaving water temperature", "needed_by": ["chiller_delta_t"]},
    ]


def test_no_metric_reading_a_role_asks_nothing_and_says_so():
    out = run(demands=[])
    assert (out["devices"], out["roles_read"]) == ([], [])
    assert out["totals"]["asks"] == 0
