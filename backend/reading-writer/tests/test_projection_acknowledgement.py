"""THAT A PROJECTED EVENT IS NEVER ACKNOWLEDGED UNLESS IT WAS STORED.

The readings half of this service has the same property and its own test file;
this is the projections half, and it is the one that is easier to get wrong,
because a Worker is per-projection: its counters, its queue, its durable and its
stall clock are all keyed by `row.key`. A seam that forgot the key would report
one projection's failure against another's name — and the operator would restart
the wrong consumer.

The seams pinned here were extracted last week:

* `_write_with_retries` — None means "the batch did not land", which is the only
  thing that stands between a failed write and an ack.
* `_ack_written` / `_nak_batch` — a batch takes exactly one of them.
* `_extract_messages` — the keep/rows pairing. A message whose row was never
  built must not be in the list the batch acks.
* `_note_fetch_failure` — a streak turns `consuming` off (which reds /readyz)
  AND recreates the durable. Before it, a durable deleted out of band meant
  every pull failed identically, nothing was projected, and /readyz stayed green
  through the whole outage.

Nothing here touches NATS or a database. What Postgres does with a batch is
`projections.store.write_batch`'s business and needs a live TimescaleDB; the ACK
DECISION is pure once the write has returned, and that is what is asserted.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import replace

import pytest

from app.projections.config import ProjectorConfig
from app.projections.metrics import Metrics
from app.projections.pipeline import REBIND_AFTER_FAILURES, Worker
from app.projections.spec import ProjectionRow
from app.tenants import TenantResolver

KEY = "iot_alerts"

#: A minimal but REAL projection spec — the same model the registry table parses,
#: so a change that makes the shipped specs unparseable fails here too.
SPEC = {
    "key": KEY,
    "name": "IoT alerts",
    "spec": {
        "source": {
            "stream": "EVENTS",
            "subject": "tenant.*.iot.alert.>",
            "durable": "reporting-projector-iot-alerts",
        },
        "target": {
            "relation": "iot_alerts",
            "time_column": "occurred_at",
            "natural_key": ["event_id", "occurred_at"],
            "columns": [
                {"name": "event_id", "type": "uuid", "source": "event_id", "required": True},
                {"name": "occurred_at", "type": "timestamptz", "source": "occurred_at",
                 "required": True},
                {"name": "tenant_id", "type": "uuid", "source": "tenant_id", "tenant": True},
                {"name": "severity", "type": "text", "source": "payload.severity"},
            ],
        },
    },
}


def run(coro):
    """The house pattern (see metric_fakes.run): drive one coroutine."""
    return asyncio.run(coro)


# ── stubs ────────────────────────────────────────────────────────────────────


class _Msg:
    """A JetStream message that records which disposition it was given.

    Recording rather than asserting: the failures that matter are a message that
    got BOTH dispositions and one that got NEITHER, and only a record of every
    call can see either.
    """

    def __init__(self, body: dict | bytes, *, subject: str = "tenant.t1.iot.alert.x"):
        self.subject = subject
        self.data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.acked = 0
        self.nakd: list = []
        self.termed = 0
        self.metadata = type("_M", (), {"num_delivered": 1})()

    async def ack(self) -> None:
        self.acked += 1

    async def nak(self, delay=None) -> None:
        self.nakd.append(delay)

    async def term(self) -> None:
        self.termed += 1

    @property
    def settled(self) -> str:
        return f"ack={self.acked} nak={len(self.nakd)} term={self.termed}"


def event(**over) -> dict:
    """A spine envelope the extractor accepts."""
    body = {
        "event_id": str(uuid.uuid4()),
        "occurred_at": "2026-03-01T10:00:00+00:00",
        "tenant_id": "default",
        "payload": {"severity": "critical"},
    }
    body.update(over)
    return body


class _Result:
    """What `projections.store.write_batch` returns."""

    def __init__(self, inserted=1, duplicates=0, enriched=0):
        self.rows_inserted = inserted
        self.duplicates = duplicates
        self.rows_enriched = enriched


class _Js:
    """Enough JetStream to park a dead letter."""

    def __init__(self, fail: bool = False):
        self.published: list = []
        self.fail = fail

    async def publish(self, subject, data, headers=None):
        if self.fail:
            raise RuntimeError("dlq unavailable")
        self.published.append((subject, data, headers))


def _worker(*, js: _Js | None = None) -> tuple[Worker, Metrics]:
    m = Metrics()
    # The retry BACKOFF is real in production; shrinking it keeps these tests
    # about the ack decision rather than about waiting. The attempt COUNT stays
    # at the shipped value — that is what decides how long a batch is held.
    cfg = replace(ProjectorConfig(), db_retry_sec=0.001)
    w = Worker(ProjectionRow.model_validate(SPEC), cfg, m, TenantResolver.from_env())
    w._js = js if js is not None else _Js()
    return w, m


def _sessionmaker():
    class _S:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    return _S


# ── the write decision ───────────────────────────────────────────────────────


class TestWriteWithRetries:
    def test_a_batch_that_commits_first_time_is_written_once(self):
        w, m = _worker()
        calls = []

        async def write(session, proj, rows):
            calls.append(rows)
            return _Result()

        with _writing(write):
            res = run(w._write_with_retries(_sessionmaker(), w.row.spec, ["r"]))
        assert res is not None
        assert len(calls) == 1
        assert m.projection(KEY).batch_write_failures == 0

    def test_a_batch_that_fails_every_attempt_returns_None_so_the_caller_naks(self):
        """None is the ONLY signal the writer has. A seam returning an empty
        result instead would ack a batch nothing stored, and those events would
        leave the stream for good."""
        w, m = _worker()
        attempts = []

        async def write(session, proj, rows):
            attempts.append(1)
            raise RuntimeError("connection refused")

        with _writing(write):
            res = run(w._write_with_retries(_sessionmaker(), w.row.spec, ["r"]))
        assert res is None
        assert len(attempts) == w.cfg.db_retry_attempts + 1
        assert m.projection(KEY).batch_write_failures == len(attempts)

    def test_a_blip_is_retried_rather_than_sent_back_to_the_stream(self):
        w, _ = _worker()
        n = {"i": 0}

        async def write(session, proj, rows):
            n["i"] += 1
            if n["i"] == 1:
                raise RuntimeError("blip")
            return _Result(inserted=5)

        with _writing(write):
            res = run(w._write_with_retries(_sessionmaker(), w.row.spec, ["r"]))
        assert res is not None, "the retry gave up instead of committing"
        assert res.rows_inserted == 5
        assert n["i"] == 2

    def test_a_failed_write_leaves_no_batch_marked_in_flight_for_this_projection(self):
        """The stall clock is keyed by projection. A failed write that never
        cleared its key makes `write_stalled_sec` climb forever, and /readyz
        reports a stuck database for a projection that is simply idle."""
        w, m = _worker()

        async def write(session, proj, rows):
            raise RuntimeError("boom")

        with _writing(write):
            run(w._write_with_retries(_sessionmaker(), w.row.spec, ["r"]))
        assert m.writes_in_flight == {}
        assert m.write_stalled_sec() == 0.0

    def test_an_in_flight_write_is_recorded_under_its_own_projection_key(self):
        """Keyed by the wrong name and the operator restarts the wrong consumer."""
        w, m = _worker()
        seen = {}

        async def write(session, proj, rows):
            seen.update(m.writes_in_flight)
            return _Result()

        with _writing(write):
            run(w._write_with_retries(_sessionmaker(), w.row.spec, ["r"]))
        assert list(seen) == [KEY]

    def test_a_cancellation_is_not_swallowed_as_a_write_failure(self):
        """Shutdown cancels the writer. Retrying through its own cancellation
        hangs the container until Docker kills it."""
        w, _ = _worker()

        async def write(session, proj, rows):
            raise asyncio.CancelledError()

        attempt = w._write_with_retries(_sessionmaker(), w.row.spec, ["r"])
        with _writing(write), pytest.raises(asyncio.CancelledError):
            run(attempt)


# ── ack and nak are mutually exclusive ───────────────────────────────────────


class TestAckOrNak:
    def test_a_committed_batch_acks_every_message_and_naks_none(self):
        w, m = _worker()
        msgs = [_Msg(event()) for _ in range(3)]
        run(w._ack_written(msgs, _Result(inserted=2, duplicates=1, enriched=4)))
        assert [x.settled for x in msgs] == ["ack=1 nak=0 term=0"] * 3
        pm = m.projection(KEY)
        assert (pm.rows_inserted, pm.rows_duplicate, pm.rows_enriched) == (2, 1, 4)
        assert m.db_healthy is True

    def test_a_failed_batch_naks_every_message_and_acks_none(self):
        """THE assertion. One ack here and those events are out of the stream and
        were never written to the projection's relation."""
        w, m = _worker()
        msgs = [_Msg(event()) for _ in range(3)]
        run(w._nak_batch(msgs, ["r1", "r2", "r3"]))
        assert [x.settled for x in msgs] == ["ack=0 nak=1 term=0"] * 3
        assert m.projection(KEY).batches_nakd == 1
        assert m.db_healthy is False

    def test_a_nak_carries_a_delay_so_a_dead_database_is_not_hammered(self):
        w, _ = _worker()
        msgs = [_Msg(event())]
        run(w._nak_batch(msgs, ["r"]))
        assert msgs[0].nakd == [w.cfg.db_retry_sec]

    def test_one_message_that_will_not_nak_does_not_strand_the_rest(self):
        """An exception escaping here leaves the remaining messages neither acked
        nor nak'd AND kills the writer task, which stops the projection dead."""
        w, _ = _worker()
        bad = _Msg(event())

        async def explode(delay=None):
            raise RuntimeError("connection lost")

        bad.nak = explode
        good = _Msg(event())
        run(w._nak_batch([bad, good], ["r1", "r2"]))
        assert good.nakd == [w.cfg.db_retry_sec]

    def test_an_ack_that_fails_after_a_successful_write_is_not_an_error(self):
        """The rows ARE stored. A lost ack costs a redelivery, which the natural
        key absorbs; turning it into a failure would NAK a committed batch."""
        w, m = _worker()
        bad = _Msg(event())

        async def explode():
            raise RuntimeError("connection lost")

        bad.ack = explode
        good = _Msg(event())
        run(w._ack_written([bad, good], _Result()))
        assert good.acked == 1
        assert m.db_healthy is True

    def test_the_write_loop_acks_on_success_and_naks_on_failure_and_never_both(self):
        """The two seams wired together, which is the only place the choice is
        actually made."""
        for succeeds, expected in ((True, "ack=1 nak=0 term=0"), (False, "ack=0 nak=1 term=0")):
            w, _ = _worker()
            msgs = [_Msg(event())]

            async def write(session, proj, rows, _ok=succeeds):
                if not _ok:
                    raise RuntimeError("down")
                return _Result()

            async def drive():
                w._running = True
                await w._queue.put((msgs, ["r"]))
                task = asyncio.create_task(w._write_loop())
                await w._queue.join()
                w._running = False
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task

            with _writing(write):
                run(drive())
            assert msgs[0].settled == expected, succeeds


