"""Ghost point collapse: what it settles on its own, and what it refuses to.

THE SHAPE UNDER TEST, measured on this deployment rather than imagined: 766
points with `retired_at IS NULL` against 475 distinct `(device_tag, point_tag)`
pairs. 283 pairs are duplicated across 574 rows, 264 of those groups have
exactly one member reporting inside the freshness window, and 19 have none. A
conflux connection that is deleted and re-created mints a new `point_id` for
every point behind it, so one physical register accumulates a generation per
rebuild.

The failures this file exists to catch are all failures of RESTRAINT, not of
arithmetic:

  * collapsing a group where two generations are both live, which destroys a
    series nobody can get back;
  * collapsing a group where none are live, which is a guess about the building
    dressed as a fact;
  * writing half a group — roles moved, ghosts still live — which nothing
    downstream can detect;
  * an undo that reaches a point an operator retired by hand, turning "undo that
    collapse" into "undo every decommissioning decision anyone ever made";
  * reaching across a tenant boundary at any point in either.

The database is SCRIPTED per statement, matched on a fragment the module itself
wrote (the `test_sites_leaderboard` / `metric_fakes` pattern), so a statement
this feature should not have run is a loud failure naming it rather than an
extra round trip. That is also what lets "the retire failed" be held open on
demand, which no fixture against a real Postgres can do.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid

import pytest
from kernel.auth import Scope
from kernel.errors import ValidationError

from app.api import queries as q
from app.api import router as r

UTC = dt.timezone.utc
TENANT = uuid.UUID("11111111-2222-3333-4444-555555555555")
OTHER_TENANT = uuid.UUID("99999999-9999-9999-9999-999999999999")

NOW = dt.datetime(2026, 9, 19, 12, 0, tzinfo=UTC)
JUST_NOW = NOW - dt.timedelta(minutes=2)        # inside FRESH_MINUTES
LAST_MONTH = NOW - dt.timedelta(days=40)        # a ghost


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
#: `retire` and `restore` are told apart by what they SET, because both mention
#: `retire_reason` and matching on that alone would confuse the write with its
#: undo — which is exactly the pair this file has to keep separate.
_FRAGMENTS = {
    "members": "duplicated AS (",
    "resurrected": "p.superseded_by IS NOT NULL",
    "migrate_role": "INSERT INTO point_roles",
    "drop_roles": "DELETE FROM point_roles",
    "retire": "SET retired_at = now()",
    "restore": "SET retired_at = NULL",
}


class Boom(Exception):
    """What a statement raises when a test wants the transaction to fail."""


class ScriptedDb:
    """Rows per statement; anything unscripted is an AssertionError naming it.

    Records every statement it was asked for AND the params it was asked with —
    the tenant bind is a parameter, so "is this tenant-scoped" is a question
    about the params and cannot be asked any other way without a real database.
    """

    def __init__(self, *, fail_on: str | None = None, **script):
        unknown = set(script) - set(_FRAGMENTS)
        if unknown:
            raise AssertionError(f"no such scripted query: {sorted(unknown)}")
        self.script = script
        self.fail_on = fail_on
        self.asked: list[str] = []
        self.params: list[tuple[str, dict]] = []
        self.commits = 0
        self.rollbacks = 0

    async def execute(self, clause, params=None):
        sql = str(clause)
        for name, frag in _FRAGMENTS.items():
            if frag in sql:
                if name == self.fail_on:
                    self.asked.append(name)
                    raise Boom(name)
                if name not in self.script:
                    raise AssertionError(
                        f"the collapse ran the `{name}` statement, which this "
                        f"test did not script"
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
        """Only the statements that CHANGE something. `nothing was written` is an
        assertion about these, not about round trips."""
        return [a for a in self.asked if a in ("migrate_role", "drop_roles", "retire", "restore")]


def member(
    point_id,
    *,
    device="MFM-4F-01",
    point="KWH_kwh",
    first_seen=None,
    readings=0,
    last_seen=LAST_MONTH,
    fresh=False,
    unit=None,
    has_role=False,
    role=None,
    category="energy",
) -> dict:
    """One row as `_GHOST_MEMBERS_SQL` returns it."""
    return {
        "point_id": point_id,
        "device_tag": device,
        "point_tag": point,
        "category": category,
        "unit": unit,
        "first_seen_at": first_seen,
        "readings": readings,
        "last_seen_at": last_seen,
        "fresh": fresh,
        "has_role": has_role,
        "role": role,
    }


# ── the duplicate shape ──────────────────────────────────────────────────────


class TestTheGroupingItself:
    def test_three_generations_of_one_register_are_one_group(self):
        """The real shape: a connection rebuilt twice, three point_ids, one
        meter. They must land in ONE group with all three members — a grouping
        that splits them would present the operator with three single-member
        groups and nothing to collapse."""
        g1, g2, g3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            members=[
                member(g3, last_seen=JUST_NOW, fresh=True),
                member(g2, last_seen=NOW - dt.timedelta(days=12)),
                member(g1, last_seen=LAST_MONTH),
            ]
        )
        groups = run(q.ghost_groups(db, TENANT))
        assert len(groups) == 1
        assert [m["point_id"] for m in groups[0]["members"]] == [g3, g2, g1]
        assert groups[0]["device_tag"] == "MFM-4F-01"
        assert groups[0]["point_tag"] == "KWH_kwh"

    def test_the_same_point_tag_on_two_devices_is_two_groups(self):
        """`KWH_kwh` is on every meter in the building. Grouping on the point tag
        alone would merge an entire estate's energy registers into one group and
        propose retiring all but one of them."""
        a1, a2 = uuid.uuid4(), uuid.uuid4()
        b1, b2 = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            members=[
                member(a1, device="MFM-4F-01"),
                member(a2, device="MFM-4F-01", last_seen=JUST_NOW, fresh=True),
                member(b1, device="MFM-3F-02"),
                member(b2, device="MFM-3F-02", last_seen=JUST_NOW, fresh=True),
            ]
        )
        groups = run(q.ghost_groups(db, TENANT))
        assert len(groups) == 2
        assert {g["device_tag"] for g in groups} == {"MFM-4F-01", "MFM-3F-02"}
        assert all(len(g["members"]) == 2 for g in groups)

    def test_a_renamed_tag_on_the_same_device_is_two_groups(self):
        """The mirror of the case above: grouping on the device alone would put
        a meter's kWh register and its power-factor register in one group."""
        db = ScriptedDb(
            members=[
                member(uuid.uuid4(), point="KWH_kwh"),
                member(uuid.uuid4(), point="KWH_kwh", last_seen=JUST_NOW, fresh=True),
                member(uuid.uuid4(), point="PF_pf"),
                member(uuid.uuid4(), point="PF_pf", last_seen=JUST_NOW, fresh=True),
            ]
        )
        groups = run(q.ghost_groups(db, TENANT))
        assert {g["point_tag"] for g in groups} == {"KWH_kwh", "PF_pf"}

    def test_each_member_carries_what_the_operator_has_to_decide_on(self):
        """A manual group is a question put to a human, and the whole worklist
        stands or falls on whether that question is ANSWERABLE from the row.

        When every member has gone quiet — the case 45 of this estate's 46 pairs
        are in — a row of uuid + last-seen offers two addresses that stopped
        minutes apart, and no person can choose between them. WHEN IT STARTED and
        HOW MUCH IT HOLDS are what make it an ordinary judgement: one generation
        ran for months and carries the history, the other appeared at a rebuild.
        So they travel with the member, beside the unit and the role."""
        keep = uuid.uuid4()
        db = ScriptedDb(
            members=[
                member(keep, first_seen=LAST_MONTH, readings=331_440, last_seen=JUST_NOW,
                       fresh=True, unit="kWh", has_role=True, role="site_main_incomer"),
                member(uuid.uuid4()),
            ]
        )
        first = run(q.ghost_groups(db, TENANT))[0]["members"][0]
        assert first == {
            "point_id": keep,
            "first_seen_at": LAST_MONTH,
            "readings": 331_440,
            "last_seen_at": JUST_NOW,
            "unit": "kWh",
            "fresh": True,
            "has_role": True,
            "role": "site_main_incomer",
        }

    def test_a_reading_volume_that_is_absent_is_zero_and_never_a_crash(self):
        """`readings` comes off a LEFT JOIN on the hourly aggregate: a generation
        the aggregate has not covered yet answers NULL, and the console has to
        get a number."""
        db = ScriptedDb(members=[member(uuid.uuid4(), readings=None), member(uuid.uuid4())])
        assert run(q.ghost_groups(db, TENANT))[0]["members"][0]["readings"] == 0

    def test_the_volume_is_counted_off_the_aggregate_not_the_raw_hypertable(self):
        """`readings` is compressed and keyed (point_id, ts); counting it per
        member would scan chunks on every load of this screen."""
        sql = " ".join(str(q._GHOST_MEMBERS_SQL).split())
        assert "FROM readings_1h" in sql
        assert "FROM readings " not in sql

    def test_the_duplicate_set_ignores_the_retirement_horizon(self):
        """A ghost has not reported in weeks BY DEFINITION. If the grouping
        applied LIVE_POINT the horizon would drop every stale member, each group
        would fall to one member, and the worklist would be empty on the exact
        estate that has 283 duplicated pairs."""
        sql = str(q._GHOST_MEMBERS_SQL)
        assert "p.retired_at IS NULL" in sql
        assert "retire_days" not in sql


