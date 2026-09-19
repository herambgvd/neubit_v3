"""Following a role across a gateway RENAME: what it proposes, and what it refuses.

THE SHAPE UNDER TEST, measured on this deployment rather than imagined:
`point_roles` holds 20 rows; 19 join to a `points` row and not one of THOSE is on
a point that is still reporting (the twentieth has no point row at all — see
`TestARoleWhosePointDoesNotExist`, which is the count this header used to get
wrong by joining before counting). Every one was last seen on 5 or 11 September
while the device it sits on kept delivering under a different tag — the signature of a rebuild that
renamed the tag as well as re-keying the id:

    device `1F York Chiller01`
      point_tag `IWT`                degC, the role is bound here, dead 5 Sep
      point_tag `1FYorkChiller1_IWT` dead 5 Sep
      point_tag `1FYC1_IWT`          reporting, no role, no unit

Three generations of one sensor under three spellings. `ghost_groups` groups on
`(device_tag, point_tag)`, so it cannot see them — they are not duplicates of
anything — and that gap is what `app/api/succession.py` is.

The failures this file exists to catch are failures of RESTRAINT, the same kind
`test_ghost_collapse.py` catches for the collapse:

  * proposing a candidate on ANOTHER DEVICE, where `IWT` exists on every chiller
    in the building and the wrong one still computes a plausible ΔT;
  * proposing anything at all where the evidence is only corroborating — "same
    unit" is every temperature point on the chiller;
  * moving a role onto a point that already carries an operator's own, which
    would discard one of two human assertions with nothing saying which;
  * writing a succession without the role following it, or the role without the
    succession — either one looks like a completed move on every screen that
    reads the chain;
  * measuring "has stopped reporting" against the WALL CLOCK, which on an estate
    that is routinely between ingest runs empties and refills the worklist
    depending on nothing;
  * reaching across a tenant boundary at any point in any of it.

The database is SCRIPTED per statement, matched on a fragment the module itself
wrote (the `test_ghost_collapse` / `metric_fakes` pattern), so a statement this
feature should not have run is a loud failure naming it rather than an extra
round trip.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid

import pytest
from kernel.auth import Scope
from kernel.errors import ValidationError

from app.api import succession as sx
from app.api import router as r
from reporting import role_succession as rs

UTC = dt.timezone.utc
TENANT = uuid.UUID("11111111-2222-3333-4444-555555555555")

NOW = dt.datetime(2026, 9, 19, 12, 0, tzinfo=UTC)
LEADING = NOW - dt.timedelta(minutes=3)      # inside the device's grace window
STALE = NOW - dt.timedelta(days=14)          # a generation the rebuild left behind


def run(coro):
    return asyncio.run(coro)


# ── the scripted database ────────────────────────────────────────────────────


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def all(self):
        return list(self._rows)


#: Statement name -> a fragment of the module's own SQL that identifies it.
#: `orphans` and `pool` share the clock CTE, so they are told apart by the join
#: that differs: the orphan set LEFT JOINs the clock (a role on a point with no
#: device tag still has to come back), the candidate pool inner-joins it and is
#: bounded by the device list.
#:
#: `missing` (the roles whose `points` row is gone entirely) is told apart by its
#: anti-join, and `forgettable` / `forget` by the column and the guard only they
#: have — all three touch `point_roles` and two of them LEFT JOIN `points`, so a
#: looser fragment would match the wrong statement and script the wrong rows.
_FRAGMENTS = {
    "orphans": "LEFT JOIN clock c",
    "pool": "p.device_tag = ANY(CAST(:devices AS text[]))",
    "missing": "AND p.point_id IS NULL",
    "endpoints": "p.point_id = ANY(CAST(:pids AS uuid[]))",
    "record": "SET superseded_by = CAST(:successor AS uuid)",
    "inherit": "WITH donor AS (",
    "forgettable": "p.point_id IS NOT NULL AS point_exists",
    "forget": "NOT EXISTS (SELECT 1 FROM points p",
}


class ScriptedDb:
    """Rows per statement; anything unscripted is an AssertionError naming it.

    Records the params too — the tenant bind IS a parameter, so "is this
    tenant-scoped" cannot be asked any other way without a real database.
    """

    def __init__(self, **script):
        unknown = set(script) - set(_FRAGMENTS)
        if unknown:
            raise AssertionError(f"no such scripted query: {sorted(unknown)}")
        # `missing` defaults to empty rather than being required. Unlike every
        # other statement here it runs on EVERY orphans call — an anti-join that
        # returns nothing is the normal case — so demanding that each test script
        # it would say nothing about restraint and only add noise. A test that
        # cares passes rows; the rest assert the same things they always did.
        script.setdefault("missing", [])
        self.script = script
        self.asked: list[str] = []
        self.params: list[tuple[str, dict]] = []
        self.commits = 0
        self.rollbacks = 0

    async def execute(self, clause, params=None):
        sql = str(clause)
        for name, frag in _FRAGMENTS.items():
            if frag in sql:
                if name not in self.script:
                    raise AssertionError(
                        f"the feature ran the `{name}` statement, which this test "
                        f"did not script"
                    )
                self.asked.append(name)
                self.params.append((name, dict(params or {})))
                return _Result(self.script[name])
        raise AssertionError(f"unrecognised statement: {' '.join(sql.split())[:160]}")

    async def commit(self):
        self.commits += 1

    async def rollback(self):
        self.rollbacks += 1

    def wrote(self) -> list[str]:
        """Only the statements that CHANGE something."""
        return [a for a in self.asked if a in ("record", "inherit")]


DEVICE = "1F York Chiller01"


def orphan_row(
    point_id,
    *,
    role="inlet_water_temp",
    device=DEVICE,
    tag="IWT",
    unit="degC",
    kind="num",
    last_seen=STALE,
    retired=False,
    device_last_seen=LEADING,
) -> dict:
    """One row as `_ORPHAN_ROLES_SQL` returns it."""
    return {
        "role": role,
        "role_source": "operator",
        "confirmed_by": "ops@example.test",
        "confirmed_at": NOW - dt.timedelta(days=20),
        "point_id": point_id,
        "device_tag": device,
        "point_tag": tag,
        "unit": unit,
        "type": kind,
        "category": "hvac",
        "last_seen_at": last_seen,
        "retired": retired,
        "fresh": False,
        "device_last_seen_at": device_last_seen,
    }


def pool_row(
    point_id,
    *,
    device=DEVICE,
    tag="1FYC1_IWT",
    unit=None,
    kind="num",
    last_seen=LEADING,
    current_role=None,
) -> dict:
    """One row as `_LEADING_EDGE_SQL` returns it."""
    return {
        "point_id": point_id,
        "device_tag": device,
        "point_tag": tag,
        "unit": unit,
        "type": kind,
        "category": "hvac",
        "last_seen_at": last_seen,
        "fresh": False,
        "device_last_seen_at": LEADING,
        "current_role": current_role,
    }


# ── the three-generation shape ───────────────────────────────────────────────


class TestTheRenameShape:
    def test_the_reporting_generation_is_proposed_and_the_dead_one_is_not(self):
        """THE REAL CASE. Three spellings of one sensor: the role sits on the
        oldest, a second dead generation sits beside it, and only the third is at
        the device's leading edge. A worklist that offered the dead sibling — or
        the orphan itself — would be offering a human the same broken binding
        back."""
        bound, gen2, live = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            orphans=[orphan_row(bound, tag="IWT")],
            # `gen2` is NOT in the pool: the pool statement is bounded by the
            # device's leading edge, and a generation dead since 5 Sep is behind
            # it. `bound` IS in the pool only because a point with a role can be
            # at the leading edge on another device — here it is filtered out in
            # Python, which is what this asserts.
            pool=[
                pool_row(live, tag="1FYC1_IWT"),
                pool_row(bound, tag="IWT", last_seen=STALE),
            ],
        )
        out = run(sx.orphan_roles(db, TENANT))
        assert out["total"] == 1
        entry = out["orphans"][0]
        assert entry["point_tag"] == "IWT"
        assert entry["orphan_reason"] == "superseded"
        assert [c["point_id"] for c in entry["candidates"]] == [live]
        assert gen2 not in {c["point_id"] for c in entry["candidates"]}

    def test_the_tail_of_the_tag_is_what_carries_the_match(self):
        """`IWT` → `1FYC1_IWT` is the whole rename, and the only thing the two
        spellings share is the last token. This estate prefixes device identity
        onto the measurement and leaves the measurement last — if the scorer read
        the tags as whole strings it would find nothing on any of the 13 orphans
        that have a successor."""
        bound, live = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            orphans=[orphan_row(bound, tag="IWT")],
            pool=[pool_row(live, tag="1FYC1_IWT")],
        )
        entry = run(sx.orphan_roles(db, TENANT))["orphans"][0]
        kinds = {e["kind"] for e in entry["candidates"][0]["evidence"]}
        assert "measurement_tail" in kinds

    def test_every_signal_that_scored_comes_back_as_a_sentence(self):
        """The evidence IS the output. A score an operator cannot check is a
        number they must not act on, and this whole feature is a proposal."""
        bound, live = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            orphans=[orphan_row(bound, tag="IWT")],
            pool=[pool_row(live, tag="1FYC1_IWT", unit="degC")],
        )
        candidate = run(sx.orphan_roles(db, TENANT))["orphans"][0]["candidates"][0]
        assert candidate["score"] == sum(e["weight"] for e in candidate["evidence"])
        for item in candidate["evidence"]:
            assert set(item) == {"kind", "weight", "detail"}
            assert len(item["detail"]) > 20, item


# ── scoring ──────────────────────────────────────────────────────────────────


class TestScoringOrder:
    def test_an_unchanged_tag_outranks_a_shared_measurement_tail(self):
        """A rebuild that re-keyed WITHOUT renaming is the strongest thing a tag
        can say — it is the same spelling. A shared tail is weaker: `1FYC1_IWT`
        and `1FYC2_IWT` both end in `iwt` and are different sensors."""
        bound, same, tail = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            orphans=[orphan_row(bound, tag="1FKC2_IWT")],
            pool=[
                pool_row(tail, tag="1FYC1_IWT"),
                pool_row(same, tag="1FKC2_IWT"),
            ],
        )
        ranked = run(sx.orphan_roles(db, TENANT))["orphans"][0]["candidates"]
        assert [c["point_id"] for c in ranked] == [same, tail]
        assert ranked[0]["score"] > ranked[1]["score"]

    def test_a_tie_is_broken_by_the_tag_and_never_by_recency(self):
        """Ordering ties by `last_seen_at` would quietly answer the question the
        tie is asking. Every point on a live device reported recently; which one
        did so most recently is not evidence about which sensor it is. The
        alphabetical key is arbitrary AND LOOKS IT, which is the intent."""
        bound, older, newer = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            orphans=[orphan_row(bound, tag="IWT")],
            pool=[
                # The more recent reading is on the tag that sorts LAST.
                pool_row(newer, tag="ZZ_IWT", last_seen=NOW),
                pool_row(older, tag="AA_IWT", last_seen=LEADING),
            ],
        )
        ranked = run(sx.orphan_roles(db, TENANT))["orphans"][0]["candidates"]
        assert [c["score"] for c in ranked] == [ranked[0]["score"]] * 2
        assert [c["point_tag"] for c in ranked] == ["AA_IWT", "ZZ_IWT"]

    def test_the_devices_own_name_is_not_evidence_about_the_measurement(self):
        """`1FYC1` is on every tag of `1F York Chiller01`, so it separates
        nothing — every candidate has it, and counting it would add the same
        number to all of them while reading, in the evidence, like a reason.

        Asserted on the evidence rather than on the ranking on purpose: a signal
        that fires for every candidate does not change the ORDER, so an ordering
        test could never catch it. What it changes is what the screen tells a
        human the score was for."""
        bound, same = uuid.uuid4(), uuid.uuid4()
        siblings = [pool_row(uuid.uuid4(), tag=f"1FYC1_{m}")
                    for m in ("OWT", "AmbTemp", "SysLoad", "Run Hours")]
        db = ScriptedDb(
            orphans=[orphan_row(bound, tag="1FYC1_IWT")],
            pool=siblings + [pool_row(same, tag="1FYC1_IWT")],
        )
        entry = run(sx.orphan_roles(db, TENANT))["orphans"][0]
        assert entry["candidates_considered"] == 5
        # Only the re-keyed twin is credible; the four other measurements on the
        # same device share nothing but the device's own name.
        assert [c["point_id"] for c in entry["candidates"]] == [same]
        assert {e["kind"] for e in entry["candidates"][0]["evidence"]} == {
            "identical_tag", "role_convention",
        }


class TestNothingCredible:
    def test_a_unit_match_alone_proposes_nothing(self):
        """Every temperature point on a chiller reads degC. A candidate whose
        only evidence is the unit is "one of these four, pick one", and offering
        it with a score printed beside it makes a coin toss look like a finding."""
        bound = uuid.uuid4()
        db = ScriptedDb(
            orphans=[orphan_row(bound, tag="IWT", unit="degC")],
            pool=[pool_row(uuid.uuid4(), tag="AmbTemp", unit="degC")],
        )
        entry = run(sx.orphan_roles(db, TENANT))["orphans"][0]
        assert entry["candidates"] == []
        assert entry["candidates_considered"] == 1

    def test_no_successor_found_is_reported_as_an_answer_not_an_empty_screen(self):
        """"Nothing here is credible" and "this screen did not run" must not look
        the same. `candidates_considered` is how many points were LOOKED at."""
        bound = uuid.uuid4()
        db = ScriptedDb(
            orphans=[orphan_row(bound, tag="IWT")],
            pool=[pool_row(uuid.uuid4(), tag="Work_Mode"),
                  pool_row(uuid.uuid4(), tag="Freq_Hz")],
        )
        out = run(sx.orphan_roles(db, TENANT))
        assert out["without_candidates"] == 1
        assert out["with_candidates"] == 0
        assert out["orphans"][0]["candidates_considered"] == 2

    def test_a_text_point_can_never_succeed_a_numeric_role(self):
        """Not weak evidence — a different kind of value. A scorer that could be
        talked round to it by three string matches is one bad tag away from
        binding a status flag into a chiller efficiency."""
        bound = uuid.uuid4()
        db = ScriptedDb(
            orphans=[orphan_row(bound, tag="IWT", kind="num")],
            pool=[pool_row(uuid.uuid4(), tag="1FYC1_IWT", kind="txt")],
        )
        entry = run(sx.orphan_roles(db, TENANT))["orphans"][0]
        assert entry["candidates"] == []
        assert entry["candidates_considered"] == 0


# ── the same-device rule ─────────────────────────────────────────────────────


class TestSameDeviceOnly:
    def test_the_candidate_pool_is_joined_on_the_device(self):
        """The proposal side of the rule. `IWT` is on every chiller in the
        building; a pool not bounded by the device would rank 2F's sensor for 1F's
        role, and the resulting ΔT would be plausible and wrong."""
        sql = str(sx._LEADING_EDGE_SQL)
        assert "p.device_tag = ANY(CAST(:devices AS text[]))" in sql
        assert "c.device_tag = p.device_tag" in sql

    def test_a_cross_device_move_is_refused_and_nothing_is_written(self):
        """THE GUARD, and it is enforced HERE and not only in the proposal: the
        worklist is not what the operator posts back, ids are, and a rule that
        lives only in the read path is not a rule."""
        src, dst = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            endpoints=[
                {"point_id": src, "device_tag": "1F York Chiller01",
                 "point_tag": "IWT", "last_seen_at": STALE, "retired": False,
                 "superseded_by": None, "current_role": "inlet_water_temp"},
                {"point_id": dst, "device_tag": "2F York Chiller01",
                 "point_tag": "2FYC1_IWT", "last_seen_at": LEADING,
                 "retired": False, "superseded_by": None, "current_role": None},
            ],
        )
        out = run(sx.repoint_roles(db, TENANT, moves=[
            {"role": "inlet_water_temp", "from_point_id": src, "to_point_id": dst},
        ]))
        assert out["moved"] == 0
        assert out["refused"] == 1
        assert "same device" in out["results"][0]["reason"]
        assert db.wrote() == []

    def test_a_point_that_is_its_own_successor_is_refused(self):
        """A self-succession would write `superseded_by` pointing at the row
        itself — a cycle in the continuity chain that every history walk would
        follow forever."""
        src = uuid.uuid4()
        db = ScriptedDb()
        out = run(sx.repoint_roles(db, TENANT, moves=[
            {"role": "inlet_water_temp", "from_point_id": src, "to_point_id": src},
        ]))
        assert out["refused"] == 1
        assert "cannot succeed itself" in out["results"][0]["reason"]
        assert db.asked == []


# ── applying a move ──────────────────────────────────────────────────────────


def _endpoints(src, dst, *, src_role="inlet_water_temp", dst_role=None,
               dst_retired=False, device=DEVICE) -> list[dict]:
    return [
        {"point_id": src, "device_tag": device, "point_tag": "IWT",
         "last_seen_at": STALE, "retired": False, "superseded_by": None,
         "current_role": src_role},
        {"point_id": dst, "device_tag": device, "point_tag": "1FYC1_IWT",
         "last_seen_at": LEADING, "retired": dst_retired, "superseded_by": None,
         "current_role": dst_role},
    ]


class TestTheMove:
    def test_the_succession_is_recorded_and_the_role_follows_it(self):
        """Both, in one transaction. A succession with the role still on the dead
        point looks like a completed move on every screen that reads the chain;
        the role moved with nothing recording why is a rebinding with no
        provenance."""
        src, dst = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            endpoints=_endpoints(src, dst),
            record=[{"point_id": src}],
            inherit=[{"donor_id": src, "heir_id": dst, "role": "inlet_water_temp"}],
        )
        out = run(sx.repoint_roles(db, TENANT, moves=[
            {"role": "inlet_water_temp", "from_point_id": src, "to_point_id": dst},
        ]))
        assert out["moved"] == 1
        assert out["results"][0]["status"] == "moved"
        assert db.asked == ["endpoints", "record", "inherit"]
        assert db.commits == 1 and db.rollbacks == 0
        assert dict(db.params)["record"] == {
            "predecessor": str(src), "successor": str(dst), "tenant": str(TENANT),
        }

    def test_the_role_move_goes_through_the_shared_reconcile(self):
        """Not an INSERT of its own. The writer runs the SAME statement when a
        superseded point's successor reports (`app/store.py`), and two paths that
        each had their own idea of what a succession does would drift."""
        src, dst = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            endpoints=_endpoints(src, dst),
            record=[{"point_id": src}],
            inherit=[{"donor_id": src, "heir_id": dst, "role": "inlet_water_temp"}],
        )
        run(sx.repoint_roles(db, TENANT, moves=[
            {"role": "inlet_water_temp", "from_point_id": src, "to_point_id": dst},
        ]))
        assert "inherit" in db.asked
        assert dict(db.params)["inherit"]["point_ids"] == [str(dst)]

    def test_the_move_writes_no_retirement(self):
        """The one place this diverges visibly from the collapse. A renamed
        generation stops being counted by the `last_seen_at` horizon on its own;
        retiring it here is a second decision nobody asked for — and
        `retire_reason = 'ghost'` would put the row inside the reach of an undo
        built for a different operation."""
        sql = str(sx._RECORD_SUCCESSION_SQL)
        assert "retired_at" not in sql
        assert "retire_reason" not in sql

    def test_a_role_that_moved_underneath_the_request_stops_the_move(self):
        """The worklist goes stale between the GET and the POST. Applying anyway
        would rebind something the operator never saw."""
        src, dst = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(endpoints=_endpoints(src, dst, src_role="active_power"))
        out = run(sx.repoint_roles(db, TENANT, moves=[
            {"role": "inlet_water_temp", "from_point_id": src, "to_point_id": dst},
        ]))
        assert out["refused"] == 1
        assert "no longer carries" in out["results"][0]["reason"]
        assert db.wrote() == []

    def test_a_retired_successor_is_refused(self):
        """A retired point is not part of the estate. Binding what a number MEANS
        to one is binding it to nothing."""
        src, dst = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(endpoints=_endpoints(src, dst, dst_retired=True))
        out = run(sx.repoint_roles(db, TENANT, moves=[
            {"role": "inlet_water_temp", "from_point_id": src, "to_point_id": dst},
        ]))
        assert "retired" in out["results"][0]["reason"]
        assert db.wrote() == []

    def test_one_stale_move_does_not_discard_the_rest_of_the_worklist(self):
        """One transaction per move, on purpose. These are independent decisions
        about different measurements — `collapse_ghosts` validates its whole batch
        first because a bad survivor there would RETIRE every member of its group,
        and the worst a bad move does here is be refused."""
        a1, a2, b1, b2 = (uuid.uuid4() for _ in range(4))
        db = ScriptedDb(
            endpoints=_endpoints(a1, a2),   # every lookup answers with this pair
            record=[{"point_id": a1}],
            inherit=[{"donor_id": a1, "heir_id": a2, "role": "inlet_water_temp"}],
        )
        out = run(sx.repoint_roles(db, TENANT, moves=[
            # Refused: neither id is in the scripted endpoint rows.
            {"role": "inlet_water_temp", "from_point_id": b1, "to_point_id": b2},
            {"role": "inlet_water_temp", "from_point_id": a1, "to_point_id": a2},
            # Refused too, and AFTER the good one — a batch that stopped at the
            # first refusal and a batch that discarded everything after it look
            # identical unless a good move is sandwiched between two bad ones.
            {"role": "inlet_water_temp", "from_point_id": a1, "to_point_id": a1},
        ]))
        assert out["requested"] == 3
        assert out["moved"] == 1
        assert out["refused"] == 2
        assert [x["status"] for x in out["results"]] == ["refused", "moved", "refused"]
        # Exactly one move reached the database, and it committed on its own.
        assert db.wrote() == ["record", "inherit"]
        assert db.commits == 1

    def test_a_move_that_writes_nothing_is_rolled_back_rather_than_reported_done(self):
        """The points changed between the checks and the write — a concurrent
        repoint, a role that appeared on the successor. A succession recorded with
        the role still on the dead point is the worst outcome available: it looks
        like a completed move to everything that reads the chain."""
        src, dst = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            endpoints=_endpoints(src, dst),
            record=[{"point_id": src}],
            inherit=[],                       # the reconcile moved nothing
        )
        out = run(sx.repoint_roles(db, TENANT, moves=[
            {"role": "inlet_water_temp", "from_point_id": src, "to_point_id": dst},
        ]))
        assert out["moved"] == 0
        assert "nothing was written" in out["results"][0]["reason"]
        assert db.rollbacks == 1 and db.commits == 0


# ── the role conflict ────────────────────────────────────────────────────────


class TestRoleConflict:
    def test_a_successor_carrying_a_different_role_refuses_the_whole_move(self):
        """`point_roles` is keyed by `point_id` ALONE, so one of the two
        assertions would have to go and BOTH are an operator's.

        THIS DIVERGES FROM THE COLLAPSE, DELIBERATELY. A collapse reports
        `roles_discarded` and lets the survivor's own role win, which is
        defensible there: the caller asked to settle a GROUP and the survivor is
        by definition the row still reporting. Here the caller named this one
        successor for this one role, so discarding either side is discarding what
        they explicitly asked for."""
        src, dst = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(endpoints=_endpoints(src, dst, dst_role="outlet_water_temp"))
        out = run(sx.repoint_roles(db, TENANT, moves=[
            {"role": "inlet_water_temp", "from_point_id": src, "to_point_id": dst},
        ]))
        assert out["moved"] == 0
        assert out["results"][0]["conflicting_role"] == "outlet_water_temp"
        assert "different role" in out["results"][0]["reason"]
        assert db.wrote() == []

    def test_a_successor_already_carrying_THIS_role_says_so_rather_than_moving(self):
        """Told apart from the conflict above because it is a different fact: the
        binding the operator wants already exists, and reporting it as "a
        different role is in the way" would send them to clear the very role they
        asked for."""
        src, dst = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(endpoints=_endpoints(src, dst, dst_role="inlet_water_temp"))
        out = run(sx.repoint_roles(db, TENANT, moves=[
            {"role": "inlet_water_temp", "from_point_id": src, "to_point_id": dst},
        ]))
        assert "nothing to move" in out["results"][0]["reason"]
        assert db.wrote() == []

    def test_the_conflict_is_visible_on_the_worklist_before_anyone_posts(self):
        """A refusal an operator could have seen coming is a refusal that should
        never have been sent. The candidate carries the role that will block it."""
        bound, live = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            orphans=[orphan_row(bound, tag="IWT")],
            pool=[pool_row(live, tag="1FYC1_IWT", current_role="outlet_water_temp")],
        )
        candidate = run(sx.orphan_roles(db, TENANT))["orphans"][0]["candidates"][0]
        assert candidate["conflicting_role"] == "outlet_water_temp"


# ── the device clock ─────────────────────────────────────────────────────────


class TestOrphanedIsMeasuredAgainstTheDevice:
    def test_the_orphan_test_compares_the_point_to_its_device_not_to_now(self):
        """THE MEASURED REASON. At the time of writing `max(last_seen_at)` across
        this whole estate is ~4.8 hours old — ingest is between runs and ZERO of
        the 766 live points are inside the 15-minute window. Under a wall-clock
        test every role would be orphaned and no candidate would be live, so the
        feature would propose nothing on exactly the estate it exists for."""
        sql = str(sx._ORPHAN_ROLES_SQL)
        assert "c.device_last_seen_at - make_interval(mins => :grace)" in sql
        assert "p.last_seen_at" in sql
        # The comparison is STRICTLY against the clock. A `now()` anywhere in
        # the orphan predicate would reintroduce the wall clock through the
        # back door; the only `now()` in this statement is the `fresh` column,
        # which is reported and decides nothing.
        assert sql.count("now()") == 1

    def test_a_device_that_has_gone_entirely_dark_orphans_nothing(self):
        """Its role point is still at the device's leading edge, so nothing
        superseded it — the inverter stopped. Six of this deployment's 19 role
        rows (`4F_Solar_Panel01..03`) are exactly this, and proposing a successor
        for them would be proposing a replacement for a device that is simply
        off. That is a liveness question, not a rebinding one."""
        sql = str(sx._ORPHAN_ROLES_SQL)
        # The clock is the max over the device's OWN unretired points, so a dark
        # device's maximum is its own role point and the strict `<` cannot fire.
        assert "max(p.last_seen_at) AS device_last_seen_at" in str(sx._CLOCK_CTE)
        assert "c.device_last_seen_at IS NOT NULL" in sql

    def test_a_retired_point_is_orphaned_whatever_the_clock_says(self):
        """A retired point is not part of the estate, so a role on it cannot be
        selecting anything — and it will be at its device's leading edge exactly
        when the device is dark, which the clock test alone would let through."""
        bound = uuid.uuid4()
        db = ScriptedDb(
            orphans=[orphan_row(bound, retired=True, last_seen=LEADING)],
            pool=[pool_row(uuid.uuid4(), tag="1FYC1_IWT")],
        )
        entry = run(sx.orphan_roles(db, TENANT))["orphans"][0]
        assert entry["orphan_reason"] == "retired"


# ── the tenant boundary ──────────────────────────────────────────────────────


class TestTenantScope:
    def test_every_statement_the_feature_runs_carries_the_tenant(self):
        """The bind is filled from the JWT by the router and never from the
        request. A statement that drops it reaches every tenant's points."""
        bound, live = uuid.uuid4(), uuid.uuid4()
        read = ScriptedDb(
            orphans=[orphan_row(bound, tag="IWT")],
            pool=[pool_row(live, tag="1FYC1_IWT")],
        )
        run(sx.orphan_roles(read, TENANT))
        write = ScriptedDb(
            endpoints=_endpoints(bound, live),
            record=[{"point_id": bound}],
            inherit=[{"donor_id": bound, "heir_id": live, "role": "inlet_water_temp"}],
        )
        run(sx.repoint_roles(write, TENANT, moves=[
            {"role": "inlet_water_temp", "from_point_id": bound, "to_point_id": live},
        ]))
        assert read.params and write.params
        for name, params in read.params + write.params:
            assert params.get("tenant") == str(TENANT), name

    def test_every_statement_declares_the_predicate_the_bind_feeds(self):
        """A bind nothing compares against is scoping that does not happen."""
        for sql in (
            sx._ORPHAN_ROLES_SQL,
            sx._LEADING_EDGE_SQL,
            sx._MOVE_ENDPOINTS_SQL,
            sx._RECORD_SUCCESSION_SQL,
            rs._INHERIT_SQL,
        ):
            assert "CAST(:tenant AS uuid) IS NULL OR" in str(sql), str(sql)[:120]

    def test_another_tenants_point_cannot_be_named_as_a_successor(self):
        """The endpoints are read INSIDE the tenant, so another tenant's point is
        simply not in the rows — "I cannot find it" and "it is not yours" are the
        same refusal, which is what stops this route being a probe for other
        tenants' point ids."""
        src, theirs = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            endpoints=[{
                "point_id": src, "device_tag": DEVICE, "point_tag": "IWT",
                "last_seen_at": STALE, "retired": False, "superseded_by": None,
                "current_role": "inlet_water_temp",
            }],
        )
        out = run(sx.repoint_roles(db, TENANT, moves=[
            {"role": "inlet_water_temp", "from_point_id": src, "to_point_id": theirs},
        ]))
        assert out["refused"] == 1
        assert "not in this tenant" in out["results"][0]["reason"]
        assert db.wrote() == []

    def test_a_platform_superadmin_passes_null_rather_than_a_tenant(self):
        """The same semantics every other query here has: None means no filter,
        and it can only come from a token with no tenant claim."""
        bound, live = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            orphans=[orphan_row(bound, tag="IWT")],
            pool=[pool_row(live, tag="1FYC1_IWT")],
        )
        run(sx.orphan_roles(db, None))
        assert all(params.get("tenant") is None for _, params in db.params)