# ── the keep/rows pairing ────────────────────────────────────────────────────


class TestExtractMessages:
    def test_every_kept_message_has_a_row_and_every_row_a_message(self):
        """Acks are per MESSAGE, rows are per EVENT. Out of step, `_ack_written`
        acks a message whose row was never in the batch — which is precisely
        "acknowledging what it did not store"."""
        w, _ = _worker()
        msgs = [_Msg(event()) for _ in range(4)]
        out = run(w._extract_messages(msgs, w.row.spec))
        assert len(out["keep"]) == len(out["rows"]) == 4

    def test_a_row_carries_the_columns_the_spec_declared_and_nothing_else(self):
        """A column dropped from the extraction is a column that is NULL in the
        relation forever, and no error anywhere says so."""
        w, _ = _worker()
        out = run(w._extract_messages([_Msg(event())], w.row.spec))
        assert set(out["rows"][0]) == {"event_id", "occurred_at", "tenant_id", "severity"}
        assert out["rows"][0]["severity"] == "critical"

    def test_a_message_missing_a_required_column_is_kept_out_of_the_batch(self):
        """It can never become a row, so it must not ride along as a message the
        batch will ack on the strength of OTHER events having been written."""
        w, m = _worker()
        good = _Msg(event())
        bad = _Msg(event(event_id=None))       # required uuid, absent
        out = run(w._extract_messages([good, bad], w.row.spec))
        assert out["keep"] == [good]
        assert len(out["rows"]) == 1
        assert m.projection(KEY).messages_malformed == 1

    def test_a_malformed_message_is_parked_before_it_is_terminated(self):
        """`term()` stops redelivery. Without the DLQ copy first it is a silent
        permanent delete of a body nobody can look at (contract §18)."""
        js = _Js()
        w, m = _worker(js=js)
        bad = _Msg(b"{not json", subject="tenant.t1.iot.alert.x")
        run(w._extract_messages([bad], w.row.spec))
        assert len(js.published) == 1
        subject, data, headers = js.published[0]
        assert subject.endswith("tenant.t1.iot.alert.x")
        assert data == bad.data                       # the BODY, not a summary
        assert headers["Nbt-Dlq-Consumer"] == SPEC["spec"]["source"]["durable"]
        assert headers["Nbt-Dlq-Reason"]
        assert bad.termed == 1
        assert bad.acked == 0
        assert m.projection(KEY).messages_dead_lettered == 1

    def test_a_message_that_cannot_be_parked_is_still_terminated(self):
        """An unparkable poison message redelivered forever blocks the consumer
        for every event behind it. Losing the body is bad; wedging the projection
        is worse, and the DLQ failure is logged."""
        w, m = _worker(js=_Js(fail=True))
        bad = _Msg(b"[]")                      # decodes, but is not an object
        run(w._extract_messages([bad], w.row.spec))
        assert bad.termed == 1
        assert m.projection(KEY).messages_dead_lettered == 0

    def test_one_malformed_message_does_not_take_the_whole_pull_with_it(self):
        """A single bad body killing the extraction would cost every good event
        that arrived in the same pull."""
        w, _ = _worker()
        first, bad, last = _Msg(event()), _Msg(b"{not json"), _Msg(event())
        out = run(w._extract_messages([first, bad, last], w.row.spec))
        assert out["keep"] == [first, last]
        assert len(out["rows"]) == 2