# ── auto vs manual ───────────────────────────────────────────────────────────


class TestClassification:
    def test_exactly_one_fresh_member_is_auto_and_names_it(self):
        """264 of the 283 duplicated pairs on this deployment are this shape."""
        keep = uuid.uuid4()
        mode, survivor = q._classify(
            [member(keep, last_seen=JUST_NOW, fresh=True), member(uuid.uuid4())]
        )
        assert mode == "auto"
        assert survivor == keep

    def test_no_fresh_member_at_all_is_manual(self):
        """19 groups here. The whole register has stopped reporting, so which
        generation is "the" point is a question about the building. Picking the
        newest `last_seen_at` would be a guess that reads like a fact."""
        mode, survivor = q._classify(
            [
                member(uuid.uuid4(), last_seen=NOW - dt.timedelta(days=12)),
                member(uuid.uuid4(), last_seen=LAST_MONTH),
            ]
        )
        assert mode == "manual"
        assert survivor is None

    def test_more_than_one_fresh_member_is_manual(self):
        """None today, and the branch still has to exist: the state appears the
        moment a connection is rebuilt and both generations report through the
        cutover. Auto-collapsing it would retire a series that is live."""
        mode, survivor = q._classify(
            [
                member(uuid.uuid4(), last_seen=JUST_NOW, fresh=True),
                member(uuid.uuid4(), last_seen=JUST_NOW, fresh=True),
            ]
        )
        assert mode == "manual"
        assert survivor is None

    def test_the_mode_filter_selects_groups_without_reshaping_them(self):
        """`mode` filters the RESULT. If it filtered the members instead, asking
        for `auto` would strip the stale members out of every group and the
        classifier would then see a one-member group and call it something
        else."""
        keep = uuid.uuid4()
        rows = [
            member(keep, device="A", last_seen=JUST_NOW, fresh=True),
            member(uuid.uuid4(), device="A"),
            member(uuid.uuid4(), device="B"),
            member(uuid.uuid4(), device="B"),
        ]
        auto = run(q.ghost_groups(ScriptedDb(members=rows), TENANT, mode="auto"))
        manual = run(q.ghost_groups(ScriptedDb(members=rows), TENANT, mode="manual"))
        assert [g["device_tag"] for g in auto] == ["A"]
        assert auto[0]["survivor_point_id"] == keep
        assert len(auto[0]["members"]) == 2
        assert [g["device_tag"] for g in manual] == ["B"]
        assert manual[0]["survivor_point_id"] is None


