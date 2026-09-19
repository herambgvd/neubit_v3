"""The cross-domain correlation registry: LIVE, or named gaps of a named KIND.

WHAT THIS FEATURE CLAIMS, AND THEREFORE WHAT HAS TO BE TRUE
------------------------------------------------------------
`GET /bi/correlations` resolves seven questions that each need two domains at
once against this estate, and the sentence the console is built to print off the
back of it is:

    "seven gaps, and none of them needs a sensor bought."

That is a commercial claim and it is only honest if three things hold, which is
what this file is:

  * a gap carries a KIND, and the kinds are not interchangeable. "Confirm that
    the number called AmbTemp is in degrees" and "buy a people-counting camera"
    are both "a gap" and only one of them costs money;
  * an UNDETERMINED answer is counted as undetermined. This service may not open
    `neubit_access` or `neubit_vision`, so for a domain that publishes nothing
    into the reporting store, "it is empty" is a sentence it is not entitled to
    say. Folding that into "no hardware needed" would make the headline a guess;
  * a correlation is LIVE or it has named gaps. There is no score, no partial
    credit and nothing auto-applied.

The failures this file exists to catch are failures of RESTRAINT, the same kind
`test_ghost_collapse.py` and `test_role_succession.py` catch for their features:

  * reporting a module's population as ZERO when it is UNKNOWN, which is the
    single most damaging thing this endpoint could do — it turns "we cannot see
    the access service from here" into "you have no doors";
  * reporting "nothing in the window" as "nothing exists", when the store holds
    the last event it ever saw and can tell those apart;
  * finding a BOUND role by tag, which reports a role that followed a gateway
    rename as unbound (see `app/api/succession.py` for why that is the normal
    case and not the exotic one);
  * satisfying a signal with a RETIRED point, which reports a correlation as
    live over a window in which nothing measured it;
  * counting a unit the wire happened to send as a unit somebody asserted;
  * reaching across a tenant boundary in any of it.

HOW THE DATABASE IS FAKED. `FakeDb` below does not replay canned rows: for the
probe statement it reads the parameter arrays the resolver built and applies the
predicates itself over a point table the test supplies. So the PLAN is under test
as well as the rules — a probe that looks for a bound role by tag produces the
wrong rows here rather than passing on a scripted answer. It also applies the
tenant and retirement predicates only when the SQL it was handed actually
contains them, so deleting either from a query makes rows appear here that should
not, instead of passing quietly.
"""

from __future__ import annotations

import ast
import asyncio
import datetime as dt
import pathlib
import re
import uuid

import pytest

import reporting.models
from app.api import correlations as cx
from app.api import router as r
from app.api.queries import LIVE_POINT

from conftest import PREFIX, auth, client

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 9, 19, 12, 0, tzinfo=UTC)
START = NOW - dt.timedelta(hours=168)

T1 = uuid.UUID("11111111-1111-1111-1111-111111111111")
T2 = uuid.UUID("22222222-2222-2222-2222-222222222222")


def run(coro):
    """The house pattern (see test_metric_dataset.py): drive one coroutine."""
    return asyncio.run(coro)


# ── builders ─────────────────────────────────────────────────────────────────


def point(
    tag: str,
    *,
    tenant: uuid.UUID = T1,
    device: str = "1F York Chiller01",
    category: str | None = "hvac",
    device_type: str | None = "chiller",
    unit: str | None = None,
    unit_source: str | None = None,
    role: str | None = None,
    retired: bool = False,
    reported: bool = True,
    last_seen: dt.datetime | None = None,
) -> dict:
    """A point row. `reported` is whether it MEASURED anything in the window.

    Separate from `last_seen`, deliberately and pointedly: the bug this file now
    guards against was exactly the two being treated as one. A point can have a
    recent-ish `last_seen_at`, pass every retirement filter in the codebase, and
    still have produced nothing inside the window an answer is computed over.
    """
    return {
        "point_id": uuid.uuid4(),
        "tenant_id": tenant,
        "point_tag": tag,
        "device_tag": device,
        "category": category,
        "device_type": device_type,
        "unit": unit,
        "unit_source": unit_source,
        # Inside the 168h window for a reporting point; eight days back for a
        # silent one — which is where every role binding on this estate sits, and
        # comfortably inside the 30-day horizon that used to pass for "live".
        "last_seen_at": last_seen
        or (NOW - dt.timedelta(minutes=1) if reported else NOW - dt.timedelta(days=8)),
        "role": role,
        "retired": retired,
        "reported": reported,
        # What `run_probes` derives from the lateral. Present on the builder so
        # the PURE resolvers can be called with a point directly; the integration
        # path recomputes it from `last_in_window` and overwrites this.
        "reported_in_window": reported,
    }


def silent(tag: str, **kw) -> dict:
    """A point that is configured correctly and has stopped measuring.

    The live estate's actual state: all twenty role bindings were last seen eight
    days before the window opened while the estate as a whole was current to the
    minute.
    """
    return point(tag, reported=False, **kw)


def signal(key: str, source: str, **requires) -> dict:
    return {
        "key": key,
        "label": key.replace("_", " "),
        "domain": "hvac",
        "source": source,
        "unlocks": f"the {key} axis",
        "requires": requires,
    }


def definition(key: str, *signals: dict, tenant=None, version: int = 1) -> dict:
    return {
        "id": uuid.uuid4(),
        "tenant_id": tenant,
        "key": key,
        "version": version,
        "effective_from": NOW - dt.timedelta(days=1),
        "name": key,
        "question": "a question that needs two domains",
        "unlocks": "something a BMS cannot do",
        "domains": ["hvac", "access"],
        "signals": list(signals),
    }


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def all(self):
        return list(self._rows)


