"""`kernel.migrate` makes the same fresh-vs-existing decision as the bash scripts.

The native Windows appliance has no bash, so the decision lives here too. The
failure it prevents is silent: stamping head on an EXISTING database records
every newer revision as applied without running it.
"""

from kernel import migrate


def test_fresh_database_builds_from_the_baseline_then_stamps():
    p = migrate.plan("", "0001_vision_baseline")
    assert p.fresh
    assert p.steps == [("upgrade", "0001_vision_baseline"), ("stamp", "head")]


def test_existing_database_replays_and_never_stamps():
    p = migrate.plan("0028_media_nodes (head)\n", "0001_vision_baseline")
    assert not p.fresh
    assert p.steps == [("upgrade", "head")]
    assert all(verb != "stamp" for verb, _ in p.steps)


def test_whitespace_only_output_is_a_fresh_database():
    assert migrate.plan("  \n", "0001").fresh


def test_main_runs_the_plan_in_order():
    ran: list[tuple[str, str]] = []
    rc = migrate.main(["0001_access_baseline"], current=lambda: "", run=ran.append)
    assert rc == 0
    assert ran == [("upgrade", "0001_access_baseline"), ("stamp", "head")]


def test_widen_runs_on_both_branches():
    for current in ("", "0020 (head)"):
        widened: list[bool] = []
        migrate.main(
            ["0001", "--widen-version-table"],
            current=lambda c=current: c,
            run=lambda _s: None,
            widen=lambda: widened.append(True),
        )
        assert widened == [True]


def test_widen_is_opt_in():
    widened: list[bool] = []
    migrate.main(["0001"], current=lambda: "", run=lambda _s: None, widen=lambda: widened.append(True))
    assert widened == []
