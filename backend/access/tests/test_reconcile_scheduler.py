"""When a scheduled reconcile is due, and who gets to run it.

`access_instances.reconciler_cron` has existed since the port, default
"0 3 * * *", and nothing ever fired it: the lifespan held a stub that logged
"disabled — later phase". So an operator who set a nightly sync on every
controller had the schedule recorded and got a sync only when somebody pressed
the button.

THE DECISION IS PURE, DELIBERATELY. `due_instances` takes the candidates and the
clock and returns ids. That is what lets "is it due at 03:00 tomorrow" be a test
rather than a wait, and it is where every rule below actually lives.

THE CRON IS EVALUATED FROM THE LAST RUN, not from the wall clock. A controller
that has never reconciled is due now; one that ran an hour ago is not due until
its next window; and a deployment that was DOWN over its window catches up on the
next tick instead of silently skipping the night. That last one is the reason the
last-run basis was chosen and it is asserted below.
"""

from __future__ import annotations

import datetime as dt

import pytest

from app.access.scheduler import (
    Candidate,
    _lock_key,
    due_instances,
    enabled,
    lock_available,
)

NOW = dt.datetime(2026, 3, 4, 3, 5, tzinfo=dt.timezone.utc)   # just past 03:00
NIGHTLY = "0 3 * * *"


def _c(cron, last_run, instance_id="i1"):
    return Candidate(instance_id=instance_id, cron=cron, last_run=last_run)


# ── when ─────────────────────────────────────────────────────────────────────

def test_a_controller_that_ran_yesterday_is_due_after_its_window():
    ran = _c(NIGHTLY, dt.datetime(2026, 3, 3, 3, 0, tzinfo=dt.timezone.utc))
    assert due_instances([ran], NOW) == ["i1"]


def test_a_controller_that_ran_this_morning_is_not_due_again():
    """The window already fired today. Running again would be a second full pull
    against the controller for no reason."""
    ran = _c(NIGHTLY, dt.datetime(2026, 3, 4, 3, 0, tzinfo=dt.timezone.utc))
    assert due_instances([ran], NOW) == []


def test_a_controller_that_has_never_reconciled_is_due_now():
    """`last_run` falls back to the instance's created_at, so a controller added
    yesterday syncs on the next tick rather than waiting for tomorrow's window."""
    fresh = _c(NIGHTLY, dt.datetime(2026, 3, 1, 12, 0, tzinfo=dt.timezone.utc))
    assert due_instances([fresh], NOW) == ["i1"]


def test_a_missed_window_is_caught_up_rather_than_skipped():
    """The deployment was down across 03:00 and came back at 09:00. Evaluating the
    cron against the CLOCK would decide the window had passed and wait another
    day; evaluating it against the last run says it is overdue."""
    late = dt.datetime(2026, 3, 4, 9, 0, tzinfo=dt.timezone.utc)
    stale = _c(NIGHTLY, dt.datetime(2026, 3, 2, 3, 0, tzinfo=dt.timezone.utc))
    assert due_instances([stale], late) == ["i1"]


def test_a_naive_last_run_is_read_as_utc():
    """SQLite hands back naive datetimes. Comparing one to an aware `now` raises,
    and a raise here would stop the whole tick."""
    naive = _c(NIGHTLY, dt.datetime(2026, 3, 3, 3, 0))
    assert due_instances([naive], NOW) == ["i1"]


# ── when not ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("cron", [None, "", "   "])
def test_no_cron_means_no_schedule(cron):
    """How an operator turns the schedule off for ONE controller without
    deactivating the controller."""
    assert due_instances([_c(cron, dt.datetime(2020, 1, 1, tzinfo=dt.timezone.utc))], NOW) == []


@pytest.mark.parametrize(
    "cron",
    [
        "not a cron",
        "0 3 * *",              # four fields
        "99 99 * * *",          # out of range
        "* * * * * *",          # SIX fields: croniter reads the first as SECONDS,
        "* * * * * * *",        # so this parses fine and means every second
    ],
)
def test_a_malformed_cron_skips_that_instance_and_nothing_else(cron):
    """A typo in one controller's cron must not stop every other controller from
    syncing — which is what an exception escaping the decision would do.

    The six- and seven-field cases are not typos to croniter: it accepts them, and
    the extra leading field is SECONDS. `* * * * * *` in this column would mean a
    full pull against that controller every second. Refused by field count, so it
    cannot be saved and silently reinterpreted."""
    good = _c(NIGHTLY, dt.datetime(2026, 3, 3, 3, 0, tzinfo=dt.timezone.utc), "good")
    bad = _c(cron, dt.datetime(2020, 1, 1, tzinfo=dt.timezone.utc), "bad")
    assert due_instances([bad, good], NOW) == ["good"]


def test_several_instances_are_decided_independently():
    now = dt.datetime(2026, 3, 4, 3, 5, tzinfo=dt.timezone.utc)
    rows = [
        _c(NIGHTLY, dt.datetime(2026, 3, 3, 3, 0, tzinfo=dt.timezone.utc), "overdue"),
        _c(NIGHTLY, dt.datetime(2026, 3, 4, 3, 0, tzinfo=dt.timezone.utc), "done-today"),
        _c("*/15 * * * *", dt.datetime(2026, 3, 4, 2, 40, tzinfo=dt.timezone.utc), "quarter-hourly"),
        _c(None, dt.datetime(2020, 1, 1, tzinfo=dt.timezone.utc), "off"),
    ]
    assert due_instances(rows, now) == ["overdue", "quarter-hourly"]


# ── who ──────────────────────────────────────────────────────────────────────

def test_the_claim_is_only_available_on_postgres():
    """`docker compose up --scale access=2` is supported, and two replicas each
    running a nightly reconcile means two full pulls against one controller at
    once. The claim is a Postgres advisory lock; on SQLite there is none, and the
    scheduler says so at startup rather than assuming one replica."""
    assert lock_available("postgresql+asyncpg://u:p@h/db") is True
    assert lock_available("sqlite+aiosqlite:///:memory:") is False


def test_the_lock_key_is_stable_and_distinct():
    """Stable, or a restart takes a lock it already held under a different key;
    distinct, or two controllers serialise against each other for no reason."""
    a = _lock_key("11111111-1111-1111-1111-111111111111")
    b = _lock_key("22222222-2222-2222-2222-222222222222")
    assert a == _lock_key("11111111-1111-1111-1111-111111111111")
    assert a != b
    for key in (a, b):
        assert 0 <= key <= 0x7FFF_FFFF_FFFF_FFFF, "must fit pg_try_advisory_lock's bigint"


# ── off by default ───────────────────────────────────────────────────────────

def test_the_scheduler_is_off_unless_asked_for(monkeypatch):
    """A background writer that talks to building hardware is not something a
    deployment should acquire by upgrading."""
    monkeypatch.delenv("VE_ACCESS_RECONCILE_SCHEDULER", raising=False)
    assert enabled() is False
    for off in ("", "0", "false", "no"):
        monkeypatch.setenv("VE_ACCESS_RECONCILE_SCHEDULER", off)
        assert enabled() is False, off
    for on in ("1", "true", "yes", "YES"):
        monkeypatch.setenv("VE_ACCESS_RECONCILE_SCHEDULER", on)
        assert enabled() is True, on