class FakeDb:
    """A store that answers the five statements this resolver issues, and no more.

    The tenant and retirement predicates are honoured only when the SQL actually
    carries them — see the module docstring. A statement nothing here recognises
    is an AssertionError naming it, so a new query is a loud failure rather than
    an extra round trip nobody notices.
    """

    def __init__(
        self,
        *,
        defs: list[dict] | None = None,
        points: list[dict] | None = None,
        specs: list[dict] | None = None,
        relation_present: bool = True,
        population: dict | None = None,
        emission_factors: tuple[int, int] = (0, 0),
    ):
        self.defs = defs or []
        self.points = points or []
        self.specs = specs or []
        self.relation_present = relation_present
        self.population = population or {
            "rows_in_window": 0,
            "keys_in_window": 0,
            "last_event_at": None,
        }
        self.emission_factors = emission_factors
        self.asked: list[str] = []
        self.statements: list[str] = []

    # -- helpers --------------------------------------------------------------

    @staticmethod
    def _tenant_scoped(sql: str) -> bool:
        return "p.tenant_id = CAST(:tenant AS uuid)" in sql or (
            "tenant_id = CAST(:tenant AS uuid)" in sql
        )

    def _by_tenant(self, rows, sql, params, field="tenant_id"):
        wanted = params.get("tenant")
        if wanted is None or not self._tenant_scoped(sql):
            return list(rows)
        return [row for row in rows if str(row[field]) == str(wanted)]

    # -- the seams ------------------------------------------------------------

    async def execute(self, clause, params=None):
        sql = str(clause)
        params = params or {}
        self.statements.append(sql)

        if "FROM correlation_defs" in sql:
            self.asked.append("defs")
            rows = self.defs
            if "tenant_id IS NULL OR tenant_id = CAST(:tenant AS uuid)" in sql:
                wanted = params.get("tenant")
                rows = [
                    d
                    for d in rows
                    if d["tenant_id"] is None
                    or wanted is None
                    or str(d["tenant_id"]) == str(wanted)
                ]
            rows = [d for d in rows if d["effective_from"] <= NOW]
            # The ORDER BY is READ OUT OF THE STATEMENT, not assumed. `NULLS
            # LAST` on `tenant_id` is what puts a tenant's own row ahead of the
            # platform default, and `_pick_effective` keeps the first row per
            # key — so the two halves of that contract are one mutation apart and
            # flipping the SQL has to be visible here.
            tenant_first = "tenant_id NULLS LAST" in sql
            rows = sorted(
                rows,
                key=lambda d: (
                    d["key"],
                    (d["tenant_id"] is None) if tenant_first else (d["tenant_id"] is not None),
                    -d["effective_from"].timestamp(),
                    -d["version"],
                ),
            )
            return _Result(rows)

        if "WITH probe(idx" in sql:
            self.asked.append("probe")
            return _Result(self._probe(sql, params))

        if "FROM reporting_projections" in sql:
            self.asked.append("specs")
            keys = set(params.get("keys") or [])
            return _Result([s for s in self.specs if s["key"] in keys])

        if "to_regclass" in sql:
            self.asked.append("relation_present")
            return _Result([{"present": self.relation_present}])

        if "rows_in_window" in sql:
            self.asked.append("population")
            return _Result([dict(self.population)])

        if "FROM site_emission_factors" in sql:
            self.asked.append("emission_factor")
            recorded, cited = self.emission_factors
            return _Result([{"recorded": recorded, "cited": cited}])

        raise AssertionError(f"unrecognised statement: {' '.join(sql.split())[:160]}")

    def _probe(self, sql: str, params: dict) -> list[dict]:
        """The probe relation, evaluated here rather than scripted.

        This is what makes the probe PLAN testable: the predicates below are the
        ones the statement declares, so a signal that plans the wrong probe gets
        the wrong rows instead of whatever a test happened to hand it.
        """
        retirement_applied = "p.retired_at IS NULL" in sql
        # The lateral over `readings` is what decides whether a point counts. If
        # the statement stops asking, every point here starts reporting — which is
        # precisely the regression that shipped, so it has to be visible.
        window_applied = "FROM readings rd" in sql and "rd.ts >= :start" in sql
        assert not window_applied or (params.get("start") and params.get("end")), (
            "the window join is in the SQL but the window was not bound"
        )
        # The BOUNDS are compared, not merely noticed. An earlier version of this
        # fake only checked that the join was present, so a resolver that passed
        # the wrong window — or an empty one — got the same rows back and every
        # assertion here passed. Each point is treated as having measured at its
        # own `last_seen_at`, which is what makes the span load-bearing.
        w_start, w_end = params.get("start"), params.get("end")
        out: list[dict] = []
        for idx, pattern, category, device_type, role, require_role in zip(
            params["idx"],
            params["pattern"],
            params["category"],
            params["device_type"],
            params["role"],
            params["require_role"],
        ):
            for p in self._by_tenant(self.points, sql, params):
                if retirement_applied and p["retired"]:
                    continue
                if pattern is not None and not re.search(pattern, p["point_tag"], re.I):
                    continue
                if category is not None and p["category"] != category:
                    continue
                if device_type is not None and p["device_type"] != device_type:
                    continue
                bound = p["role"] if (role is not None and p["role"] == role) else None
                if require_role and bound is None:
                    continue
                out.append({
                    "idx": idx,
                    "bound_role": bound,
                    # What the LATERAL returns: the instant it last measured
                    # INSIDE the window, or NULL. A statement that dropped the
                    # join gets NULL for nothing and every point counts.
                    "last_in_window": (
                        p["last_seen_at"]
                        if window_applied and w_start <= p["last_seen_at"] < w_end
                        else None
                    ),
                    **p,
                })
        return out


async def _resolve(db: FakeDb, tenant=T1):
    return await cx.resolve_all(db, tenant, start=START, end=NOW)


# ── A correlation with everything it needs ───────────────────────────────────


class TestALiveCorrelation:
    def test_every_signal_satisfied_reads_live_with_no_blocking_gap(self):
        """The state this whole feature exists to eventually produce.

        Two domains, both supplying: a point with an operator-confirmed unit of
        the right dimension, and a projection that published inside the window.
        """
        db = FakeDb(
            defs=[
                definition(
                    "live_one",
                    signal("ambient", "point_unit", tag_pattern="^.*ambtemp$",
                           dimension="temperature"),
                    signal("badges", "projection",
                           projection_key="access_events", key_column="door_id"),
                )
            ],
            points=[point("1FYC1_AmbTemp", unit="degC", unit_source="operator")],
            specs=[_spec("access_events", "door_id")],
            population={"rows_in_window": 412, "keys_in_window": 6, "last_event_at": NOW},
        )
        (out,) = run(_resolve(db))
        assert out["state"] == "live"
        assert out["blocking_gap"] is None
        assert [s["satisfied"] for s in out["signals"]] == [True, True]
        assert all(s["gap"] is None for s in out["signals"])

        totals = cx.totals([out])
        assert totals["live"] == 1
        assert totals["blocked"] == 0
        assert totals["blocking_gaps"] == 0
        assert totals["signal_gaps"] == 0

    def test_one_missing_signal_blocks_the_whole_question(self):
        """There is no partial credit. A correlation needs both sides or it is
        not being asked, and reporting it as 50% would be reporting a number
        about a question nobody can answer."""
        db = FakeDb(
            defs=[
                definition(
                    "half",
                    signal("ambient", "point_unit", tag_pattern="^.*ambtemp$",
                           dimension="temperature"),
                    signal("load", "point_unit", tag_pattern="^.*sysload$"),
                )
            ],
            points=[point("1FYC1_AmbTemp", unit="degC", unit_source="operator"),
                    point("1FYC1_SysLoad")],
        )
        (out,) = run(_resolve(db))
        assert out["state"] == "blocked"
        assert out["blocking_gap"]["signal"] == "load"


