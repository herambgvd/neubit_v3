"""That the READINGS consumer cannot be wedged and still report healthy.

The failure under test is the one `/readyz` could not see before this suite
existed. `nats_connected` says a TCP session is open, `db_healthy` says the last
write did not fail, and `consumer_pending` says how far behind the durable is —
and every one of them reads healthy for a process consuming nothing, because a
fetch loop that has stopped asking never moves any of them. `consumer_pending`
is the worst of the three: 0 means caught up AND means not fetching at all.

The other half of the bar is the NEGATIVE case, and it matters more than the
positive one. This estate polls about every five minutes and lands in bursts, so
a genuinely quiet window is normal operation. A liveness flag that reds on a
quiet night gets switched off, and then the real wedge is invisible too — so
"nothing arrived for ten minutes" is exercised here as an explicit assertion that
the flag stays GREEN, not as an afterthought.

The trap in the middle is that a pull CANNOT report a missing consumer. nats-py
classifies the server's 409 as a temporary error and re-raises it as
`nats.errors.TimeoutError` — the same exception an idle feed produces — so a
durable deleted out of band reaches the fetch loop as silence. That is why
`consuming` is two proofs ANDed, and it has its own tests below; a suite that
only exercised the heartbeat would have signed off on a flag that misses the
exact wedge it was written for.

Nothing here touches NATS or a database. The pull subscription is a stub, which
is the only way to hold "every pull fails" and "every pull cleanly times out"
open on demand.
"""

from __future__ import annotations

import asyncio

from nats.errors import TimeoutError as NatsTimeoutError

from app.config import WriterConfig
from app.metrics import Metrics
from app.pipeline import REBIND_AFTER_FAILURES, Pipeline


# ── the flag itself ──────────────────────────────────────────────────────────
def test_unarmed_metrics_never_report_themselves_wedged() -> None:
    """A Metrics nobody is driving must not red. `silence_limit_sec` defaults to
    0 so /stats before the pipeline starts, and every unit test that builds a
    bare Metrics, reads green rather than inventing an outage."""
    m = Metrics()
    assert m.silence_limit_sec == 0.0
    assert m.consuming is True
    assert m.fetch_silence_sec() == 0.0


def test_a_stamped_heartbeat_is_consuming() -> None:
    m = Metrics(silence_limit_sec=60.0)
    m.note_fetch_answer()
    m.note_consumer_seen()
    assert m.consuming is True
    assert m.fetch_silence_sec() < 1.0


def test_silence_past_the_limit_is_not_consuming() -> None:
    """Proof one: the loop stopped answering."""
    m = Metrics(silence_limit_sec=5.0)
    m.note_fetch_answer()
    m.note_consumer_seen()
    m.last_fetch_answer_mono -= 6.0      # 6s of silence against a 5s limit
    assert m.fetch_loop_alive is False
    assert m.consumer_confirmed is True  # the durable is fine; the loop is not
    assert m.consuming is False
    assert m.fetch_silence_sec() >= 6.0


def test_a_vanished_durable_is_not_consuming_even_while_the_loop_answers() -> None:
    """Proof two, and the reason there are two.

    This is the deleted-durable wedge as the process actually experiences it: the
    fetch loop keeps going round and keeps getting `TimeoutError`, because that
    is what nats-py turns the server's 409 into, so the heartbeat stays perfectly
    fresh. Only the out-of-band `consumer_info` check can tell the difference,
    and without it `consuming` would read 1 through the whole outage.
    """
    m = Metrics(silence_limit_sec=5.0)
    m.note_consumer_seen()
    m.note_fetch_answer()                # the loop is alive and answering
    m.last_consumer_seen_mono -= 6.0     # ...but the durable has been gone 6s
    m.note_consumer_missing("NotFoundError: consumer not found")
    assert m.fetch_loop_alive is True
    assert m.consumer_confirmed is False
    assert m.consuming is False
    assert m.consumer_missing and "not found" in m.consumer_missing


