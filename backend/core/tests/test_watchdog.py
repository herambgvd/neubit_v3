"""Infrastructure alarms — the three signals, and the rules that keep them usable.

The appliance could already SEE all of this: disk on the ops-agent's /host,
container state on its /containers, EVENTS_DLQ depth on reading-writer's /stats.
Twenty-five dead letters had been parked for weeks. What was missing was anyone
being told, so the properties worth pinning here are the ones that decide whether
an operator keeps the alert switched on:

  * an exited one-shot job (db-init, reporting-migrate) is not a failure,
  * a container that is running but unhealthy IS one,
  * a standing alarm is not re-sent every five minutes,
  * and one dead source does not silence the other two.
"""

import asyncio

import pytest
import pytest_asyncio

from app import watchdog
from tests.conftest import make_user

pytestmark = pytest.mark.asyncio


class FakeAgent:
    """Stands in for the ops-agent sidecar."""

    def __init__(self, host=None, containers=None, *, host_raises=False):
        self._host = host if host is not None else {"disk_used_gb": 1.0, "disk_total_gb": 100.0}
        self._containers = containers or []
        self._host_raises = host_raises

    async def host(self):
        if self._host_raises:
            raise RuntimeError("ops-agent unreachable")
        return self._host

    async def list_containers(self):
        return self._containers


@pytest.fixture
def no_dlq(monkeypatch):
    """Most tests are not about the DLQ; silence that source."""
    async def _none():
        return []

    monkeypatch.setattr(watchdog, "_dlq", _none)


@pytest.fixture
def sent(monkeypatch):
    """Capture every notify() the watchdog makes."""
    out = []

    async def _notify(db, **kwargs):
        out.append(kwargs)

    monkeypatch.setattr(watchdog, "notify", _notify)
    return out


@pytest_asyncio.fixture
async def superadmin(db, admin_role):
    return await make_user(db, "ops@example.com", admin_role, superadmin=True)


# --- what counts as a problem -------------------------------------------------
async def test_exited_one_shot_job_is_not_an_alarm(no_dlq):
    """db-init and reporting-migrate exit 0 and stay exited. That is success.

    Alerting on "not running" would fire on both after every restart of the
    stack — the fastest way to teach an operator to ignore this alert.
    """
    agent = FakeAgent(containers=[
        {"name": "neubit-v3-db-init-1", "status": "exited", "health": None, "exit_code": 0},
        {"name": "neubit-v3-reporting-migrate-1", "status": "exited", "health": None, "exit_code": 0},
    ])
    assert await watchdog.collect(agent) == []


async def test_exited_non_zero_is_an_alarm(no_dlq):
    agent = FakeAgent(containers=[
        {"name": "vision", "status": "exited", "health": None, "exit_code": 137},
    ])
    keys = [k for k, _ in await watchdog.collect(agent)]
    assert keys == ["container:vision"]


async def test_running_but_unhealthy_is_an_alarm(no_dlq):
    """The half a status check misses: it keeps saying `running` and serves nothing."""
    agent = FakeAgent(containers=[
        {"name": "core", "status": "running", "health": "unhealthy", "exit_code": None},
    ])
    keys = [k for k, _ in await watchdog.collect(agent)]
    assert keys == ["container:core"]


async def test_starting_container_is_not_yet_an_alarm(no_dlq):
    agent = FakeAgent(containers=[
        {"name": "core", "status": "running", "health": "starting", "exit_code": None},
    ])
    assert await watchdog.collect(agent) == []


async def test_disk_alarms_only_past_the_threshold(no_dlq, monkeypatch):
    monkeypatch.setattr(watchdog, "DISK_PCT", 85.0)
    below = FakeAgent(host={"disk_used_gb": 84.0, "disk_total_gb": 100.0})
    above = FakeAgent(host={"disk_used_gb": 86.0, "disk_total_gb": 100.0})
    assert await watchdog.collect(below) == []
    assert [k for k, _ in await watchdog.collect(above)] == ["disk"]