def _spec(key: str, *columns: str, enabled: bool = True) -> dict:
    """A `reporting_projections` row, as `projection_relation` reads it."""
    return {
        "key": key,
        "name": key,
        "enabled": enabled,
        "spec": {
            "target": {
                "relation": key,
                "time_column": "ts",
                "columns": [{"name": "ts"}, {"name": "tenant_id"}]
                + [{"name": c} for c in columns],
            }
        },
    }


# ── The gap kinds, told apart ────────────────────────────────────────────────


class TestTheGapKindsAreDistinguished:
    """Each kind is a different sentence with a different price. If two of them
    collapse into one, the screen's whole argument collapses with them."""

    def test_a_measurement_arriving_with_no_confirmed_unit_is_unit_unconfirmed(self):
        verdict = cx.resolve_point_unit([point("1FYC1_AmbTemp")], "temperature")
        assert verdict["gap"] == "unit_unconfirmed"
        assert cx.GAP_KINDS[verdict["gap"]].needs_new_hardware is False
        assert "none with an operator-confirmed unit" in verdict["gate"]

    def test_a_unit_that_only_the_wire_ever_said_is_not_a_confirmation(self):
        """`unit_source` is the whole point of that column. A unit that arrived on
        the wire is what the gateway happened to send, not an assertion anybody
        made, and `app/api/rating.py` refuses to divide by one."""
        verdict = cx.resolve_point_unit(
            [point("1FYC1_AmbTemp", unit="degC", unit_source="wire")], "temperature"
        )
        assert verdict["satisfied"] is False
        assert verdict["gap"] == "unit_unconfirmed"

    def test_a_unit_confirmed_as_the_wrong_quantity_is_its_own_kind(self):
        """Worse than a missing unit, and a different remedy: the assertion has
        already been made and it has to be CORRECTED, not supplied."""
        verdict = cx.resolve_point_unit(
            [point("1FYC1_AmbTemp", unit="kWh", unit_source="operator")], "temperature"
        )
        assert verdict["gap"] == "unit_wrong_dimension"
        assert verdict["evidence"]["confirmed_units"] == ["kWh"]
        assert cx.GAP_KINDS[verdict["gap"]].needs_new_hardware is False

    def test_a_signal_with_no_declared_dimension_takes_any_confirmed_unit(self):
        """System load is a percentage and `%` is deliberately not in the
        dimension table. The need is weaker and exactly stated: a human has said
        what the number is."""
        verdict = cx.resolve_point_unit(
            [point("1FYC1_SysLoad", unit="", unit_source="operator")], None
        )
        assert verdict["satisfied"] is True

    def test_a_role_with_candidates_reporting_is_unbound_and_costs_nothing(self):
        verdict = cx.resolve_point_role([], [point("1FYC1_IWT")], "inlet_water_temp")
        assert verdict["gap"] == "role_unbound"
        assert cx.GAP_KINDS[verdict["gap"]].needs_new_hardware is False
        assert verdict["evidence"]["candidates_matched"] == 1

    def test_a_role_with_no_candidate_at_all_is_a_point_that_does_not_exist(self):
        """The one kind that costs money, and the only one. If this collapsed
        into `role_unbound` the screen would tell an operator to go and bind a
        role on a point that is not there."""
        verdict = cx.resolve_point_role([], [], "inlet_water_temp")
        assert verdict["gap"] == "point_absent"
        assert cx.GAP_KINDS[verdict["gap"]].needs_new_hardware is True

    def test_a_signal_whose_shape_matches_nothing_is_point_absent_not_unconfirmed(self):
        verdict = cx.resolve_point_unit([], "temperature")
        assert verdict["gap"] == "point_absent"

    def test_a_bound_role_on_a_sensor_that_stopped_is_silent_not_unbound(self):
        """The live estate's state, and the most misleading one there is: the
        binding is CORRECT and every configuration screen says so, while the
        measurement is gone. Calling this `role_unbound` blames an operator for
        work they already did; calling it satisfied computes a correlation over
        nothing."""
        verdict = cx.resolve_point_role(
            [silent("1FKC2_IWT", unit="degC", unit_source="operator",
                    role="inlet_water_temp")],
            [],
            "inlet_water_temp",
        )
        assert verdict["gap"] == "signal_silent"
        assert verdict["evidence"]["points_reporting_in_window"] == 0
        # "Quiet since the 11th" and "quiet" are different findings, and only the
        # first one is something an operator can act on.
        assert verdict["evidence"]["silent_since"] is not None
        (sample,) = verdict["evidence"]["points"]
        assert sample["reported_in_window"] is False
        assert sample["last_seen_at"] is not None

    def test_a_unit_confirmed_sensor_that_stopped_is_silent_not_unconfirmed(self):
        """Confirming a unit on a dead point buys nothing, so silence is decided
        first. The reassuring half rides along: the unit IS confirmed, and an
        operator who cannot see that will go and re-do work that was never
        wrong."""
        verdict = cx.resolve_point_unit(
            [silent("1FYC1_AmbTemp", unit="degC", unit_source="operator")],
            "temperature",
        )
        assert verdict["gap"] == "signal_silent"
        assert verdict["evidence"]["points_with_confirmed_unit"] == 1

    def test_silence_is_undetermined_for_hardware_and_never_free(self):
        """A stopped sensor may be a dead transducer, a dropped gateway link, an
        edited poll or a tag a rebuild renamed. Two of those cost money and this
        service cannot tell which it is looking at, so it says so."""
        assert cx.GAP_KINDS["signal_silent"].needs_new_hardware is None

    def test_a_silent_signal_is_not_the_same_answer_as_a_missing_one(self):
        """`point_absent` is "the dimension holds no such row" and costs money.
        `signal_silent` is "the row is there and quiet". Collapsing them either
        way produces a wrong sentence and a wrong price."""
        absent = cx.resolve_point_live([])
        quiet = cx.resolve_point_live([silent("1FYC1_Run Hours")])
        assert absent["gap"] == "point_absent"
        assert quiet["gap"] == "signal_silent"
        assert quiet["evidence"]["points_matched"] == 1
        assert absent["evidence"]["points_matched"] == 0

    def test_a_silent_binding_reports_the_live_candidates_without_claiming_them(self):
        """A role bound to a quiet point while other points of the right shape are
        reporting is the SHAPE of a gateway rename. The candidates ride back in
        the evidence so an operator can look — and the kind stays `signal_silent`,
        because the candidate probe is not device-scoped and "an IWT somewhere is
        alive" is not evidence that it is THIS chiller's. That is the inference
        `app/api/succession.py` refuses to make and this file has no better claim
        to it."""
        verdict = cx.resolve_point_role(
            [silent("IWT", role="inlet_water_temp")],
            [point("1FYC1_IWT")],
            "inlet_water_temp",
        )
        assert verdict["gap"] == "signal_silent"
        assert verdict["evidence"]["candidates_reporting_in_window"] == 1
        assert "may be the same sensor under a new tag" in verdict["gate"]

    def test_an_unbound_role_whose_candidates_are_all_quiet_is_silent(self):
        """Nothing is bound AND nothing is measuring. Telling an operator to bind
        a role would send them to bind one onto a dead point."""
        verdict = cx.resolve_point_role([], [silent("1FYC1_IWT")], "inlet_water_temp")
        assert verdict["gap"] == "signal_silent"

    def test_role_unbound_is_only_said_about_points_that_are_reporting(self):
        verdict = cx.resolve_point_role([], [point("1FYC1_IWT")], "inlet_water_temp")
        assert verdict["gap"] == "role_unbound"
        assert verdict["evidence"]["candidates_reporting_in_window"] == 1

    def test_a_confirmed_unit_on_a_dead_point_does_not_satisfy_a_live_one(self):
        """The mixed case, and the sharpest form of the bug that shipped: the
        confirmed unit is on the sensor that STOPPED, and the sensor that is
        delivering has none. Judging the assertion over the whole matched set
        instead of the reporting subset satisfies this signal off a point that
        measured nothing."""
        verdict = cx.resolve_point_unit(
            [silent("1FYC1_AmbTemp", unit="degC", unit_source="operator"),
             point("2FYC1_AmbTemp")],
            "temperature",
        )
        assert verdict["satisfied"] is False
        assert verdict["gap"] == "unit_unconfirmed"
        assert verdict["evidence"]["points_matched"] == 2
        assert verdict["evidence"]["points_reporting_in_window"] == 1
        assert verdict["evidence"]["points_with_confirmed_unit"] == 0

    def test_a_site_fact_nobody_typed_is_unrecorded(self):
        verdict = cx.resolve_site_fact(
            {"fact": "emission_factor", "recorded": 0, "cited": 0}
        )
        assert verdict["gap"] == "site_fact_unrecorded"
        assert cx.GAP_KINDS[verdict["gap"]].needs_new_hardware is False

    def test_a_site_fact_recorded_without_a_source_is_uncited_not_unrecorded(self):
        """A factor with no citation is a number somebody remembered. It is
        recorded — telling an operator to record it would send them to a screen
        that already has a value on it."""
        verdict = cx.resolve_site_fact(
            {"fact": "emission_factor", "recorded": 1, "cited": 0}
        )
        assert verdict["gap"] == "site_fact_uncited"

    def test_a_cited_site_fact_satisfies(self):
        verdict = cx.resolve_site_fact(
            {"fact": "emission_factor", "recorded": 1, "cited": 1}
        )
        assert verdict["satisfied"] is True

    def test_exactly_one_kind_costs_money_and_two_are_undetermined(self):
        """The table below the headline. If a kind quietly became True the claim
        "none of these needs new hardware" would start being false without any
        test noticing; if `point_absent` became False it would start being false
        in the other direction; and if `signal_silent` became False the console
        would promise that a meter which has stopped is free to fix, which this
        service has no way of knowing."""
        costs = {k for k, v in cx.GAP_KINDS.items() if v.needs_new_hardware is True}
        unknown = {k for k, v in cx.GAP_KINDS.items() if v.needs_new_hardware is None}
        assert costs == {"point_absent"}
        assert unknown == {"module_population_unknown", "signal_silent"}