def test_one_failed_consumer_info_does_not_red_the_service() -> None:
    """A single failed API call during a NATS blip is not an outage. The clock
    keeps running, so a persistent failure still reds — it just takes the window
    to do it, exactly like the heartbeat."""
    m = Metrics(silence_limit_sec=60.0)
    m.note_fetch_answer()
    m.note_consumer_seen()
    m.note_consumer_missing("TimeoutError: ")
    assert m.consumer_checks_failed == 1
    assert m.consuming is True


def test_a_never_started_loop_is_not_reported_wedged() -> None:
    """`None` on either clock means it has not run yet, which `nats_connected`
    already covers. Reporting that as wedged would make every boot flap red."""
    m = Metrics(silence_limit_sec=5.0)
    assert m.last_fetch_answer_mono is None
    assert m.last_consumer_seen_mono is None
    assert m.consuming is True


def test_zero_limit_disables_both_checks() -> None:
    m = Metrics(silence_limit_sec=0.0)
    m.note_fetch_answer()
    m.note_consumer_seen()
    m.last_fetch_answer_mono -= 10_000.0
    m.last_consumer_seen_mono -= 10_000.0
    assert m.consuming is True


# ── the surfaces ─────────────────────────────────────────────────────────────
def test_snapshot_carries_the_flag_and_not_the_clock() -> None:
    m = Metrics(silence_limit_sec=60.0)
    m.note_fetch_answer()
    m.note_consumer_seen()
    snap = m.snapshot()
    assert snap["consuming"] is True
    assert "fetch_silence_sec" in snap
    assert "consumer_unconfirmed_sec" in snap
    # A monotonic clock is meaningless outside this process; exporting one would
    # invite somebody to subtract it from a wall clock.
    assert "last_fetch_answer_mono" not in snap
    assert "last_consumer_seen_mono" not in snap


def test_prometheus_names_the_readings_half_apart_from_the_projections_half() -> None:
    """A reader must be able to tell WHICH consumer is wedged. The two flags are
    the same idea with deliberately different metric names, and neither may
    appear unlabelled where the other could be mistaken for it."""
    from app.projections.metrics import Metrics as ProjectorMetrics

    m = Metrics(silence_limit_sec=60.0)
    m.note_fetch_answer()
    m.note_consumer_seen()
    m.last_fetch_answer_mono -= 999.0
    text = m.prometheus()
    assert "reading_writer_consuming 0" in text
    assert "reading_writer_fetch_silence_sec" in text
    assert "reading_writer_consumer_unconfirmed_sec" in text
    assert "reading_writer_fetch_failures_total" in text
    assert "reading_writer_consumer_checks_failed_total" in text
    assert "reading_writer_consumer_rebinds_total" in text

    pm = ProjectorMetrics()
    pm.projection("iot_alerts").consuming = True
    both = m.prometheus() + pm.prometheus()
    assert 'projector_consuming{projection="iot_alerts"} 1' in both
    # The readings flag is 0 in the very same exposition. If these two collided
    # on one name, a healthy projection would report the readings path healthy.
    assert "reading_writer_consuming 0" in both


# ── the fetch loop ───────────────────────────────────────────────────────────
class _StubSub:
    """A pull subscription that does whatever the test needs, forever."""

    def __init__(self, behaviour) -> None:
        self.behaviour = behaviour
        self.pulls = 0
        self.unsubscribed = 0

    async def fetch(self, batch, timeout=None):
        # Yield first, always. A stub that raises without ever awaiting anything
        # turns `_fetch_loop` into a tight loop that never gives the event loop
        # back, and the test hangs instead of failing — which is a stub bug that
        # looks exactly like a product bug.
        await asyncio.sleep(0.01)
        self.pulls += 1
        return await self.behaviour(self.pulls)

    async def unsubscribe(self) -> None:
        self.unsubscribed += 1


def _pipeline(behaviour) -> tuple[Pipeline, Metrics, _StubSub]:
    cfg = WriterConfig()
    m = Metrics()
    p = Pipeline(cfg, m)
    sub = _StubSub(behaviour)
    p._psub = sub
    p._running = True
    return p, m, sub


async def _run_briefly(p: Pipeline, seconds: float) -> None:
    task = asyncio.create_task(p._fetch_loop())
    await asyncio.sleep(seconds)
    p._running = False
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