# ── the fetch failure streak ─────────────────────────────────────────────────


class TestFetchFailure:
    def test_a_single_failed_pull_leaves_the_projection_reading_as_consuming(self):
        """A rebind can cost a stream replay, which is far too expensive to spend
        on one blip — and one failed pull is not an outage."""
        w, m = _worker()
        m.projection(KEY).consuming = True
        rebinds = []
        w._rebind = lambda: _record(rebinds)
        run(w._note_fetch_failure(RuntimeError("blip"), 1))
        assert m.projection(KEY).fetch_failures == 1
        assert m.projection(KEY).consuming is True
        assert rebinds == []

    def test_a_streak_stops_claiming_to_consume_and_recreates_the_durable(self):
        """A durable deleted out of band fails every pull identically, forever.
        Before this, the projection consumed nothing and /readyz stayed green
        through the entire outage."""
        w, m = _worker()
        m.projection(KEY).consuming = True
        rebinds = []
        w._rebind = lambda: _record(rebinds)
        run(w._note_fetch_failure(RuntimeError("consumer not found"), REBIND_AFTER_FAILURES))
        assert m.projection(KEY).consuming is False
        assert len(rebinds) == 1

    def test_the_failure_is_recorded_against_this_projection_and_not_the_others(self):
        """Per-projection counters are the only way an operator learns WHICH
        consumer is wedged. Counted globally, one healthy projection's traffic
        hides another's outage."""
        w, m = _worker()
        m.projection("other_projection")
        w._rebind = lambda: _record([])
        run(w._note_fetch_failure(RuntimeError("x"), 1))
        assert m.projection(KEY).fetch_failures == 1
        assert m.projection("other_projection").fetch_failures == 0