# ── the self-heal ────────────────────────────────────────────────────────────


class TestInheritAcrossASuccession:
    def test_it_refuses_a_heir_that_already_carries_a_role(self):
        """THE NO-CLOBBER RULE, and the whole of it. A heir with a role is an
        operator's own assertion about the point that replaced the old one; an
        older generation's binding may not speak over it. Without this the writer
        would silently rebind a live point on the next reading."""
        sql = str(rs._INHERIT_SQL)
        assert "NOT EXISTS" in sql
        assert "FROM point_roles h WHERE h.point_id = heir.point_id" in sql
        assert "ON CONFLICT (point_id) DO NOTHING" in sql

    def test_it_moves_the_role_rather_than_copying_it(self):
        """Two live points carrying `inlet_water_temp` on one chiller makes every
        metric that selects the role ambiguous, and nothing downstream could tell
        which number it got. The delete is guarded by the insert's RETURNING, so a
        donor whose role did NOT land keeps its binding."""
        sql = str(rs._INHERIT_SQL)
        assert "DELETE FROM point_roles r" in sql
        assert "USING donor d, placed pl" in sql
        assert "pl.point_id = d.heir_id" in sql

    def test_it_carries_the_operators_assertion_verbatim(self):
        """`confirmed_by` rewritten to something like "system" would erase who
        actually decided what the number means. It is the SAME assertion moved
        onto the row that now carries the measurement."""
        sql = str(rs._INHERIT_SQL)
        assert "d.role, d.role_source,\n               d.confirmed_by, d.confirmed_at" in sql

    def test_the_newest_assertion_wins_when_several_successions_name_one_heir(self):
        """At most one can land — `point_roles` is keyed by point alone. Ghost
        collapse's `_MIGRATE_ROLE_SQL` makes the identical choice with
        `ORDER BY r.confirmed_at DESC LIMIT 1`, and the two must not disagree."""
        sql = str(rs._INHERIT_SQL)
        assert "DISTINCT ON (heir.point_id)" in sql
        assert "ORDER BY heir.point_id, r.confirmed_at DESC" in sql

    def test_the_tenant_boundary_is_in_the_join_not_only_in_the_bind(self):
        """The writer calls this with the points of one BATCH, and a batch is
        whatever came off `tenant.*.iot.reading.>` — several tenants at a time. It
        has no single tenant to pass, so the isolation cannot depend on one."""
        assert "g.tenant_id = heir.tenant_id" in str(rs._INHERIT_SQL)

    def test_an_empty_scope_never_touches_the_database(self):
        """A batch whose points were all duplicates upserts nothing, and a
        statement run over an empty array is a round trip that can only return
        nothing."""
        class _NeverTouched:
            def __getattr__(self, name):
                raise AssertionError(f"the database was used (session.{name})")

        assert run(rs.inherit_roles(_NeverTouched(), TENANT, point_ids=[])) == []