# ── the collapse ─────────────────────────────────────────────────────────────


def _auto_and_manual_rows(keep, ghost, m1, m2) -> list[dict]:
    """One AUTO group (`A`) and one MANUAL group (`B`, nothing fresh)."""
    return [
        member(keep, device="A", last_seen=JUST_NOW, fresh=True),
        member(ghost, device="A"),
        member(m1, device="B", last_seen=NOW - dt.timedelta(days=12)),
        member(m2, device="B"),
    ]


class TestAutoCollapse:
    def test_auto_retires_the_ghosts_and_keeps_the_fresh_member(self):
        keep, ghost = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            members=[member(keep, last_seen=JUST_NOW, fresh=True), member(ghost)],
            migrate_role=[],
            drop_roles=[],
            retire=[{"point_id": ghost}],
        )
        out = run(q.collapse_ghosts(db, TENANT, mode="auto"))
        assert out["groups_collapsed"] == 1
        assert out["points_retired"] == 1
        retire_params = dict(db.params)["retire"]
        assert retire_params["ghosts"] == [str(ghost)]
        assert retire_params["survivor"] == str(keep)

    def test_auto_never_touches_a_manual_group(self):
        """THE GUARD. A manual group has no survivor, so the only way it can be
        collapsed is by something picking one — and nothing may."""
        keep, ghost, m1, m2 = (uuid.uuid4() for _ in range(4))
        db = ScriptedDb(
            members=_auto_and_manual_rows(keep, ghost, m1, m2),
            migrate_role=[],
            drop_roles=[],
            retire=[{"point_id": ghost}],
        )
        out = run(q.collapse_ghosts(db, TENANT, mode="auto"))
        assert out["groups_collapsed"] == 1
        touched = {p for _, params in db.params if "ghosts" in params
                   for p in params["ghosts"]}
        assert touched == {str(ghost)}
        assert str(m1) not in touched and str(m2) not in touched

    def test_the_retire_writes_the_reason_that_makes_the_undo_narrow(self):
        """Without `retire_reason = 'ghost'` on the write, restore cannot tell a
        collapsed point from one an operator decommissioned by hand."""
        sql = str(q._RETIRE_GHOSTS_SQL)
        assert "retire_reason = 'ghost'" in sql
        assert "superseded_by = CAST(:survivor AS uuid)" in sql