def test_an_idle_window_is_not_a_fault() -> None:
    """THE NEGATIVE CASE. Nothing to consume for a long window — every pull
    expires server-side — and the flag must stay green. Ten minutes of estate
    silence is simulated by ageing the clock the loop is being judged against;
    what proves the point is that the loop keeps ANSWERING while it does."""

    async def idle(_n):
        raise NatsTimeoutError

    p, m, sub = _pipeline(idle)
    m.silence_limit_sec = 60.0
    m.note_consumer_seen()               # the stats loop's half, held true here
    asyncio.run(_run_briefly(p, 0.2))

    assert sub.pulls > 1                     # the loop really iterated
    assert m.messages_received == 0          # and really received nothing
    assert m.fetch_failures == 0             # an expired pull is NOT a failure
    assert m.last_error is None              # nor a spurious /stats error
    assert m.consuming is True               # ...and the estate is not "wedged"


def test_asyncio_timeouts_count_as_answers_too() -> None:
    """nats-py raises its own TimeoutError when the pull expires server-side and
    asyncio's when the client-side wait does. Treating the second as a failure
    would make a quiet feed accumulate `fetch_failures` and eventually rebind —
    a full stream replay caused by nothing happening."""

    async def idle(_n):
        raise asyncio.TimeoutError

    p, m, sub = _pipeline(idle)
    m.silence_limit_sec = 60.0
    asyncio.run(_run_briefly(p, 0.2))
    assert sub.pulls > 1
    assert m.fetch_failures == 0
    assert m.consuming is True


def test_failing_pulls_stop_stamping_and_go_red() -> None:
    """The wedge: every pull raises, as it does when the durable was deleted out
    of band. The heartbeat must go stale — that is what turns /readyz red — while
    the connection and the database are untouched and still look fine."""

    async def broken(_n):
        raise RuntimeError("nats: no responders available for request")

    p, m, sub = _pipeline(broken)
    m.silence_limit_sec = 60.0
    m.nats_connected = True
    m.db_healthy = True
    rebinds: list[int] = []

    async def _fake_rebind() -> None:
        rebinds.append(sub.pulls)

    p._rebind = _fake_rebind
    asyncio.run(_run_briefly(p, 3.5))

    assert m.fetch_failures >= REBIND_AFTER_FAILURES
    assert m.last_error and "no responders" in m.last_error
    assert rebinds, "a failure streak must recreate the consumer, not retry forever"
    assert sub.pulls >= REBIND_AFTER_FAILURES
    # The three signals that used to be the whole of /readyz, all still green.
    assert m.nats_connected is True
    assert m.db_healthy is True
    assert m.consumer_pending == 0
    # And the one that is not: aged past the limit, the flag flips.
    m.last_fetch_answer_mono -= 120.0
    assert m.consuming is False


def test_one_bad_pull_does_not_trigger_a_replay() -> None:
    """A rebind can cost a full stream replay, so a single hiccup must not buy
    one. The streak resets the moment a pull is answered."""
    seq = {"n": 0}

    async def flaky(_n):
        seq["n"] += 1
        if seq["n"] % 2 == 1:
            raise RuntimeError("transient")
        raise NatsTimeoutError

    p, m, sub = _pipeline(flaky)
    m.silence_limit_sec = 60.0
    rebinds: list[int] = []

    async def _fake_rebind() -> None:
        rebinds.append(1)

    p._rebind = _fake_rebind
    asyncio.run(_run_briefly(p, 3.5))

    assert m.fetch_failures >= 1
    assert not rebinds, "an alternating failure never reached three in a row"
    assert m.consuming is True


def test_a_paused_database_is_not_reported_as_a_wedged_consumer() -> None:
    """When the database is down the loop deliberately stops pulling. It is still
    alive, and `db_healthy` already names the fault — letting the silence
    accumulate here would add a second, wrong reason and send an operator after
    the bus instead of Postgres."""

    async def never(_n):
        raise AssertionError("must not pull while the database is unhealthy")

    p, m, sub = _pipeline(never)
    m.silence_limit_sec = 60.0
    m.db_healthy = False
    asyncio.run(_run_briefly(p, 0.3))

    assert sub.pulls == 0
    assert m.consuming is True