# ── the writer path ──────────────────────────────────────────────────────────


class _WriterSession:
    """Just enough session for `store.write_batch`, recording what it ran.

    Statements are told apart by shape rather than by fragment: the readings
    insert and the points upsert are ORM constructs, the two reconciles are
    textual. A statement that reaches here unrecognised is a loud failure, which
    is what makes "the writer ran the inherit" an assertion rather than a hope.
    """

    def __init__(self, landed, inherited=()):
        self.landed = landed
        self.inherited = list(inherited)
        self.asked: list[str] = []
        self.params: list[dict] = []
        self.commits = 0

    async def execute(self, clause, params=None):
        sql = str(clause)
        if "INSERT INTO readings" in sql:
            self.asked.append("readings")
            return _ScalarResult(self.landed)
        if "INSERT INTO points" in sql:
            self.asked.append("points")
            return _ScalarResult([])
        if "SET site_id" in sql:
            self.asked.append("placement")
            return _RowcountResult()
        if "WITH donor AS (" in sql:
            self.asked.append("inherit")
            self.params.append(dict(params or {}))
            return _Result(self.inherited)
        raise AssertionError(f"unrecognised statement: {' '.join(sql.split())[:160]}")

    async def commit(self):
        self.commits += 1


class _ScalarResult:
    def __init__(self, values):
        self._values = values

    def scalars(self):
        return self

    def all(self):
        return list(self._values)