class TestExplicitCollapse:
    def _db(self, keep, ghost, **over):
        script = {
            "members": [member(keep, last_seen=JUST_NOW, fresh=True), member(ghost)],
            "migrate_role": [],
            "drop_roles": [],
            "retire": [{"point_id": ghost}],
        }
        script.update(over)
        return ScriptedDb(**script)

    def test_an_operator_can_name_a_survivor_the_classifier_would_not_pick(self):
        """The whole reason `groups` exists: a manual group is settled by a
        human, and the human may keep the member that is NOT fresh."""
        keep, ghost = uuid.uuid4(), uuid.uuid4()
        db = self._db(keep, ghost, retire=[{"point_id": keep}])
        out = run(
            q.collapse_ghosts(
                db,
                TENANT,
                choices=[{
                    "device_tag": "MFM-4F-01",
                    "point_tag": "KWH_kwh",
                    "survivor_point_id": ghost,
                }],
            )
        )
        assert out["groups_collapsed"] == 1
        assert dict(db.params)["retire"]["survivor"] == str(ghost)
        assert dict(db.params)["retire"]["ghosts"] == [str(keep)]

    def test_a_survivor_that_is_not_a_member_is_refused_and_nothing_is_written(self):
        """THE OTHER GUARD. "Keep this point" naming a point that was never in
        the group is a claim about identity that was never true — and a survivor
        the group does not contain would retire EVERY member, because every one
        of them is a non-survivor."""
        keep, ghost = uuid.uuid4(), uuid.uuid4()
        stranger = uuid.uuid4()
        db = self._db(keep, ghost)
        with pytest.raises(ValidationError, match="not a member"):
            run(
                q.collapse_ghosts(
                    db,
                    TENANT,
                    choices=[{
                        "device_tag": "MFM-4F-01",
                        "point_tag": "KWH_kwh",
                        "survivor_point_id": stranger,
                    }],
                )
            )
        assert db.wrote() == []

    def test_a_bad_choice_stops_the_good_ones_beside_it(self):
        """Validation runs over the WHOLE batch before anything is written.
        Validating as it goes would collapse the groups before the bad one and
        leave the ones after it untouched — a partial apply the operator never
        asked for and has no way to see."""
        keep, ghost, m1, m2 = (uuid.uuid4() for _ in range(4))
        db = ScriptedDb(
            members=_auto_and_manual_rows(keep, ghost, m1, m2),
            migrate_role=[],
            drop_roles=[],
            retire=[{"point_id": ghost}],
        )
        with pytest.raises(ValidationError, match="not a member"):
            run(
                q.collapse_ghosts(
                    db,
                    TENANT,
                    choices=[
                        {"device_tag": "A", "point_tag": "KWH_kwh",
                         "survivor_point_id": keep},          # perfectly valid
                        {"device_tag": "B", "point_tag": "KWH_kwh",
                         "survivor_point_id": uuid.uuid4()},  # not a member
                    ],
                )
            )
        assert db.wrote() == []

    def test_a_pair_that_is_no_longer_duplicated_is_skipped_with_a_reason(self):
        """The worklist goes stale between the GET and the POST — another
        operator collapses a group, or a rebuild retires a member. Failing the
        whole batch for that makes the screen unusable; silently succeeding
        makes it lie. It is reported."""
        keep, ghost = uuid.uuid4(), uuid.uuid4()
        db = self._db(keep, ghost)
        out = run(
            q.collapse_ghosts(
                db,
                TENANT,
                choices=[{
                    "device_tag": "GONE",
                    "point_tag": "KWH_kwh",
                    "survivor_point_id": uuid.uuid4(),
                }],
            )
        )
        assert out["groups_collapsed"] == 0
        assert out["groups_skipped"] == 1
        assert out["skipped"][0]["device_tag"] == "GONE"
        assert "duplicated" in out["skipped"][0]["reason"]
        assert db.wrote() == []