# ── Module population: the unknown that must never become a zero ─────────────


class TestModulePopulation:
    """`reading-writer` owns `neubit_reporting` and nothing else. The door
    inventory is in `neubit_access` and the camera inventory in `neubit_vision`,
    and opening either is the cross-service read the pipeline contract bans. So
    for a domain that publishes no read-model here, the population is UNKNOWN —
    and unknown is a correct answer where a guess is not."""

    def test_a_domain_that_publishes_nothing_here_is_unknown_and_never_zero(self):
        population = run(
            cx.projection_population(
                FakeDb(specs=[]),
                T1,
                projection_key="camera_analytics",
                key_column="camera_id",
                specs={},
                start=START,
                end=NOW,
            )
        )
        assert population["known"] is False
        assert population["reason"] == "not_registered"

        verdict = cx.resolve_projection(population, "camera analytics")
        assert verdict["gap"] == "module_population_unknown"
        assert cx.GAP_KINDS[verdict["gap"]].needs_new_hardware is None
        # Nothing numeric is asserted about a thing nobody can see.
        assert "rows_in_window" not in verdict["evidence"]
        assert "not knowable from this service" in verdict["gate"]

    def test_an_unknown_population_is_never_counted_as_needing_no_hardware(self):
        """The aggregate is where an unknown would do its damage: folded into
        `no_new_hardware_needed`, the console would print "nothing to buy" on the
        strength of a thing the backend refused to claim."""
        db = FakeDb(
            defs=[
                definition(
                    "unknowable",
                    signal("people", "projection",
                           projection_key="camera_analytics", key_column="camera_id"),
                    signal("tfa", "point_unit", tag_pattern="^kwh$", dimension="energy"),
                )
            ],
            points=[point("KWH", unit="kWh", unit_source="operator")],
            specs=[],
        )
        (out,) = run(_resolve(db))
        totals = cx.totals([out])
        assert out["blocking_gap"]["kind"] == "module_population_unknown"
        assert out["blocking_gap"]["needs_new_hardware"] is None
        assert totals["hardware_undetermined"] == 1
        assert totals["no_new_hardware_needed"] == 0
        assert totals["needs_new_hardware"] == 0

    def test_a_registered_stream_that_published_nothing_in_the_window_is_unpopulated(self):
        population = {
            "known": True,
            "projection": "access_events",
            "relation": "access_events",
            "rows_in_window": 0,
            "distinct_keys_in_window": 0,
            "last_event_at": NOW - dt.timedelta(days=20),
        }
        verdict = cx.resolve_projection(population, "door")
        assert verdict["gap"] == "module_unpopulated"
        assert cx.GAP_KINDS[verdict["gap"]].needs_new_hardware is False

    def test_an_unpopulated_stream_carries_the_last_event_it_ever_saw(self):
        """"Went quiet in August" and "never ran" are different problems and only
        one of them is a device somebody has to go and look at. Without this the
        two render identically, and the kind's own wording ("published nothing in
        the window") would be the only thing stopping a reader concluding that
        the estate has no doors."""
        quiet = cx.resolve_projection(
            {
                "known": True, "projection": "access_events", "relation": "access_events",
                "rows_in_window": 0, "distinct_keys_in_window": 0,
                "last_event_at": NOW - dt.timedelta(days=20),
            },
            "door",
        )
        never = cx.resolve_projection(
            {
                "known": True, "projection": "access_events", "relation": "access_events",
                "rows_in_window": 0, "distinct_keys_in_window": 0, "last_event_at": None,
            },
            "door",
        )
        assert quiet["evidence"]["last_event_at"] == NOW - dt.timedelta(days=20)
        assert never["evidence"]["last_event_at"] is None
        assert quiet["evidence"] != never["evidence"]

    def test_a_stream_with_traffic_in_the_window_satisfies(self):
        verdict = cx.resolve_projection(
            {
                "known": True, "projection": "access_events", "relation": "access_events",
                "rows_in_window": 412, "distinct_keys_in_window": 6, "last_event_at": NOW,
            },
            "door",
        )
        assert verdict["satisfied"] is True
        assert verdict["gap"] is None

    def test_a_disabled_projection_is_unknown_rather_than_empty(self):
        """Its relation may exist and be stale. Counting it would report a window
        the projector was not filling as a window in which nothing happened."""
        db = FakeDb(specs=[_spec("access_events", "door_id", enabled=False)])
        population = run(
            cx.projection_population(
                db, T1, projection_key="access_events", key_column="door_id",
                specs={"access_events": _spec("access_events", "door_id", enabled=False)},
                start=START, end=NOW,
            )
        )
        assert population["known"] is False
        assert cx.resolve_projection(population, "door")["gap"] == "module_population_unknown"
        assert "relation_present" not in db.asked

    def test_a_registered_projection_whose_relation_is_not_applied_is_unknown(self):
        db = FakeDb(relation_present=False)
        population = run(
            cx.projection_population(
                db, T1, projection_key="access_events", key_column="door_id",
                specs={"access_events": _spec("access_events", "door_id")},
                start=START, end=NOW,
            )
        )
        assert population == {
            "known": False, "reason": "relation_absent", "projection": "access_events",
        }
        assert "population" not in db.asked

    def test_a_key_column_the_projection_does_not_publish_is_refused(self):
        """Counting DISTINCT over a column a domain does not emit is a zero
        nobody can explain, and it would render as `module_unpopulated`."""
        with pytest.raises(cx.SpecError, match="declares no column"):
            cx.projection_relation(_spec("access_events", "door_id")["spec"], "camera_id")

    def test_a_relation_name_that_is_not_an_identifier_never_reaches_sql(self):
        spec = _spec("access_events", "door_id")["spec"]
        spec["target"]["relation"] = "access_events; DROP TABLE readings"
        with pytest.raises(cx.SpecError, match="not a plain identifier"):
            cx.projection_relation(spec, "door_id")