class _RowcountResult:
    rowcount = 0


def _reading(point_id, *, tag="1FYC1_IWT"):
    from app.envelope import ParsedReading

    return ParsedReading(
        ts=NOW, tenant_id=TENANT, point_id=point_id, num=7.5, txt=None, quality=192,
        conn_id=None, device_id=None, device_tag=DEVICE, point_tag=tag,
        unit=None, category="hvac", device_type=None, type="num", meta=None,
    )


class TestTheWriterHealsASuccession:
    def test_a_point_that_reports_inherits_the_role_a_succession_named_it_for(self):
        """The same shape as the placement inherit above it in `store.py`, and for
        the same reason: this writer creates the `points` row (contract §6), so it
        is the only thing that can notice a point coming into existence or
        starting to report again. A human should not have to repeat a binding they
        already recorded."""
        from app.store import PointCache, write_batch

        heir, donor = uuid.uuid4(), uuid.uuid4()
        session = _WriterSession(
            landed=[heir],
            inherited=[{"donor_id": donor, "heir_id": heir,
                        "role": "inlet_water_temp"}],
        )
        run(write_batch(session, [_reading(heir)], PointCache(60), 0.0))
        assert "inherit" in session.asked
        assert session.params[0]["point_ids"] == [str(heir)]

    def test_it_runs_after_the_upsert_and_inside_the_same_transaction(self):
        """AFTER, because a point reporting for the first time has no `points` row
        until the upsert writes it, so a succession naming it would match nothing.
        INSIDE, because the ack rule ("nothing is acked until it is durably
        written") has to cover a role that moved."""
        from app.store import PointCache, write_batch

        heir = uuid.uuid4()
        session = _WriterSession(landed=[heir])
        run(write_batch(session, [_reading(heir)], PointCache(60), 0.0))
        assert session.asked.index("points") < session.asked.index("inherit")
        assert session.commits == 1

    def test_a_batch_that_stored_nothing_moves_no_role(self):
        """A replayed retained message stores nothing BY DESIGN — its
        `(point_id, ts)` is already there. It must not be able to move what a
        number means, for exactly the reason it must not move `last_seen_at`."""
        from app.store import PointCache, write_batch

        session = _WriterSession(landed=[])
        run(write_batch(session, [_reading(uuid.uuid4())], PointCache(60), 0.0))
        assert "inherit" not in session.asked