# ── the stats loop, which is the only thing that can see a missing durable ────
class _StubJs:
    """A JetStream context that answers consumer_info however the test needs."""

    def __init__(self, answer) -> None:
        self.answer = answer
        self.calls = 0

    async def consumer_info(self, stream, durable):
        self.calls += 1
        await asyncio.sleep(0.01)
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


class _Cfg:
    def __init__(self, deliver_subject=None, filter_subject="tenant.*.iot.reading.>"):
        self.deliver_subject = deliver_subject
        self.filter_subject = filter_subject


class _Info:
    def __init__(self, cfg):
        self.config = cfg
        self.num_pending = 0
        self.num_ack_pending = 0
        self.num_redelivered = 0


def test_a_deleted_durable_is_seen_by_the_stats_loop_and_a_rebind_requested() -> None:
    """The wedge, end to end at the seam that can actually observe it.

    `consumer_info` raising is the ONLY evidence the process gets that the
    durable is gone — the fetch loop's pulls come back as ordinary idle timeouts.
    So this failure has to mark the consumer unconfirmed and ask for a rebind;
    if it only logged, as it did before, the wedge would be permanent.
    """
    cfg = WriterConfig()
    m = Metrics(silence_limit_sec=cfg.fetch_silence_sec)
    p = Pipeline(cfg, m)
    p._js = _StubJs(RuntimeError("nats: consumer not found"))
    m.note_consumer_seen()

    asyncio.run(_stats_tick(p))

    assert m.consumer_missing and "not found" in m.consumer_missing
    assert m.consumer_checks_failed >= 1
    assert p._rebind_requested is True
    # Aged past the window, that is what turns /readyz red.
    m.last_consumer_seen_mono -= cfg.fetch_silence_sec + 1
    assert m.consuming is False


def test_a_consumer_that_is_never_confirmed_reds_after_the_window() -> None:
    """The clock starts at bind, not at the first success.

    Without that seed a durable that was ALREADY wrong when the process started
    leaves `last_consumer_seen_mono` unset forever, and an unset clock reads as
    0s unconfirmed — green, permanently, through exactly the fault the flag is
    for. Observed on the live stack before this was fixed.
    """
    m = Metrics(silence_limit_sec=5.0)
    m.note_consumer_seen()               # what _bind_consumer does: start the clock
    m.note_consumer_missing("it is a PUSH consumer; this service pulls")
    assert m.consuming is True           # inside the window, still green
    m.last_consumer_seen_mono -= 6.0
    assert m.consumer_confirmed is False
    assert m.consuming is False


def test_a_durable_of_the_right_name_but_the_wrong_shape_is_not_ours() -> None:
    """Present is not enough. A push consumer squatting on the durable name
    answers every pull with a 409, which nats-py hands back as an idle timeout —
    so `consumer_info` returning successfully still has to be CHECKED."""
    cfg = WriterConfig()
    m = Metrics(silence_limit_sec=cfg.fetch_silence_sec)
    p = Pipeline(cfg, m)
    p._js = _StubJs(_Info(_Cfg(deliver_subject="_someone.elses.inbox")))
    m.note_consumer_seen()

    asyncio.run(_stats_tick(p))

    assert m.consumer_missing and "PUSH" in m.consumer_missing
    # NOT a rebind: pull_subscribe would bind to the impostor again and report
    # success. The remedy for a squatted durable name is a human, not a retry.
    assert p._rebind_requested is False


def test_a_durable_on_a_different_filter_is_not_ours_either() -> None:
    cfg = WriterConfig()
    m = Metrics(silence_limit_sec=cfg.fetch_silence_sec)
    p = Pipeline(cfg, m)
    p._js = _StubJs(_Info(_Cfg(filter_subject="tenant.other.iot.reading.nope")))
    m.note_consumer_seen()

    asyncio.run(_stats_tick(p))

    assert m.consumer_missing and "filter" in m.consumer_missing
    assert p._rebind_requested is False