# ── roles ────────────────────────────────────────────────────────────────────


class TestRoleMigration:
    def _db(self, keep, ghost, *, migrate, drop):
        return ScriptedDb(
            members=[member(keep, last_seen=JUST_NOW, fresh=True),
                     member(ghost, has_role=True, role="site_main_incomer")],
            migrate_role=migrate,
            drop_roles=drop,
            retire=[{"point_id": ghost}],
        )

    def test_the_ghosts_role_moves_onto_the_survivor(self):
        """A role is what a metric definition SELECTS on. Retiring the point that
        carries "site main incomer" without moving it silently empties every
        formula that asks for one."""
        keep, ghost = uuid.uuid4(), uuid.uuid4()
        db = self._db(keep, ghost, migrate=[{"point_id": keep}], drop=[{"point_id": ghost}])
        out = run(q.collapse_ghosts(db, TENANT, mode="auto"))
        assert out["roles_migrated"] == 1
        assert out["roles_discarded"] == 0
        assert db.asked.index("migrate_role") < db.asked.index("drop_roles")

    def test_a_survivor_that_already_has_the_role_keeps_its_own(self):
        """`point_roles` is keyed by point alone, so an INSERT would collide.
        `ON CONFLICT DO NOTHING` makes the survivor's own assertion win; the
        ghost's row is dropped and the loss is REPORTED rather than counted as a
        migration."""
        keep, ghost = uuid.uuid4(), uuid.uuid4()
        # The INSERT returned nothing: the conflict fired.
        db = self._db(keep, ghost, migrate=[], drop=[{"point_id": ghost}])
        out = run(q.collapse_ghosts(db, TENANT, mode="auto"))
        assert out["roles_migrated"] == 0
        assert out["roles_discarded"] == 1

    def test_the_insert_cannot_overwrite_a_role_or_duplicate_one(self):
        """The idempotence is in the statement, not in a read-then-write. A
        collapse re-run, or two run concurrently, must not raise and must not
        replace an operator's assertion about the surviving point."""
        sql = str(q._MIGRATE_ROLE_SQL)
        assert "ON CONFLICT (point_id) DO NOTHING" in sql
        assert "UPDATE" not in sql.upper().replace("DO NOTHING", "")

    def test_a_group_with_no_roles_anywhere_migrates_nothing(self):
        keep, ghost = uuid.uuid4(), uuid.uuid4()
        db = self._db(keep, ghost, migrate=[], drop=[])
        out = run(q.collapse_ghosts(db, TENANT, mode="auto"))
        assert (out["roles_migrated"], out["roles_discarded"]) == (0, 0)


# ── one group, one transaction ───────────────────────────────────────────────


class TestAtomicity:
    def test_a_failed_retire_rolls_the_whole_group_back(self):
        """Roles moved onto the survivor and the ghosts still live is the worst
        outcome available here: the ghosts still count, the ghosts' roles are
        gone, and nothing downstream can tell."""
        keep, ghost = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            members=[member(keep, last_seen=JUST_NOW, fresh=True), member(ghost)],
            migrate_role=[{"point_id": keep}],
            drop_roles=[{"point_id": ghost}],
            fail_on="retire",
        )
        with pytest.raises(Exception, match="retire"):
            run(q.collapse_ghosts(db, TENANT, mode="auto"))
        assert db.rollbacks == 1
        assert db.commits == 0

    def test_a_group_commits_once_all_three_statements_have_run(self):
        keep, ghost = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            members=[member(keep, last_seen=JUST_NOW, fresh=True), member(ghost)],
            migrate_role=[], drop_roles=[], retire=[{"point_id": ghost}],
        )
        run(q.collapse_ghosts(db, TENANT, mode="auto"))
        assert db.commits == 1
        assert db.rollbacks == 0


# ── the tenant boundary ──────────────────────────────────────────────────────