# ── the routes' own refusals ─────────────────────────────────────────────────


class _NeverTouched:
    """A database that fails if a refused request reaches it."""

    def __getattr__(self, name):
        raise AssertionError(f"the request reached the database (session.{name})")


SCOPE = Scope(tenant_id=TENANT, is_superadmin=False)


class TestTheRequestShape:
    def test_a_move_needs_all_three_of_role_from_and_to(self):
        """None of the three is inferred. A request that could omit the role would
        be asking the server to work out what it is moving."""
        for missing in ("role", "from_point_id", "to_point_id"):
            body = {"role": "inlet_water_temp",
                    "from_point_id": str(uuid.uuid4()),
                    "to_point_id": str(uuid.uuid4())}
            body.pop(missing)
            with pytest.raises(Exception):
                r.RoleMove(**body)

    def test_an_empty_move_list_is_refused_by_the_schema(self):
        """An empty batch that answered 200 would read as "applied" on a screen
        that sent nothing."""
        with pytest.raises(Exception):
            r.RepointRolesRequest(moves=[])

    def test_there_is_no_mode_and_no_threshold_on_the_request(self):
        """THE RULE THIS WHOLE FEATURE IS SHAPED BY. `CollapseGhostsRequest` has a
        bulk `mode` because "exactly one member is reporting" is provable. Nothing
        here is provable — a score is a ranking — so there is no field that could
        ask the server to apply one, and no threshold constant to set."""
        fields = set(r.RepointRolesRequest.model_fields)
        assert fields == {"moves"}
        assert not any(
            name.startswith(("_THRESHOLD", "AUTO_")) for name in dir(sx)
        )