# ── helpers ──────────────────────────────────────────────────────────────────


async def _record(into: list) -> None:
    into.append(1)


import app.projections.pipeline as _mod  # noqa: E402

_REAL_WRITE_BATCH = _mod.write_batch


class _writing:
    """Swap `projections.pipeline.write_batch` for the duration of a block.

    A context manager rather than monkeypatch because several of these tests
    drive a real asyncio task and need the swap to outlive the coroutine that
    started it.
    """

    def __init__(self, fn):
        self.fn = fn

    def __enter__(self):
        _mod.write_batch = self.fn
        return self

    def __exit__(self, *exc):
        _mod.write_batch = _REAL_WRITE_BATCH
        return False


# ── the fetch loop ───────────────────────────────────────────────────────────
#
# The loop itself, driven against a stub subscription. Three of its branches
# decide whether events are lost, and none of them raises when it is wrong:
# an idle timeout treated as an error makes a quiet feed cry wolf until the
# health surface is ignored; a full queue that DROPPED instead of blocking loses
# events with no counter moving; and a pull taken while the database is down
# fills the queue with work that cannot be written.


class _StubSub:
    """A pull subscription that does whatever the test needs, forever."""

    def __init__(self, behaviour) -> None:
        self.behaviour = behaviour
        self.pulls = 0

    async def fetch(self, batch, timeout=None):
        # Yield first, always. A stub that raises without ever awaiting turns the
        # fetch loop into a tight loop that never gives the event loop back, and
        # the test hangs instead of failing — a stub bug that looks exactly like
        # a product bug.
        await asyncio.sleep(0.005)
        self.pulls += 1
        return await self.behaviour(self.pulls)

    async def unsubscribe(self) -> None:
        pass