class TestTenantScope:
    def test_every_statement_the_collapse_runs_carries_the_tenant(self):
        """The bind is filled from the JWT by the router and never from the
        request. A statement that drops it reaches every tenant's points."""
        keep, ghost = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            members=[member(keep, last_seen=JUST_NOW, fresh=True), member(ghost)],
            migrate_role=[], drop_roles=[], retire=[{"point_id": ghost}],
        )
        run(q.collapse_ghosts(db, TENANT, mode="auto"))
        assert db.params
        for name, params in db.params:
            assert params.get("tenant") == str(TENANT), name

    def test_every_statement_declares_the_predicate_the_bind_feeds(self):
        """A bind nothing compares against is scoping that does not happen."""
        for sql in (
            q._GHOST_MEMBERS_SQL,
            q._MIGRATE_ROLE_SQL,
            q._DROP_GHOST_ROLES_SQL,
            q._RETIRE_GHOSTS_SQL,
            q._RESTORE_GHOSTS_SQL,
            q._GHOST_RESURRECTED_SQL,
        ):
            assert "CAST(:tenant AS uuid) IS NULL OR" in str(sql), str(sql)[:120]

    def test_a_caller_cannot_keep_another_tenants_point_as_the_survivor(self):
        """The duplicate set is computed INSIDE the tenant, so another tenant's
        point is not a member of any group the caller can see — and naming one is
        the same refusal as naming a stranger. This is the mechanism, not a
        second check bolted on top."""
        keep, ghost = uuid.uuid4(), uuid.uuid4()
        theirs = uuid.uuid4()
        db = ScriptedDb(
            # Scoped to TENANT, so `theirs` simply is not in the rows.
            members=[member(keep, last_seen=JUST_NOW, fresh=True), member(ghost)],
        )
        with pytest.raises(ValidationError, match="not a member"):
            run(
                q.collapse_ghosts(
                    db,
                    TENANT,
                    choices=[{
                        "device_tag": "MFM-4F-01",
                        "point_tag": "KWH_kwh",
                        "survivor_point_id": theirs,
                    }],
                )
            )
        assert db.wrote() == []

    def test_a_platform_superadmin_passes_null_rather_than_a_tenant(self):
        """The same semantics every other query here has: None means no filter,
        and it can only come from a token with no tenant claim."""
        keep, ghost = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(
            members=[member(keep, last_seen=JUST_NOW, fresh=True), member(ghost)],
            migrate_role=[], drop_roles=[], retire=[{"point_id": ghost}],
        )
        run(q.collapse_ghosts(db, None, mode="auto"))
        assert all(params.get("tenant") is None for _, params in db.params)


# ── the undo ─────────────────────────────────────────────────────────────────


class TestRestore:
    def test_restore_reaches_only_what_the_collapse_retired(self):
        """THE WHOLE SAFETY OF THE UNDO. Without this predicate, "restore these
        points" is "un-retire whatever I name", and a bulk undo of a collapse
        silently resurrects every meter an operator decommissioned by hand."""
        sql = str(q._RESTORE_GHOSTS_SQL)
        assert "p.retire_reason = 'ghost'" in sql

    def test_restore_clears_exactly_the_three_columns_the_collapse_wrote(self):
        sql = str(q._RESTORE_GHOSTS_SQL)
        assert "retired_at = NULL" in sql
        assert "retire_reason = NULL" in sql
        assert "superseded_by = NULL" in sql

    def test_a_point_it_could_not_reach_comes_back_refused_not_counted(self):
        """A point retired by hand, or another tenant's, matches no row. Counting
        the request as a success would tell an operator their undo worked on a
        point it never touched."""
        mine, theirs = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(restore=[{"point_id": mine, "device_tag": "A", "point_tag": "KWH_kwh"}])
        out = run(q.restore_ghosts(db, TENANT, point_ids=[mine, theirs]))
        assert out["restored"] == 1
        assert out["requested"] == 2
        assert out["refused"] == [theirs]

    def test_restore_writes_nothing_else(self):
        """No role is put back, and no reading is touched. The collapse moved the
        role onto the survivor because the survivor is what means something now."""
        mine = uuid.uuid4()
        db = ScriptedDb(restore=[{"point_id": mine, "device_tag": "A", "point_tag": "K"}])
        run(q.restore_ghosts(db, TENANT, point_ids=[mine]))
        assert db.wrote() == ["restore"]


# ── the routes' own refusals ─────────────────────────────────────────────────


class _NeverTouched:
    """A database that fails if a refused request reaches it."""

    def __getattr__(self, name):
        raise AssertionError(f"the request reached the database (session.{name})")


SCOPE = Scope(tenant_id=TENANT, is_superadmin=False)