# ── the assertion whose point is gone ────────────────────────────────────────


def missing_row(point_id, *, role="outlet_water_temp") -> dict:
    """One row as `_MISSING_POINT_ROLES_SQL` returns it — the assertion, and
    nothing else, because nothing else survived the point."""
    return {
        "role": role,
        "role_source": "operator",
        "confirmed_by": "ops@example.test",
        "confirmed_at": NOW - dt.timedelta(days=14),
        "point_id": point_id,
    }


class TestARoleWhosePointDoesNotExist:
    """THE ROW THE WORKLIST COULD NOT SHOW.

    `select count(*) from point_roles` says 20 on this deployment and the same
    count joined to `points` says 19. One row
    (`3089f793-…` / `outlet_water_temp`) names a point id with no dimension row at
    all — not retired, GONE — and the orphans query INNER JOINs `points`, so the
    most orphaned assertion on the estate was the one thing the worklist built to
    find orphans could never display.
    """

    def test_it_appears_with_its_own_reason_and_no_candidates(self):
        gone = uuid.uuid4()
        db = ScriptedDb(orphans=[], missing=[missing_row(gone)])
        out = run(sx.orphan_roles(db, TENANT))
        assert out["total"] == 1
        entry = out["orphans"][0]
        assert entry["point_id"] == gone
        assert entry["orphan_reason"] == "point_missing"
        assert entry["candidates"] == []
        # ZERO LOOKED AT, and that is the honest number: with no device tag there
        # is no candidate set to look at, and a search that roamed for a tag it
        # cannot read would be inventing a successor rather than proposing one.
        assert entry["candidates_considered"] == 0

    def test_whatever_is_left_of_the_operators_assertion_comes_back(self):
        """It is the only thing there is to show. Who said what a number meant,
        and when — the four columns that outlived the point."""
        gone = uuid.uuid4()
        db = ScriptedDb(orphans=[], missing=[missing_row(gone)])
        entry = run(sx.orphan_roles(db, TENANT))["orphans"][0]
        assert entry["role"] == "outlet_water_temp"
        assert entry["role_source"] == "operator"
        assert entry["confirmed_by"] == "ops@example.test"
        assert entry["confirmed_at"] == NOW - dt.timedelta(days=14)
        # Stated as null rather than omitted: a screen that reads `point_tag`
        # must get "there is no row to read it from", not a KeyError on this row
        # alone.
        for absent in ("device_tag", "point_tag", "unit", "category",
                       "last_seen_at", "device_last_seen_at"):
            assert absent in entry and entry[absent] is None, absent

    def test_it_is_not_reachable_from_the_statement_that_joins_points(self):
        """Why it needs a statement of its own, asserted on the SQL: the orphan
        set inner-joins the dimension, so no predicate added to it could ever
        return a role whose dimension row is missing."""
        assert "JOIN points p ON p.point_id = r.point_id" in str(sx._ORPHAN_ROLES_SQL)
        joined = str(sx._ORPHAN_ROLES_SQL).split("FROM point_roles r")[1]
        assert "LEFT JOIN" not in joined.split("LEFT JOIN clock")[0]
        missing_sql = str(sx._MISSING_POINT_ROLES_SQL)
        assert "LEFT JOIN points p" in missing_sql
        assert "p.point_id IS NULL" in missing_sql

    def test_the_counts_still_add_up_once_it_is_included(self):
        """`with_candidates + without_candidates == total`, with the missing-point
        row on the `without` side where it belongs and will always belong."""
        bound, live, gone = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            orphans=[orphan_row(bound, tag="IWT"),
                     orphan_row(uuid.uuid4(), tag="AmbTemp", role="ambient_temp")],
            pool=[pool_row(live, tag="1FYC1_IWT")],
            missing=[missing_row(gone)],
        )
        out = run(sx.orphan_roles(db, TENANT))
        assert out["total"] == 3
        assert out["with_candidates"] == 1
        assert out["without_candidates"] == 2
        assert out["with_candidates"] + out["without_candidates"] == out["total"]
        assert out["total"] == len(out["orphans"])
        # Last, like the NULL device tags in the statement above it: a worklist
        # reads device by device and a row that belongs to no device belongs at
        # the end of it.
        assert out["orphans"][-1]["point_id"] == gone

    def test_the_role_filter_reaches_it_like_any_other_orphan(self):
        """A screen filtered to one role must not silently drop the one row of
        that role it cannot join."""
        gone = uuid.uuid4()
        db = ScriptedDb(
            orphans=[],
            missing=[missing_row(gone, role="outlet_water_temp"),
                     missing_row(uuid.uuid4(), role="inlet_water_temp")],
        )
        out = run(sx.orphan_roles(db, TENANT, role="outlet_water_temp"))
        assert [o["point_id"] for o in out["orphans"]] == [gone]

    def test_it_is_scoped_by_the_only_tenant_column_left(self):
        """The point's `tenant_id` went with the point, so the scoping has to be
        on `point_roles.tenant_id` — and it has to be there, or this statement
        reaches every tenant's stranded assertions."""
        sql = str(sx._MISSING_POINT_ROLES_SQL)
        assert "CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid)" in sql
        db = ScriptedDb(orphans=[], missing=[])
        run(sx.orphan_roles(db, TENANT))
        assert dict(db.params)["missing"]["tenant"] == str(TENANT)