# ── The aggregate the headline is printed from ───────────────────────────────


class TestTheTotals:
    def _mixed(self) -> list[dict]:
        """One correlation per hardware answer: no, yes, undetermined."""
        def blocked(key: str, kind: str) -> dict:
            gap = {
                "kind": kind,
                "needs_new_hardware": cx.GAP_KINDS[kind].needs_new_hardware,
                "summary": "", "remedy": "", "where": None, "gate": "",
            }
            return {
                "key": key, "version": 1, "name": key, "question": "", "unlocks": "",
                "domains": ["a", "b"], "scope": "platform", "effective_from": NOW,
                "state": "blocked",
                "signals": [{"key": "s", "satisfied": False, "gap": gap}],
                "blocking_gap": {"signal": "s", **gap},
            }

        return [
            blocked("free", "unit_unconfirmed"),
            blocked("also_free", "role_unbound"),
            blocked("costs", "point_absent"),
            blocked("unknown", "module_population_unknown"),
        ]

    def test_the_three_hardware_buckets_are_three_and_sum_to_the_gaps(self):
        totals = cx.totals(self._mixed())
        assert totals["blocking_gaps"] == 4
        assert totals["needs_new_hardware"] == 1
        assert totals["no_new_hardware_needed"] == 2
        assert totals["hardware_undetermined"] == 1
        assert (
            totals["needs_new_hardware"]
            + totals["no_new_hardware_needed"]
            + totals["hardware_undetermined"]
            == totals["blocking_gaps"]
        )

    def test_the_kind_breakdown_names_every_kind_it_counted(self):
        totals = cx.totals(self._mixed())
        assert totals["blocking_gaps_by_kind"] == {
            "module_population_unknown": 1,
            "point_absent": 1,
            "role_unbound": 1,
            "unit_unconfirmed": 1,
        }

    def test_the_signal_backlog_is_counted_apart_from_the_blockers(self):
        """A correlation with two unsatisfied signals is ONE thing to lead with
        and TWO things to fix. Reporting only the blockers would understate the
        backlog; reporting only the backlog would make the headline wrong."""
        db = FakeDb(
            defs=[
                definition(
                    "two_gaps",
                    signal("ambient", "point_unit", tag_pattern="^.*ambtemp$",
                           dimension="temperature"),
                    signal("load", "point_unit", tag_pattern="^.*sysload$"),
                )
            ],
            points=[point("1FYC1_AmbTemp"), point("1FYC1_SysLoad")],
        )
        (out,) = run(_resolve(db))
        totals = cx.totals([out])
        assert totals["blocking_gaps"] == 1
        assert totals["signal_gaps"] == 2
        assert totals["signal_gaps_needing_no_new_hardware"] == 2


# ── What may satisfy a signal ────────────────────────────────────────────────