class TestRouteRefusals:
    def test_mode_manual_is_refused_by_name(self):
        """A caller asking for `mode="manual"` wants a bulk answer to the
        questions this feature exists to ask. Ignoring it and collapsing nothing
        would look like success."""
        body = r.CollapseGhostsRequest(mode="manual")
        with pytest.raises(ValidationError, match="only bulk mode"):
            run(r.collapse_ghost_points(db=_NeverTouched(), scope=SCOPE, body=body))

    def test_neither_mode_nor_groups_is_refused(self):
        body = r.CollapseGhostsRequest()
        with pytest.raises(ValidationError, match="either"):
            run(r.collapse_ghost_points(db=_NeverTouched(), scope=SCOPE, body=body))

    def test_both_at_once_is_refused_rather_than_one_winning_silently(self):
        body = r.CollapseGhostsRequest(
            mode="auto",
            groups=[r.GhostChoice(device_tag="A", point_tag="K",
                                  survivor_point_id=uuid.uuid4())],
        )
        with pytest.raises(ValidationError, match="not both"):
            run(r.collapse_ghost_points(db=_NeverTouched(), scope=SCOPE, body=body))

    def test_an_unknown_mode_on_the_worklist_is_refused(self):
        """`mode=aut0` would otherwise match no group and render an empty
        worklist, which reads as "this estate has no ghosts"."""
        with pytest.raises(ValidationError, match="auto"):
            run(r.ghost_points(db=_NeverTouched(), scope=SCOPE, mode="live"))


# ── the estate count the duplicates distort ──────────────────────────────────


class _SummaryDb:
    """Every statement `summary()` runs, answered empty except the totals.

    The totals row is the only thing under test here, and the rest of the summary
    is other features' business — answering them with nothing keeps this about the
    one number and keeps the SQL that produced it identifiable: the totals
    statement is the only one that counts registers.
    """

    def __init__(self, **totals):
        self.totals = totals
        self.totals_sql = ""

    async def execute(self, clause, params=None):
        sql = str(clause)
        if "AS registers" in sql:
            self.totals_sql = sql
            return _Result([self.totals])
        return _Result([])


class TestTheRegisterCount:
    """HOW MANY THINGS, as against how many ROWS — counted on the server.

    `Portfolio.tsx` printed "475 registers · 291 rows are repeats of them" by
    subtracting the ghost worklist's duplicate excess from `summary.total_points`.
    Those two are counted over DIFFERENT ROW SETS: the summary applies the
    retirement horizon, and the ghost grouping deliberately applies only
    `retired_at IS NULL` because the horizon would hide the members it exists to
    find. A generation dead long enough to be past the horizon is therefore in the
    worklist and was never in the total, and the subtraction under-counts by
    exactly those rows. On this deployment the two agree today; that is an
    accident of these points' ages, not a property.
    """

    def test_the_summary_reports_the_distinct_registers_itself(self):
        """766 rows, 475 registers, so 291 rows are later generations of
        something already counted — and the screen does no arithmetic across two
        row sets to learn it."""
        db = _SummaryDb(devices=41, points=766, registers=475, points_reporting=766)
        out = run(q.summary(db, TENANT))
        assert out["total_points"] == 766
        assert out["total_registers"] == 475
        assert out["total_points"] - out["total_registers"] == 291

    def test_it_is_counted_in_the_same_statement_as_the_row_count(self):
        """THE WHOLE POINT OF THE FIX. One SELECT, one predicate, so the two
        numbers cannot be computed over different rows — which is a property of
        the statement and not something two separate queries agreeing today can
        promise."""
        db = _SummaryDb(points=766, registers=475)
        run(q.summary(db, TENANT))
        assert "AS points," in db.totals_sql
        assert "AS registers" in db.totals_sql
        # And that shared predicate IS the retirement horizon `total_points` is
        # counted under — not `retired_at IS NULL` alone, which is the ghost
        # worklist's rule and the reason the subtraction could drift.
        assert q.LIVE_POINT in db.totals_sql
        assert q.LIVE_POINT in str(q._TOTALS_SQL)

    def test_a_register_is_the_same_key_the_duplicate_grouping_uses(self):
        """`(device_tag, point_tag)`. If the two disagreed about what one
        register is, the count and the worklist that settles it would be about
        different things."""
        sql = str(q._TOTALS_SQL)
        assert "p.device_tag || chr(31) || p.point_tag" in sql
        assert "GROUP BY device_tag, point_tag" in str(q._GHOST_MEMBERS_SQL)

    def test_a_row_missing_either_tag_counts_as_a_register_of_its_own(self):
        """Two untagged rows cannot be shown to be the same thing. A plain
        `count(DISTINCT (device_tag, point_tag))` would merge them — DISTINCT
        reads NULLs as equal — and every unlabelled point on the estate would
        collapse into one register that nothing observed. The duplicate grouping
        refuses NULL tags for the same reason."""
        sql = str(q._TOTALS_SQL)
        assert "WHEN p.device_tag IS NOT NULL AND p.point_tag IS NOT NULL" in sql
        assert "ELSE p.point_id::text" in sql

    def test_the_separator_keeps_two_different_pairs_apart(self):
        """`('1FYC1', 'A_B')` and `('1FYC1_A', 'B')` are two registers. Joining
        the tags with an underscore — or with nothing — would count them as
        one, and this estate's tags are built out of underscores."""
        assert "chr(31)" in str(q._TOTALS_SQL)

    def test_the_row_count_it_sits_beside_is_unchanged(self):
        """`total_points` is what every other figure on the portfolio screen was
        computed over. A total silently corrected to registers would disagree
        with all of them."""
        db = _SummaryDb(points=766, registers=475)
        out = run(q.summary(db, TENANT))
        assert out["total_points"] == 766
        assert "AS points," in db.totals_sql

    def test_the_field_survives_the_response_schema(self):
        """A number the model drops is a number the screen cannot switch to."""
        from app.api.schemas import SummaryResponse

        assert "total_registers" in SummaryResponse.model_fields
        db = _SummaryDb(points=766, registers=475)
        assert SummaryResponse(**run(q.summary(db, TENANT))).total_registers == 475