# ── forgetting an assertion ──────────────────────────────────────────────────


def forgettable_row(point_id, *, role="outlet_water_temp", exists=False) -> dict:
    """One row as `_FORGETTABLE_SQL` returns it."""
    return {
        "point_id": point_id,
        "role": role,
        "role_source": "operator",
        "confirmed_by": "ops@example.test",
        "confirmed_at": NOW - dt.timedelta(days=14),
        "point_exists": exists,
    }


class TestForgettingAnAssertion:
    def test_it_deletes_the_row_and_echoes_the_assertion_back(self):
        """The response is the last place the assertion exists — nothing here is
        soft-deleted and no self-heal puts it back."""
        gone = uuid.uuid4()
        db = ScriptedDb(
            forgettable=[forgettable_row(gone)],
            forget=[{"role": "outlet_water_temp"}],
        )
        out = run(sx.forget_roles(db, TENANT, point_ids=[gone]))
        assert out == {
            "requested": 1,
            "forgotten": 1,
            "refused": 0,
            "results": [{
                "point_id": gone,
                "status": "forgotten",
                "role": "outlet_water_temp",
                "role_source": "operator",
                "confirmed_by": "ops@example.test",
                "confirmed_at": NOW - dt.timedelta(days=14),
            }],
        }
        assert db.commits == 1

    def test_it_refuses_a_role_whose_point_exists(self):
        """THE WHOLE OF WHAT SEPARATES THIS FROM TWO OTHER OPERATIONS. A role on
        a point that is still there is moved by a repoint or cleared by an
        unbind; deleting it here would be a third operation nobody asked for, run
        by a route whose name says it only forgets what is gone."""
        alive = uuid.uuid4()
        db = ScriptedDb(forgettable=[forgettable_row(alive, exists=True)])
        out = run(sx.forget_roles(db, TENANT, point_ids=[alive]))
        assert out["forgotten"] == 0 and out["refused"] == 1
        assert "the point still exists" in out["results"][0]["reason"]
        # The delete was never even attempted — `forget` is unscripted above, so
        # running it would have been an AssertionError naming it.
        assert "forget" not in db.asked
        assert db.commits == 0

    def test_the_missing_point_condition_is_in_the_delete_and_not_only_in_python(self):
        """The check and the write are two statements, and the writer mints a
        `points` row for any id a reading arrives under — so a point CAN come
        back between them. A DELETE guarded only in Python would then erase an
        operator's assertion about a point that had just returned."""
        sql = str(sx._FORGET_ROLE_SQL)
        assert "NOT EXISTS (SELECT 1 FROM points p WHERE p.point_id = r.point_id)" in sql
        assert "RETURNING r.role" in sql

    def test_a_delete_that_touched_nothing_is_refused_rather_than_reported_as_done(self):
        """The race the guard above catches, from the caller's side: zero rows
        back means the point exists again or somebody forgot it first, and a 200
        with no refusal would read as "forgotten" on a screen where the row is
        still there."""
        gone = uuid.uuid4()
        db = ScriptedDb(forgettable=[forgettable_row(gone)], forget=[])
        out = run(sx.forget_roles(db, TENANT, point_ids=[gone]))
        assert out["forgotten"] == 0 and out["refused"] == 1
        assert "nothing was written" in out["results"][0]["reason"]
        assert db.commits == 0 and db.rollbacks == 1

    def test_another_tenants_row_is_not_found_rather_than_refused_differently(self):
        """The candidates are read INSIDE the tenant, so another tenant's role is
        simply not in the rows — "there is no such role" and "it is not yours"
        are one refusal, which is what stops this being a probe for other
        tenants' point ids."""
        theirs = uuid.uuid4()
        db = ScriptedDb(forgettable=[])
        out = run(sx.forget_roles(db, TENANT, point_ids=[theirs]))
        assert out["refused"] == 1
        assert out["results"][0]["reason"] == (
            "no role is recorded against this point id in this tenant"
        )
        assert "forget" not in db.asked
        assert db.commits == 0

    def test_both_of_its_statements_carry_the_tenant(self):
        gone = uuid.uuid4()
        db = ScriptedDb(
            forgettable=[forgettable_row(gone)],
            forget=[{"role": "outlet_water_temp"}],
        )
        run(sx.forget_roles(db, TENANT, point_ids=[gone]))
        assert [name for name, _ in db.params] == ["forgettable", "forget"]
        for name, params in db.params:
            assert params.get("tenant") == str(TENANT), name
        for sql in (sx._FORGETTABLE_SQL, sx._FORGET_ROLE_SQL):
            assert "CAST(:tenant AS uuid) IS NULL OR" in str(sql)

    def test_one_bad_id_does_not_discard_the_rest_of_the_worklist(self):
        """Per-id transactions, like `repoint_roles`: these are independent
        decisions about different measurements."""
        gone, alive = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            forgettable=[forgettable_row(gone), forgettable_row(alive, exists=True)],
            forget=[{"role": "outlet_water_temp"}],
        )
        out = run(sx.forget_roles(db, TENANT, point_ids=[alive, gone]))
        assert out == {**out, "requested": 2, "forgotten": 1, "refused": 1}
        assert [r["status"] for r in out["results"]] == ["refused", "forgotten"]

    def test_there_is_no_mode_and_no_sweep_on_the_request(self):
        """Deleting an operator's assertion is destructive and irreversible, so
        "forget every missing one" is not a request this API can express. The
        worklist is read by a human and what comes back is the ids they picked."""
        assert set(r.ForgetRolesRequest.model_fields) == {"point_ids"}
        with pytest.raises(Exception):
            r.ForgetRolesRequest(point_ids=[])
        # And the function itself takes ids only — there is no parameter a
        # future caller could set to "all".
        import inspect
        params = inspect.signature(sx.forget_roles).parameters
        assert set(params) == {"db", "tenant", "point_ids"}

    @pytest.mark.asyncio
    async def test_it_is_gated_by_manage_and_not_by_read(self, app):
        """`bi.read` is what reads the worklist. Deleting a row off it is a
        statement about what the estate MEANS, so it needs the same key as
        retiring a point and collapsing a group — asked over the wire, because a
        declared dependency that is never reached looks identical from here.

        The overridden session raises on any use, so a 403 is also proof the
        request was refused before it could touch a role row."""
        from conftest import PREFIX, auth, client

        body = {"point_ids": [str(uuid.uuid4())]}
        async with client(app) as c:
            read_only = await c.post(
                f"{PREFIX}/bi/points/roles/forget",
                headers=auth(tenant_id=TENANT, permissions=[r.PERM_READ]),
                json=body,
            )
            assert read_only.status_code == 403, read_only.text[:200]
            # And the manager gets THROUGH: the request runs on into the refusing
            # session, which is what "reached the route" looks like from here.
            # Asserted because a 403 on its own is also what a route gated by
            # something unreachable would produce.
            with pytest.raises(AssertionError, match="the database was used"):
                await c.post(
                    f"{PREFIX}/bi/points/roles/forget",
                    headers=auth(tenant_id=TENANT, permissions=[r.PERM_MANAGE]),
                    json=body,
                )