class TestWhatCountsAsASignal:
    def test_an_explicitly_retired_point_is_absent_rather_than_silent(self):
        """Retirement is a STATEMENT, not a silence. An operator saying "this is
        gone" is different from a sensor going quiet, and only the second one is
        something to go and look at."""
        db = FakeDb(
            defs=[
                definition(
                    "retired_only",
                    signal("ambient", "point_unit", tag_pattern="^.*ambtemp$",
                           dimension="temperature"),
                    signal("load", "point_unit", tag_pattern="^.*sysload$"),
                )
            ],
            points=[
                point("1FYC1_AmbTemp", unit="degC", unit_source="operator", retired=True),
                point("1FYC1_SysLoad", unit="", unit_source="operator"),
            ],
        )
        (out,) = run(_resolve(db))
        assert out["signals"][0]["gap"]["kind"] == "point_absent"
        assert out["signals"][1]["satisfied"] is True
        # The predicate itself, not just its effect: the FakeDb filters retired
        # rows only because the statement carries this.
        (probe,) = [q for q in db.statements if "WITH probe(idx" in q]
        assert "p.retired_at IS NULL" in probe

    def test_the_thirty_day_retirement_horizon_is_not_what_decides_presence(self):
        """THE REGRESSION. This shipped, and it is the reason `signal_silent`
        exists.

        `queries.LIVE_POINT` reads "not retired, and seen within
        VE_READINGS_RETIRE_AFTER_DAYS (30)". An earlier version of the resolver
        applied it and a comment above the SQL claimed it meant "actually
        reporting". It does not: a point silent for twenty-nine days passes it.
        On this deployment every one of the twenty role bindings was last seen
        eight days before the window opened, while the estate as a whole was
        current to the minute — so chiller ΔT reported SATISFIED off two sensors
        that had measured nothing for eight days.

        Both halves are asserted, because either one alone can be got around: the
        horizon must be absent from the statement, AND a point inside the horizon
        but outside the window must not satisfy anything.
        """
        db = FakeDb(
            defs=[
                definition(
                    "eight_days_quiet",
                    signal("iwt", "point_role", role="inlet_water_temp",
                           candidate_tag_pattern="^.*iwt$"),
                    signal("owt", "point_role", role="outlet_water_temp",
                           candidate_tag_pattern="^.*owt$"),
                )
            ],
            points=[
                # Exactly the live estate: bound, unit-confirmed, un-retired,
                # comfortably inside a 30-day horizon, and measuring nothing.
                silent("1FKC2_IWT", unit="degC", unit_source="operator",
                       role="inlet_water_temp"),
                silent("1FKC2_OWT", unit="degC", unit_source="operator",
                       role="outlet_water_temp"),
            ],
        )
        (out,) = run(_resolve(db))
        (probe,) = [q for q in db.statements if "WITH probe(idx" in q]
        assert LIVE_POINT not in probe
        assert "make_interval" not in probe, (
            "the retirement horizon is back in the presence test; a point silent "
            "for 29 days would satisfy a correlation again"
        )
        assert out["state"] == "blocked"
        for sig in out["signals"]:
            assert sig["satisfied"] is False
            assert sig["gap"]["kind"] == "signal_silent"
            # Through the BOUND branch specifically. Without this the assertion
            # above is also satisfied by the candidate path (these tags match
            # their own candidate pattern), and deleting the bound-silent branch
            # would leave this test green.
            assert "are bound to role" in sig["gap"]["gate"]
            assert sig["gap"]["needs_new_hardware"] is None

    def test_presence_is_judged_over_the_window_the_answer_is_computed_over(self):
        """The second half of the same mismatch. The statement has to JOIN the
        readings inside the requested span and the span has to be bound — a
        signal "present" over a span nobody asked about is not present."""
        db = FakeDb(
            defs=[definition("windowed", signal("a", "point_live", tag_pattern="^x$"),
                             signal("b", "point_live", tag_pattern="^y$"))],
            points=[point("x"), point("y")],
        )
        run(_resolve(db))
        (probe,) = [q for q in db.statements if "WITH probe(idx" in q]
        assert "FROM readings rd" in probe
        assert "rd.ts >= :start" in probe and "rd.ts < :end" in probe

    def test_a_bound_role_is_found_by_role_and_never_by_tag(self):
        """The normal case on a real estate, not the exotic one: a gateway
        rebuild renames the tag and the operator's role follows the point (see
        `app/api/succession.py`). Probing the BOUND set by tag would report every
        such role as unbound and send an operator to re-bind what is already
        bound."""
        probes = cx.probes_for(
            signal("iwt", "point_role", role="inlet_water_temp",
                   candidate_tag_pattern="^.*iwt$")
        )
        assert probes["bound"].pattern is None
        assert probes["bound"].require_role is True
        assert probes["candidates"].pattern == "^.*iwt$"

        db = FakeDb(
            defs=[
                definition(
                    "renamed",
                    signal("iwt", "point_role", role="inlet_water_temp",
                           candidate_tag_pattern="^.*iwt$"),
                    signal("owt", "point_role", role="outlet_water_temp",
                           candidate_tag_pattern="^.*owt$"),
                )
            ],
            points=[
                # The role rode a rename: its tag matches no pattern anybody wrote.
                point("CHW_ENTERING_A", role="inlet_water_temp"),
                point("1FYC1_OWT", role="outlet_water_temp"),
            ],
        )
        (out,) = run(_resolve(db))
        assert [s["satisfied"] for s in out["signals"]] == [True, True]
        assert out["state"] == "live"

    def test_a_probe_reports_the_points_it_matched_so_it_can_be_disagreed_with(self):
        """A tag pattern is a probe and never an assertion. What keeps that true
        is that the matched points travel back — an operator checks the probe
        rather than trusting it."""
        verdict = cx.resolve_point_unit([point("1FYC1_AmbTemp")], "temperature")
        assert verdict["evidence"]["points"][0]["point_tag"] == "1FYC1_AmbTemp"
        assert verdict["evidence"]["points_matched"] == 1


# ── Tenancy ──────────────────────────────────────────────────────────────────