def test_our_own_consumer_confirms_and_still_reports_lag() -> None:
    """The happy path must keep doing the job this call was originally here for."""
    cfg = WriterConfig()
    m = Metrics(silence_limit_sec=cfg.fetch_silence_sec)
    p = Pipeline(cfg, m)
    info = _Info(_Cfg(filter_subject=cfg.subject))
    info.num_pending = 7
    p._js = _StubJs(info)

    asyncio.run(_stats_tick(p))

    assert m.consumer_missing is None
    assert m.consumer_confirmed is True
    assert m.consumer_pending == 7
    assert p._rebind_requested is False


async def _stats_tick(p: Pipeline) -> None:
    """One pass of the stats loop without waiting out `stats_every_sec`."""
    p._running = True
    object.__setattr__(p.cfg, "stats_every_sec", 0)
    task = asyncio.create_task(p._stats_loop())
    await asyncio.sleep(0.05)
    p._running = False
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


# ── the projections half, which turned out to have the same 409 hole ──────────
# Kept in this file on purpose: the two halves are one finding, and splitting
# them invites somebody to fix one and leave the other, which is exactly what
# happened once already.
def test_projection_consuming_flag_alone_reads_green_through_a_hijacked_durable() -> None:
    """Why the projections half needed a second proof and not just its flag.

    The assigned flag is set from the fetch loop's FAILURE branch. A durable
    whose name is held by a push consumer never reaches that branch — the
    server's 409 arrives as a TimeoutError, i.e. the IDLE branch, which sets
    `consuming` back to True. So the flag is true and the projection is dead.
    """
    from app.projections.metrics import ProjectionMetrics

    pm = ProjectionMetrics(key="access_events", running=True, silence_limit_sec=5.0)
    pm.note_consumer_seen()
    pm.consuming = True                  # what the idle branch keeps doing
    pm.note_consumer_missing("it is a PUSH consumer; this projection pulls")
    assert pm.is_consuming is True       # inside the window, still green
    pm.last_consumer_seen_mono -= 6.0
    assert pm.consuming is True          # the old flag: still, wrongly, true
    assert pm.consumer_confirmed is False
    assert pm.is_consuming is False      # the one /readyz and /metrics now use


def test_projections_readiness_separates_the_two_faults() -> None:
    """`not_consuming` and `not_confirmed` are different faults with different
    fixes, and a running projection must land in exactly the right list."""
    from app.projections.metrics import Metrics as ProjectorMetrics

    m = ProjectorMetrics()
    wedged = m.projection("access_events")
    wedged.running, wedged.silence_limit_sec = True, 5.0
    wedged.note_consumer_seen()
    wedged.note_consumer_missing("it is a PUSH consumer; this projection pulls")
    wedged.last_consumer_seen_mono -= 6.0

    failing = m.projection("iot_alerts")
    failing.running, failing.silence_limit_sec = True, 5.0
    failing.note_consumer_seen()
    failing.consuming = False            # what the failure branch does

    assert m.not_consuming == ["iot_alerts"]
    assert [k for k, _ in m.not_confirmed] == ["access_events"]
    assert "PUSH" in dict(m.not_confirmed)["access_events"]


def test_projector_consuming_metric_exposes_both_proofs() -> None:
    from app.projections.metrics import Metrics as ProjectorMetrics

    m = ProjectorMetrics()
    p = m.projection("access_events")
    p.running, p.silence_limit_sec = True, 5.0
    p.note_consumer_seen()
    p.last_consumer_seen_mono -= 6.0
    text = m.prometheus()
    assert 'projector_consuming{projection="access_events"} 0' in text
    assert 'projector_consumer_unconfirmed_sec{projection="access_events"}' in text
    assert 'projector_consumer_checks_failed_total{projection="access_events"}' in text


def test_an_unarmed_projection_never_reds_itself() -> None:
    """A ProjectionMetrics nobody is driving — a test, or /stats before the
    worker starts — must not invent an outage."""
    from app.projections.metrics import ProjectionMetrics

    pm = ProjectionMetrics(key="x", running=True)
    assert pm.silence_limit_sec == 0.0
    assert pm.consumer_confirmed is True
    assert pm.is_consuming is True
