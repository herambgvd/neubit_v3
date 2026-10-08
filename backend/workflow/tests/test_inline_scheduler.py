"""The workflow sweeps without Celery (VE_WORKFLOW_SCHEDULER=inline).

The native Windows appliance has no Redis, and Celery's prefork pool does not run
on Windows, so the API process drives the four periodic sweeps itself. What is
pinned here: the cadence is the SAME table Celery beat reads, a failed sweep does
not stop the loop, and readiness stops asking for a broker that is not there.
"""

import asyncio

import pytest

from app import probes as probes_mod
from app import sweeps as sweeps_table
from app.workflow.runtime import scheduler as sweeps_mod
from app.workflow.runtime.scheduler import InlineScheduler, Sweep

pytestmark = pytest.mark.asyncio


def _counter():
    calls = {"n": 0}

    async def run() -> int:
        calls["n"] += 1
        return calls["n"]

    return calls, run


async def test_mode_defaults_to_celery(monkeypatch):
    monkeypatch.delenv("VE_WORKFLOW_SCHEDULER", raising=False)
    assert sweeps_mod.scheduler_mode() == "celery"


async def test_mode_inline(monkeypatch):
    monkeypatch.setenv("VE_WORKFLOW_SCHEDULER", "Inline")
    assert sweeps_mod.scheduler_mode() == "inline"


async def test_a_misspelt_mode_is_refused_not_ignored(monkeypatch):
    # Ignoring it would run NO sweeps on an appliance: escalations silently stop.
    monkeypatch.setenv("VE_WORKFLOW_SCHEDULER", "inlien")
    with pytest.raises(RuntimeError):
        sweeps_mod.scheduler_mode()


async def test_the_cadence_is_the_one_celery_beat_used():
    cadence = {s.name: s.every_min for s in sweeps_table.sweeps()}
    assert cadence == {
        "escalation_sweep": 1,
        "timeout_sweep": 5,
        "dispatch_notifications": 1,
        "dedup_cleanup": 10,
    }
    assert sweeps_mod.crontab_minute(1) == "*"
    assert sweeps_mod.crontab_minute(5) == "*/5"


async def test_runs_each_sweep_after_the_first_delay():
    calls, run = _counter()
    sched = InlineScheduler(sweeps=(Sweep("s", 1, run),), first_delay_sec=0)
    sched.start()
    await asyncio.sleep(0.05)
    await sched.close()
    assert calls["n"] == 1
    snap = sched.snapshot()["s"]
    assert snap["runs"] == 1
    assert snap["failures"] == 0
    assert snap["last_run_age_sec"] is not None


async def test_a_failed_sweep_is_counted_and_the_loop_lives():
    # A dead SMTP server failing the outbox must not stop escalations.
    async def boom() -> int:
        raise RuntimeError("smtp down")

    sched = InlineScheduler(sweeps=(Sweep("s", 1, boom),), first_delay_sec=0)
    await sched.run_once(sched.sweeps[0])
    await sched.run_once(sched.sweeps[0])
    snap = sched.snapshot()["s"]
    assert snap["runs"] == 2
    assert snap["failures"] == 2
    assert "smtp down" in snap["last_error"]


async def test_close_stops_every_loop():
    calls, run = _counter()
    sched = InlineScheduler(sweeps=(Sweep("a", 1, run), Sweep("b", 5, run)), first_delay_sec=3600)
    sched.start()
    await sched.close()
    assert calls["n"] == 0
    assert not sched._tasks


async def test_metrics_name_each_sweep():
    calls, run = _counter()
    sched = InlineScheduler(sweeps=(Sweep("dedup_cleanup", 10, run),))
    await sched.run_once(sched.sweeps[0])
    text = sched.prometheus()
    assert 'workflow_sweep_runs_total{sweep="dedup_cleanup"} 1' in text
    assert 'workflow_sweep_last_run_age_sec{sweep="dedup_cleanup"}' in text


async def test_readiness_does_not_ask_for_a_broker_in_inline_mode(monkeypatch):
    async def db_ok():
        return None

    async def broker_must_not_be_called():
        raise AssertionError("inline mode has no Redis to PING")

    monkeypatch.setattr(probes_mod, "check_database", db_ok)
    monkeypatch.setattr(probes_mod, "check_broker", broker_must_not_be_called)

    p = probes_mod.ApiProbes()
    p.scheduler = InlineScheduler(sweeps=())
    ready, body = await p.readiness()
    assert ready is True
    assert body["broker"].startswith("not used")
    assert body["scheduler"]["mode"] == "inline"
    assert "worker" not in body
    assert "beat" not in body


async def test_readiness_still_fails_on_the_database_in_inline_mode(monkeypatch):
    async def db_down():
        return "database: refused"

    monkeypatch.setattr(probes_mod, "check_database", db_down)
    p = probes_mod.ApiProbes()
    p.scheduler = InlineScheduler(sweeps=())
    ready, body = await p.readiness()
    assert ready is False
    assert body["reasons"] == ["database: refused"]