class TestTenantScope:
    def test_another_tenants_points_cannot_satisfy_this_tenants_signal(self):
        db = FakeDb(
            defs=[
                definition(
                    "scoped",
                    signal("ambient", "point_unit", tag_pattern="^.*ambtemp$",
                           dimension="temperature"),
                    signal("load", "point_unit", tag_pattern="^.*sysload$"),
                )
            ],
            points=[
                point("1FYC1_AmbTemp", tenant=T2, unit="degC", unit_source="operator"),
                point("1FYC1_SysLoad", tenant=T1, unit="", unit_source="operator"),
            ],
        )
        (out,) = run(_resolve(db, tenant=T1))
        assert out["signals"][0]["gap"]["kind"] == "point_absent"
        assert out["signals"][1]["satisfied"] is True

    def test_another_tenants_correlation_is_not_visible(self):
        db = FakeDb(
            defs=[
                definition("theirs", signal("a", "point_live", tag_pattern="^x$"),
                           signal("b", "point_live", tag_pattern="^y$"), tenant=T2),
                definition("ours", signal("a", "point_live", tag_pattern="^x$"),
                           signal("b", "point_live", tag_pattern="^y$"), tenant=T1),
            ],
        )
        out = run(_resolve(db, tenant=T1))
        assert [c["key"] for c in out] == ["ours"]

    def test_a_tenants_own_correlation_overrides_the_platform_default(self):
        """A platform row is a default, not a decree — identical to how the
        metric registry resolves a definition. Both surviving would resolve one
        key twice and render it twice."""
        db = FakeDb(
            defs=[
                definition("shared", signal("a", "point_live", tag_pattern="^x$"),
                           signal("b", "point_live", tag_pattern="^y$"), tenant=None),
                definition("shared", signal("a", "point_live", tag_pattern="^x$"),
                           signal("b", "point_live", tag_pattern="^y$"),
                           tenant=T1, version=3),
            ],
        )
        out = run(_resolve(db, tenant=T1))
        assert len(out) == 1
        assert out[0]["scope"] == "tenant"
        assert out[0]["version"] == 3

    def test_every_statement_carries_a_tenant_predicate(self):
        """The FakeDb filters by tenant only when the SQL it was handed actually
        says so, so this asserts the predicate is there AND that removing it is
        visible in the test above rather than silent."""
        db = FakeDb(
            defs=[
                definition(
                    "all_sources",
                    signal("a", "point_live", tag_pattern="^x$"),
                    signal("f", "site_fact", fact="emission_factor"),
                )
            ],
        )
        run(_resolve(db))
        for sql in db.statements:
            if "to_regclass" in sql:
                continue  # a catalogue lookup; it reads no tenant's rows
            assert "CAST(:tenant AS uuid)" in sql, sql[:200]

    async def _noop(self):  # pragma: no cover — keeps pytest-asyncio quiet
        return None


class TestTheRouteIsScopedByTheTokenAndNotTheRequest:
    """`_tenant()` reads the JWT claim. A `tenant_id` query parameter is not a
    thing this route has, so a caller cannot widen their own scope."""

    @pytest.mark.asyncio
    async def test_a_tenantless_ordinary_caller_is_refused_before_any_query(self, app):
        async with client(app) as c:
            resp = await c.get(
                f"{PREFIX}/bi/correlations",
                headers=auth(tenant_id=None, permissions=["bi.read"]),
            )
        # conftest's session raises on any use, so reaching the store would be a
        # 500 naming the attribute. The ValidationError proves the refusal came
        # first — a tenantless ordinary token must never fall through to the
        # super-admin's unfiltered view.
        assert resp.status_code == 422, resp.text[:300]
        assert "no tenant" in resp.text

    @pytest.mark.asyncio
    async def test_the_route_does_not_accept_a_tenant_parameter(self, app):
        from fastapi.routing import APIRoute

        (route,) = [
            rt
            for rt in _bi_routes(app)
            if isinstance(rt, APIRoute) and rt.path.endswith("/bi/correlations")
        ]
        names = {p.name for p in route.dependant.query_params}
        assert "tenant_id" not in names and "tenant" not in names, names


def _bi_routes(app):
    for route in app.routes:
        original = getattr(route, "original_router", None)
        if original is not None:
            yield from _bi_routes(original)
            continue
        yield route


# ── The seeds ────────────────────────────────────────────────────────────────

VERSIONS = (
    pathlib.Path(reporting.models.__file__).resolve().parent.parent
    / "migrations"
    / "versions"
)


def _migration() -> ast.Module:
    (path,) = VERSIONS.glob("0025_correlation_registry*.py")
    return ast.parse(path.read_text())


def _literal(tree: ast.Module, name: str):
    """A module-level literal, annotated or not — read from the SOURCE.

    `ast.literal_eval` and not an import, deliberately: importing the revision
    would run whatever it has come to depend on, and the thing under test is what
    the file SAYS, frozen, with no application code in the room.
    """
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == name for t in node.targets
        ):
            return ast.literal_eval(node.value)
        if (
            isinstance(node, ast.AnnAssign)
            and isinstance(node.target, ast.Name)
            and node.target.id == name
            and node.value is not None
        ):
            return ast.literal_eval(node.value)
    raise AssertionError(f"{name} not found in 0025")