async def _run_briefly(w: Worker, seconds: float) -> None:
    task = asyncio.create_task(w._fetch_loop())
    await asyncio.sleep(seconds)
    w._running = False
    task.cancel()
    with contextlib_suppress(asyncio.CancelledError):
        await task


class contextlib_suppress:
    def __init__(self, *exc):
        self.exc = exc

    def __enter__(self):
        return self

    def __exit__(self, t, v, tb):
        return t is not None and issubclass(t, self.exc)

    async def __aenter__(self):
        return self

    async def __aexit__(self, t, v, tb):
        return t is not None and issubclass(t, self.exc)


class TestFetchLoop:
    def test_a_pull_that_returns_events_puts_them_on_the_queue_paired(self):
        """The queue carries (messages, rows) together. Split or reordered here,
        the writer acks one pull's messages for another pull's rows."""
        w, _ = _worker()
        msgs = [_Msg(event()) for _ in range(2)]

        async def behaviour(n):
            if n == 1:
                return msgs
            raise asyncio.CancelledError()

        w._psub = _StubSub(behaviour)
        w._running = True

        async def drive():
            await _run_briefly(w, 0.05)

        run(drive())
        assert not w._queue.empty()
        keep, rows = w._queue.get_nowait()
        assert keep == msgs
        assert len(rows) == 2

    def test_an_idle_feed_is_a_live_consumer_and_not_a_failure(self):
        """This estate polls every few minutes. A loop that counted its idle
        timeouts as errors would rebind the durable on a quiet night and park a
        spurious `last_error` on /stats — and a health surface that cries wolf
        while nothing is wrong gets switched off."""
        from nats.errors import TimeoutError as NatsTimeoutError

        w, m = _worker()

        async def behaviour(n):
            raise NatsTimeoutError()

        w._psub = _StubSub(behaviour)
        w._running = True
        run(_run_briefly(w, 0.05))
        assert m.projection(KEY).consuming is True
        assert m.projection(KEY).fetch_failures == 0

    def test_an_asyncio_timeout_is_treated_the_same_as_the_nats_one(self):
        """nats-py raises its own TimeoutError when the pull expires server-side
        and asyncio's when the client-side wait does. Handling only one of them
        made an idle feed log a warning every second."""
        w, m = _worker()

        async def behaviour(n):
            raise asyncio.TimeoutError()

        w._psub = _StubSub(behaviour)
        w._running = True
        run(_run_briefly(w, 0.05))
        assert m.projection(KEY).consuming is True
        assert m.projection(KEY).fetch_failures == 0

    def test_a_failed_pull_is_counted_waited_out_and_the_loop_survives_it(self):
        """A bad pull must never kill the task — a dead fetch loop is a
        projection that consumes nothing while the process stays up and
        healthy-looking. And it must not be retried instantly: the one-second
        wait is what stops a dead durable from becoming a hot loop against NATS,
        so a second pull inside the first 50ms would be the bug."""
        w, m = _worker()
        w._rebind = lambda: _record([])

        async def behaviour(n):
            raise RuntimeError("consumer not found")

        sub = _StubSub(behaviour)
        w._psub = sub
        w._running = True

        async def drive():
            task = asyncio.create_task(w._fetch_loop())
            await asyncio.sleep(0.05)
            alive = not task.done()
            w._running = False
            task.cancel()
            with contextlib_suppress(asyncio.CancelledError):
                await task
            return alive

        assert run(drive()) is True
        assert m.projection(KEY).fetch_failures == 1
        assert sub.pulls == 1

    def test_an_answered_pull_clears_the_failure_streak(self):
        """Otherwise a projection that fails twice a day rebinds on the third
        failure a week later — and a rebind can cost a full stream replay."""
        w, m = _worker()
        rebinds = []
        w._rebind = lambda: _record(rebinds)

        async def behaviour(n):
            if n <= REBIND_AFTER_FAILURES - 1:
                raise RuntimeError("blip")
            if n == REBIND_AFTER_FAILURES:
                return [_Msg(event())]
            raise RuntimeError("blip")

        w._psub = _StubSub(behaviour)
        w._running = True
        run(_run_briefly(w, 0.1))
        # The streak was broken by the answered pull, so the failures after it
        # start counting from one again and no rebind has been reached.
        assert rebinds == []

    def test_nothing_is_pulled_while_the_database_is_known_to_be_down(self):
        """There is nothing to gain from taking events off the bus that cannot be
        written. The backlog is safe in the stream, where it is bounded and
        visible as lag; in the queue it is neither."""
        w, m = _worker()
        m.db_healthy = False

        async def behaviour(n):
            raise AssertionError("pulled while the database was down")

        sub = _StubSub(behaviour)
        w._psub = sub
        w._running = True
        run(_run_briefly(w, 0.02))
        assert sub.pulls == 0

    def test_a_pull_of_only_malformed_events_queues_nothing_to_write(self):
        """Every message was dead-lettered and terminated. Queueing an empty
        batch would make the writer commit an empty transaction and then ack a
        list of messages that are already settled."""
        w, _ = _worker()

        async def behaviour(n):
            if n == 1:
                return [_Msg(b"{not json")]
            raise asyncio.CancelledError()

        w._psub = _StubSub(behaviour)
        w._running = True
        run(_run_briefly(w, 0.05))
        assert w._queue.empty()