async def test_missing_host_stats_are_not_an_all_clear_and_not_an_alarm(no_dlq):
    """psutil is optional in the agent. Absent is nothing to say, either way."""
    agent = FakeAgent(host={"containers_running": 3, "containers_total": 3})
    assert await watchdog.collect(agent) == []


async def test_unknown_dlq_depth_is_not_read_as_empty(monkeypatch):
    """A watch that never bound reports None, and None is not zero.

    Pinned with the threshold at 0 — "alarm on any dead letter", which an
    operator can legitimately set — because that is the only setting at which
    the two readings differ: above it, `None` and `0` are both below the
    threshold and the distinction is invisible. Writing this test at the default
    of 1 passed against a version that did `int(depth or 0)`, which is the bug
    it is supposed to be about.
    """
    monkeypatch.setattr(watchdog, "DLQ_DEPTH", 0)

    async def _stats(self, url, **kw):
        class R:
            @staticmethod
            def raise_for_status():
                return None

            @staticmethod
            def json():
                return {"dlq_stream_messages": None}

        return R()

    monkeypatch.setattr("httpx.AsyncClient.get", _stats)
    assert await watchdog._dlq() == []


async def test_dlq_depth_alarms(monkeypatch):
    async def _stats(self, url, **kw):
        class R:
            @staticmethod
            def raise_for_status():
                return None

            @staticmethod
            def json():
                return {"dlq_stream_messages": 25}

        return R()

    monkeypatch.setattr("httpx.AsyncClient.get", _stats)
    keys = [k for k, _ in await watchdog._dlq()]
    assert keys == ["dlq"]


async def test_one_dead_source_does_not_silence_the_others(monkeypatch):
    """An unreachable ops-agent must not hide a DLQ that is filling."""
    async def _dlq():
        return [("dlq", "25 parked")]

    monkeypatch.setattr(watchdog, "_dlq", _dlq)
    agent = FakeAgent(host_raises=True)
    assert [k for k, _ in await watchdog.collect(agent)] == ["dlq"]


# --- what gets delivered, and how often ---------------------------------------
async def test_alarm_is_sent_once_not_every_tick(sessionmaker_, sent, superadmin, no_dlq):
    """Level-triggered alerting trains an operator to filter the alert, and a
    filtered alert is worse than none because it is believed to be covering
    something."""
    agent = FakeAgent(containers=[
        {"name": "vision", "status": "exited", "health": None, "exit_code": 1},
    ])
    state: dict = {}
    assert await watchdog.tick(sessionmaker_, state, agent) == ["container:vision"]
    assert await watchdog.tick(sessionmaker_, state, agent) == []
    assert await watchdog.tick(sessionmaker_, state, agent) == []
    assert len(sent) == 1


async def test_standing_alarm_is_re_sent_after_the_rearm_window(
    sessionmaker_, sent, superadmin, no_dlq, monkeypatch
):
    """A problem nobody fixed must not be forgotten — just not repeated hourly."""
    monkeypatch.setattr(watchdog, "REARM_SEC", 0)
    agent = FakeAgent(containers=[
        {"name": "vision", "status": "exited", "health": None, "exit_code": 1},
    ])
    state: dict = {}
    await watchdog.tick(sessionmaker_, state, agent)
    await watchdog.tick(sessionmaker_, state, agent)
    assert len(sent) == 2
    assert "still open" in sent[1]["title"]


async def test_recovery_is_reported(sessionmaker_, sent, superadmin, no_dlq):
    """"It came back" is the other half of the information."""
    bad = FakeAgent(containers=[
        {"name": "vision", "status": "exited", "health": None, "exit_code": 1},
    ])
    good = FakeAgent(containers=[
        {"name": "vision", "status": "running", "health": "healthy", "exit_code": None},
    ])
    state: dict = {}
    await watchdog.tick(sessionmaker_, state, bad)
    await watchdog.tick(sessionmaker_, state, good)
    assert len(sent) == 2
    assert "cleared" in sent[1]["title"]
    # And having cleared, it stays quiet.
    await watchdog.tick(sessionmaker_, state, good)
    assert len(sent) == 2