# ── one building's ghosts ────────────────────────────────────────────────────
#
# A building's view asks "which ghosts inflate THIS building". The trap is that
# generations of one register sit in different places — the dead one was placed,
# the live one arrived after the rebuild with no site yet. On this estate 44 of
# the 45 remaining duplicated pairs span more than one placement, so filtering
# members BEFORE grouping would split nearly every group into a lone member that
# is no longer a duplicate, and the building's view would show almost nothing.

SITE_A = uuid.UUID("aaaaaaaa-0000-0000-0000-00000000000a")
SITE_B = uuid.UUID("bbbbbbbb-0000-0000-0000-00000000000b")


def placed(row: dict, site) -> dict:
    return {**row, "site_id": site}


class TestSiteScope:
    def test_a_group_spanning_buildings_is_kept_whole_in_the_building_view(self):
        dead, live = uuid.uuid4(), uuid.uuid4()
        db = ScriptedDb(members=[
            placed(member(live, last_seen=JUST_NOW, fresh=True), None),
            placed(member(dead, last_seen=LAST_MONTH), SITE_A),
        ])
        groups = run(q.ghost_groups(db, TENANT, site_id=SITE_A))
        assert len(groups) == 1
        # BOTH generations, so the verdict is the estate's verdict: one fresh
        # member, auto, and the unplaced live one is the survivor.
        assert {m["point_id"] for m in groups[0]["members"]} == {dead, live}
        assert groups[0]["mode"] == "auto"
        assert groups[0]["survivor_point_id"] == live

    def test_a_group_placed_only_in_another_building_is_not_this_ones(self):
        db = ScriptedDb(members=[
            placed(member(uuid.uuid4(), last_seen=JUST_NOW, fresh=True), SITE_B),
            placed(member(uuid.uuid4()), SITE_B),
        ])
        assert run(q.ghost_groups(db, TENANT, site_id=SITE_A)) == []

    def test_without_a_building_every_group_is_the_estates(self):
        db = ScriptedDb(members=[
            placed(member(uuid.uuid4(), last_seen=JUST_NOW, fresh=True), SITE_B),
            placed(member(uuid.uuid4()), SITE_B),
        ])
        assert len(run(q.ghost_groups(db, TENANT))) == 1

    def test_a_resurrected_point_is_scoped_by_its_own_placement(self):
        """One point, one placement — a plain predicate, unlike a group."""
        db = ScriptedDb(resurrected=[])
        run(q.resurrected_points(db, TENANT, site_id=SITE_A))
        name, params = db.params[0]
        assert name == "resurrected"
        assert params["site"] == str(SITE_A)
        assert "p.site_id = CAST(:site AS uuid)" in str(q._GHOST_RESURRECTED_SQL)