# ── one building's stranded roles ────────────────────────────────────────────


SITE_A = uuid.UUID("aaaaaaaa-0000-0000-0000-00000000000a")
SITE_B = uuid.UUID("bbbbbbbb-0000-0000-0000-00000000000b")


class TestSiteScope:
    def test_a_building_sees_only_the_roles_placed_there(self):
        here, there = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            orphans=[
                {**orphan_row(here), "site_id": SITE_A},
                {**orphan_row(there, device="OTHER"), "site_id": SITE_B},
            ],
            missing=[],
            pool=[],
        )
        out = run(sx.orphan_roles(db, TENANT, site_id=SITE_A))
        assert [o["point_id"] for o in out["orphans"]] == [here]

    def test_a_role_whose_point_is_gone_belongs_to_no_building(self):
        """No point row, no placement to test — a building cannot claim it, so it
        is left to the estate view rather than shown in every building's."""
        db = ScriptedDb(orphans=[], missing=[missing_row(uuid.uuid4())], pool=[])
        assert run(sx.orphan_roles(db, TENANT, site_id=SITE_A))["orphans"] == []

    def test_the_estate_still_sees_a_role_whose_point_is_gone(self):
        db = ScriptedDb(orphans=[], missing=[missing_row(uuid.uuid4())], pool=[])
        assert len(run(sx.orphan_roles(db, TENANT))["orphans"]) == 1