async def test_superadmins_are_the_recipients(sessionmaker_, sent, db, admin_role, no_dlq):
    """A disk, a container and a queue belong to whoever runs the box, not to a
    tenant whose own data is unaffected."""
    await make_user(db, "tenant-admin@example.com", admin_role, superadmin=False)
    await make_user(db, "platform@example.com", admin_role, superadmin=True)
    agent = FakeAgent(containers=[
        {"name": "vision", "status": "exited", "health": None, "exit_code": 1},
    ])
    await watchdog.tick(sessionmaker_, {}, agent)
    assert sent[0]["email_to"] == ["platform@example.com"]


async def test_a_failed_delivery_does_not_re_arm_the_alarm(
    sessionmaker_, superadmin, no_dlq, monkeypatch
):
    """Losing the delivery must not lose the state change, or the next tick treats
    a raised alarm as newly raised and alerts about it again."""
    calls = []

    async def _boom(db, **kwargs):
        calls.append(kwargs)
        raise RuntimeError("smtp down")

    monkeypatch.setattr(watchdog, "notify", _boom)
    agent = FakeAgent(containers=[
        {"name": "vision", "status": "exited", "health": None, "exit_code": 1},
    ])
    state: dict = {}
    await watchdog.tick(sessionmaker_, state, agent)
    await watchdog.tick(sessionmaker_, state, agent)
    assert len(calls) == 1


async def test_no_superadmin_is_not_a_crash(sessionmaker_, sent, no_dlq):
    agent = FakeAgent(containers=[
        {"name": "vision", "status": "exited", "health": None, "exit_code": 1},
    ])
    assert await watchdog.tick(sessionmaker_, {}, agent) == []
    assert sent == []


# --- the loop -----------------------------------------------------------------
async def test_the_lifespan_starts_it(sessionmaker_, monkeypatch):
    """Nothing else does. This is the same property test_retention_sweeps pins for
    the sweeper, and for the same reason: the missing piece was never the logic."""
    import app.main as main

    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def fake_watch(sessionmaker):
        started.set()
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    async def fake_sweep(sessionmaker):
        await asyncio.sleep(3600)

    monkeypatch.setattr(main, "watch_forever", fake_watch)
    monkeypatch.setattr(main, "sweep_forever", fake_sweep)
    monkeypatch.setattr(main.events_nats, "connect", lambda: asyncio.sleep(0))
    monkeypatch.setattr(main.events_nats, "close", lambda: asyncio.sleep(0))
    monkeypatch.setattr(main.events_nats, "publish", lambda *a, **k: asyncio.sleep(0))
    monkeypatch.setattr(main, "install_signal_handlers", lambda: None)

    async def _no_seed(*a, **k):
        return None

    monkeypatch.setattr(main, "get_sessionmaker", lambda: sessionmaker_)
    monkeypatch.setattr(main, "seed_tenancy", _no_seed)
    monkeypatch.setattr(main, "seed_modules", _no_seed)
    monkeypatch.setattr(main, "seed_brands", _no_seed)
    monkeypatch.setattr(main, "get_settings", lambda: type("S", (), {
        "bootstrap_admin_email": None, "bootstrap_admin_password": None
    })())

    async with main.lifespan(None):
        await asyncio.wait_for(started.wait(), timeout=2)
    await asyncio.wait_for(cancelled.wait(), timeout=2)


async def test_the_loop_survives_a_failing_poll(sessionmaker_, monkeypatch):
    """A watchdog that dies on its first bad poll is a watchdog that reports
    nothing for the rest of the appliance's uptime."""
    calls = []

    async def _boom(sessionmaker, state, agent=None):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("agent exploded")
        return []

    monkeypatch.setattr(watchdog, "tick", _boom)
    monkeypatch.setattr(watchdog, "INTERVAL_SEC", 0)
    task = asyncio.create_task(watchdog.watch_forever(sessionmaker_))
    for _ in range(50):
        await asyncio.sleep(0)
        if len(calls) >= 2:
            break
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert len(calls) >= 2