class TestTheSeedsArePinned:
    """The 0018/0019/0020 lesson, which cost a fresh database its migration.

    Those revisions seeded by LOOPING over a module that grows, so each one began
    inserting a later revision's rows the moment somebody extended it — invisible
    on every existing deployment and fatal on a new one. Everything below is
    decidable from the source with no database, which is what lets it run on every
    change rather than at deploy.
    """

    def test_the_migration_was_found(self):
        """A wrong path makes every assertion below pass over an empty file."""
        assert VERSIONS.is_dir(), VERSIONS
        assert len(list(VERSIONS.glob("0025_correlation_registry*.py"))) == 1

    def test_the_rows_it_inserts_are_exactly_the_rows_it_pins(self):
        """What makes a fresh database and an existing one agree: the set of rows
        `alembic upgrade head` writes is a literal in the revision, so it cannot
        move underneath either of them."""
        tree = _migration()
        assert [tuple(s) for s in _literal(tree, "_SEEDS")] == [
            (row["key"], row["version"]) for row in _literal(tree, "_ROWS")
        ]

    def test_it_seeds_the_seven_cross_domain_questions(self):
        seeds = [tuple(s) for s in _literal(_migration(), "_SEEDS")]
        assert len(seeds) == 7
        assert len(set(seeds)) == 7
        assert {k for k, _ in seeds} == {
            "ambient_temp_vs_chiller_load",
            "chiller_delta_t_vs_plant_kw",
            "occupancy_vs_hvac_energy",
            "people_count_vs_fresh_air",
            "after_hours_access_vs_energy",
            "water_use_vs_occupancy",
            "dg_runtime_vs_scope1_carbon",
        }

    def test_the_revision_imports_nothing_that_can_grow(self):
        """0018's defect in one line. A revision that reads an application module
        is a revision that changes when the module does, and the only database
        that can notice is one that has never been migrated."""
        tree = _migration()
        offenders = [
            node.module
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom)
            and (node.module or "").split(".")[0] in {"reporting", "app", "kernel"}
        ]
        assert not offenders, offenders

    def test_every_seeded_signal_is_one_the_resolver_can_actually_answer(self):
        """A signal whose source has no resolver renders exactly like a real gap
        and can never be closed. An operator would go looking for a door that was
        never the problem."""
        for row in _literal(_migration(), "_ROWS"):
            for sig in row["signals"]:
                cx.validate_signal(sig)

    def test_every_seeded_correlation_really_crosses_a_domain_boundary(self):
        """The product claim. A one-domain "correlation" is a metric, and the
        metric registry already computes those."""
        for row in _literal(_migration(), "_ROWS"):
            assert len(set(row["domains"])) >= 2, row["key"]
            assert len({s["domain"] for s in row["signals"]}) >= 2, row["key"]

    def test_a_signal_source_outside_the_vocabulary_is_refused(self):
        with pytest.raises(cx.SpecError, match="closed vocabulary"):
            cx.validate_signal({"key": "x", "source": "vibes", "requires": {}})

    def test_a_requirement_the_resolver_would_ignore_is_refused(self):
        """A `requires` key nothing enforces is not a requirement — it is a
        sentence in a seed that reads like one."""
        with pytest.raises(cx.SpecError, match="would ignore"):
            cx.validate_signal(
                {"key": "x", "source": "point_live",
                 "requires": {"tag_pattern": "^x$", "minimum_samples": 40}}
            )

    def test_a_role_outside_the_role_vocabulary_is_refused(self):
        with pytest.raises(cx.SpecError, match="role vocabulary"):
            cx.validate_signal(
                {"key": "x", "source": "point_role", "requires": {"role": "vibes"}}
            )

    def test_a_bad_seed_fails_the_request_loudly_rather_than_reading_as_a_gap(self):
        db = FakeDb(
            defs=[definition("bad", signal("a", "vibes"), signal("b", "vibes"))]
        )
        with pytest.raises(cx.SpecError):
            run(_resolve(db))

    def test_the_seeded_patterns_match_tags_taken_off_the_live_estate(self):
        """A regex tested only against tags invented for the test is a regex
        tested against itself. Every tag below was read out of
        `neubit_reporting.points` on this deployment.
        """
        by_key = {row["key"]: row for row in _literal(_migration(), "_ROWS")}

        def pattern(key: str, sig: str, field: str = "tag_pattern") -> str:
            (s,) = [x for x in by_key[key]["signals"] if x["key"] == sig]
            return s["requires"][field]

        matches = [
            ("ambient_temp_vs_chiller_load", "ambient_temp", "1FYC1_AmbTemp"),
            ("ambient_temp_vs_chiller_load", "ambient_temp", "2FYorkChiller1_AmbTemp"),
            ("ambient_temp_vs_chiller_load", "chiller_load", "1FYC1_SysLoad"),
            ("ambient_temp_vs_chiller_load", "chiller_load", "5FYorkChiller1_SysLoad"),
            ("chiller_delta_t_vs_plant_kw", "plant_power", "1FYC1_EM_kW"),
            ("people_count_vs_fresh_air", "tfa_energy", "KWH"),
            ("dg_runtime_vs_scope1_carbon", "run_hours", "Run Hours"),
            ("dg_runtime_vs_scope1_carbon", "run_hours", "1FYorkChiller1_Run Hours"),
        ]
        for key, sig, tag in matches:
            assert re.search(pattern(key, sig), tag, re.I), (key, sig, tag)

        # The anchors are doing real work: the same meters publish both, and one
        # of them is a lifetime register rather than a power.
        refuses = [
            ("chiller_delta_t_vs_plant_kw", "plant_power", "2FYorkChiller1EM_kWh"),
            ("ambient_temp_vs_chiller_load", "ambient_temp", "AmbTemp_Setpoint"),
        ]
        for key, sig, tag in refuses:
            assert not re.search(pattern(key, sig), tag, re.I), (key, sig, tag)

        # And the candidate probe for water is the TOTALISER, never the rate: a
        # flow rate bound as a volume would make every water consumption a rate
        # summed as if it were a volume.
        water = pattern("water_use_vs_occupancy", "water_volume", "candidate_tag_pattern")
        assert re.search(water, "Cum_Flow", re.I)
        assert not re.search(water, "Flow Rate", re.I)
        assert not re.search(water, "Rev_Flow", re.I)


# ── The response the route actually returns ──────────────────────────────────


class TestTheResponseShape:
    def test_a_resolved_correlation_validates_against_the_declared_schema(self):
        """The route is typed; a field the resolver renamed would 500 at
        serialisation rather than here, which is the wrong place to find out."""
        from app.api.schemas import CorrelationRegistryResponse

        db = FakeDb(
            defs=[
                definition(
                    "shaped",
                    signal("ambient", "point_unit", tag_pattern="^.*ambtemp$",
                           dimension="temperature"),
                    signal("badges", "projection",
                           projection_key="access_events", key_column="door_id"),
                )
            ],
            points=[point("1FYC1_AmbTemp")],
            specs=[_spec("access_events", "door_id")],
            population={"rows_in_window": 0, "keys_in_window": 0,
                        "last_event_at": NOW - dt.timedelta(days=20)},
        )
        resolved = run(_resolve(db))
        body = CorrelationRegistryResponse(
            start=START, end=NOW, hours=168,
            totals=cx.totals(resolved), correlations=resolved,
        )
        (one,) = body.correlations
        assert one.state == "blocked"
        assert one.blocking_gap.signal == "ambient"
        assert one.blocking_gap.kind == "unit_unconfirmed"
        assert one.blocking_gap.needs_new_hardware is False
        assert one.signals[1].gap.kind == "module_unpopulated"
        assert body.totals.hardware_undetermined == 0

    def test_the_window_is_echoed_because_a_silence_is_about_a_window(self):
        """"The access stream published nothing" is meaningless without the span
        it published nothing over — and a signal absent over 7 days and present
        over 90 is a different answer to a different question."""
        start, end = r._window(None, NOW, cx.DEFAULT_WINDOW_HOURS)
        assert end - start == dt.timedelta(hours=168)
