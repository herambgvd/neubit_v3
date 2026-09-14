"""THAT A READING IS NEVER ACKNOWLEDGED UNLESS IT WAS STORED.

This is the one property the whole pipeline exists for, and it is the one that
fails silently. An ack is a promise to JetStream that the service is done with a
message; the stream then drops it. If an ack is sent for a batch that did not
commit, the readings are gone — not delayed, gone — and every surface stays
green: the connection is up, the consumer is caught up (because it is, the
messages were acked), and the hypertable simply has a hole in it that nobody is
looking for.

The seams below were extracted last week, which is what made these lines "new"
and what makes them worth pinning now:

* `_write_with_retries` — returns the result, or None. None means "go back to
  the stream", and it is the ONLY way the caller learns the batch failed.
* `_ack_written` / `_nak_batch` — mutually exclusive, and a batch that took the
  wrong one either loses readings or replays them forever.
* `_parse_messages` — the keep/rows pairing. Acks are sent per MESSAGE; rows are
  written per READING. If the two lists ever fall out of step, a message whose
  reading was never in the batch gets acked anyway.
* `_note_fetch_failure` — a streak recreates the consumer. Without it, a durable
  deleted out of band is a permanent wedge that reports healthy.

Nothing here touches NATS or a database: the subscription, the messages and the
sessionmaker are stubs, which is the only way to hold "every write fails" open
on demand. What Postgres does with the batch is `write_batch`'s business and
needs a live TimescaleDB; what is asserted here is the ACK DECISION, which is
pure once the write has returned.
"""

from __future__ import annotations

import asyncio
import datetime as dt
from dataclasses import replace
import json
import uuid

import pytest

from app.config import WriterConfig
from app.metrics import Metrics
from app.pipeline import REBIND_AFTER_FAILURES, Pipeline

TENANT = uuid.uuid4()


def run(coro):
    """The house pattern (see metric_fakes.run): drive one coroutine."""
    return asyncio.run(coro)


# ── stubs ────────────────────────────────────────────────────────────────────


class _Msg:
    """A JetStream message that records which disposition it was given.

    Recording rather than asserting: the interesting failures are a message that
    got BOTH (acked then nak'd) and a message that got NEITHER (silently dropped
    out of the loop), and only a record of every call can see either.
    """

    def __init__(self, body: dict | bytes, *, subject: str = "tenant.t1.iot.reading.x"):
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


def reading(point_id: str | None = None, value: float = 21.5) -> dict:
    """A gateway envelope the parser accepts."""
    return {
        "tenant_id": "default",
        "payload": {
            "point_id": point_id or str(uuid.uuid4()),
            "device_tag": "AHU-1",
            "point_tag": "SAT",
            # `ts` is an epoch NUMBER on the wire, not an ISO string.
            "env": {"ts": dt.datetime.now(dt.timezone.utc).timestamp(), "v": value},
        },
    }


class _Result:
    """What `store.write_batch` returns."""

    def __init__(self, inserted=1, duplicates=0, points=1):
        self.rows_inserted = inserted
        self.duplicates = duplicates
        self.points_upserted = points


class _Js:
    """Enough JetStream to park a dead letter."""

    def __init__(self, fail: bool = False):
        self.published: list = []
        self.fail = fail

    async def publish(self, subject, data, headers=None):
        if self.fail:
            raise RuntimeError("dlq unavailable")
        self.published.append((subject, data, headers))


def _pipeline(*, js: _Js | None = None) -> tuple[Pipeline, Metrics]:
    m = Metrics()
    # The retry BACKOFF is real and deliberate in production; shrinking it here
    # keeps these tests about the ack decision rather than about waiting. The
    # attempt COUNT is left at the shipped value, because that is what decides
    # how long a batch is held before it goes back to the stream.
    p = Pipeline(replace(WriterConfig(), db_retry_sec=0.001), m)
    p._js = js if js is not None else _Js()
    return p, m


def _sessionmaker():
    """A sessionmaker whose sessions do nothing. `write_batch` is stubbed out in
    every test here, so the session is never actually used for anything."""

    class _S:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    return _S


# ── the write decision ───────────────────────────────────────────────────────


class TestWriteWithRetries:
    def test_a_batch_that_commits_first_time_is_written_once(self):
        """A retry loop that re-ran a successful write would double every
        reading's insert attempt, and ON CONFLICT DO NOTHING would hide it."""
        p, m = _pipeline()
        calls = []

        async def write(session, rows, cache, now):
            calls.append(rows)
            return _Result()

        with _writing(write):
            res = run(p._write_with_retries(_sessionmaker(), ["r"], 0.0))
        assert res is not None
        assert len(calls) == 1
        assert m.batch_write_failures == 0

    def test_a_batch_that_fails_every_attempt_returns_None_so_the_caller_naks(self):
        """None is the ONLY signal the writer has that the batch did not land. A
        seam that returned an empty result instead would ack a batch nothing
        stored, and the readings would leave the stream."""
        p, m = _pipeline()
        attempts = []

        async def write(session, rows, cache, now):
            attempts.append(1)
            raise RuntimeError("connection refused")

        with _writing(write):
            res = run(p._write_with_retries(_sessionmaker(), ["r"], 0.0))
        assert res is None
        assert len(attempts) == p.cfg.db_retry_attempts + 1
        assert m.batch_write_failures == len(attempts)

    def test_a_blip_is_retried_rather_than_sent_back_to_the_stream(self):
        """A two-second database hiccup NAK'd immediately becomes a redelivery
        storm across every replica at once."""
        p, _ = _pipeline()
        n = {"i": 0}

        async def write(session, rows, cache, now):
            n["i"] += 1
            if n["i"] == 1:
                raise RuntimeError("blip")
            return _Result(inserted=3)

        with _writing(write):
            res = run(p._write_with_retries(_sessionmaker(), ["r"], 0.0))
        assert res is not None, "the retry gave up instead of committing"
        assert res.rows_inserted == 3
        assert n["i"] == 2

    def test_a_failed_attempt_forgets_the_dimension_cache(self):
        """The transaction rolled back, so the `points` rows it upserted are gone
        too. A cache that still believes it wrote them means the NEXT batch skips
        the upsert — and its readings hit a foreign key that is not there."""
        p, _ = _pipeline()
        p.cache._seen[uuid.uuid4()] = (0.0, 1)
        assert p.cache._seen

        async def write(session, rows, cache, now):
            raise RuntimeError("rollback")

        with _writing(write):
            run(p._write_with_retries(_sessionmaker(), ["r"], 0.0))
        assert p.cache._seen == {}

    def test_a_write_that_returns_is_never_left_marked_in_flight(self):
        """`begin_write`/`end_write` drive the stall watchdog. A completed write
        still marked in flight makes /readyz red forever; the balance has to hold
        on the FAILURE path too, which is the one nobody exercises."""
        p, m = _pipeline()

        async def write(session, rows, cache, now):
            raise RuntimeError("boom")

        with _writing(write):
            run(p._write_with_retries(_sessionmaker(), ["r"], 0.0))
        assert m.write_started_mono is None

    def test_a_cancellation_is_not_swallowed_as_a_write_failure(self):
        """Shutdown cancels the writer. Catching CancelledError as a retryable
        error would make the task retry through its own shutdown and hang the
        container until Docker killed it."""
        p, _ = _pipeline()

        async def write(session, rows, cache, now):
            raise asyncio.CancelledError()

        attempt = p._write_with_retries(_sessionmaker(), ["r"], 0.0)
        with _writing(write), pytest.raises(asyncio.CancelledError):
            run(attempt)


# ── ack and nak are mutually exclusive ───────────────────────────────────────


class TestAckOrNak:
    def test_a_committed_batch_acks_every_message_and_naks_none(self):
        p, m = _pipeline()
        msgs = [_Msg(reading()) for _ in range(3)]
        run(p._ack_written(msgs, _Result(inserted=3, duplicates=1, points=2)))
        assert [x.settled for x in msgs] == ["ack=1 nak=0 term=0"] * 3
        assert m.rows_inserted == 3
        assert m.rows_duplicate == 1
        assert m.db_healthy is True

    def test_a_failed_batch_naks_every_message_and_acks_none(self):
        """THE assertion. One ack here and those readings are out of the stream
        and were never written."""
        p, m = _pipeline()
        msgs = [_Msg(reading()) for _ in range(3)]
        run(p._nak_batch(msgs, ["r1", "r2", "r3"]))
        assert [x.settled for x in msgs] == ["ack=0 nak=1 term=0"] * 3
        assert m.batches_nakd == 1
        assert m.db_healthy is False

    def test_a_nak_carries_a_delay_so_a_dead_database_is_not_hammered(self):
        """Redelivered instantly against a database that is still down, this is a
        hot loop between the two services."""
        p, _ = _pipeline()
        msgs = [_Msg(reading())]
        run(p._nak_batch(msgs, ["r"]))
        assert msgs[0].nakd == [p.cfg.db_retry_sec]

    def test_one_message_that_will_not_nak_does_not_strand_the_rest(self):
        """A NAK is best-effort; the redelivery happens on ack-wait expiry
        anyway. An exception escaping here would leave the remaining messages
        neither acked nor nak'd AND kill the writer task."""
        p, _ = _pipeline()
        bad = _Msg(reading())

        async def explode(delay=None):
            raise RuntimeError("connection lost")

        bad.nak = explode
        good = _Msg(reading())
        run(p._nak_batch([bad, good], ["r1", "r2"]))
        assert good.nakd == [p.cfg.db_retry_sec]

    def test_an_ack_that_fails_after_a_successful_write_is_not_an_error(self):
        """The rows ARE stored. Turning a lost ack into a failure would NAK a
        batch that committed, and the redelivery would re-insert it — harmless
        only because of ON CONFLICT, and confusing forever in the metrics."""
        p, m = _pipeline()
        bad = _Msg(reading())

        async def explode():
            raise RuntimeError("connection lost")

        bad.ack = explode
        good = _Msg(reading())
        run(p._ack_written([bad, good], _Result()))
        assert good.acked == 1
        assert m.db_healthy is True

    def test_the_write_loop_acks_on_success_and_naks_on_failure_and_never_both(self):
        """The two seams wired together, which is the only place the choice is
        actually made."""
        for succeeds, expected in ((True, "ack=1 nak=0 term=0"), (False, "ack=0 nak=1 term=0")):
            p, _ = _pipeline()
            msgs = [_Msg(reading())]

            async def write(session, rows, cache, now, _ok=succeeds):
                if not _ok:
                    raise RuntimeError("down")
                return _Result()

            async def drive():
                p._running = True
                await p._queue.put((msgs, ["r"]))
                task = asyncio.create_task(p._write_loop())
                await p._queue.join()
                p._running = False
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task

            with _writing(write):
                run(drive())
            assert msgs[0].settled == expected, succeeds


# ── the keep/rows pairing ────────────────────────────────────────────────────


class TestParseMessages:
    def test_every_kept_message_has_a_row_and_every_row_a_message(self):
        """Acks are per MESSAGE and rows are per READING. If the lists fall out
        of step, `_ack_written` acks a message whose reading was never in the
        batch — which is exactly "acknowledging what it did not store"."""
        p, _ = _pipeline()
        msgs = [_Msg(reading()) for _ in range(4)]
        out = run(p._parse_messages(msgs))
        assert len(out["keep"]) == len(out["rows"]) == 4

    def test_a_malformed_message_is_kept_out_of_the_batch_it_has_no_row_in(self):
        """It cannot become a row, so it must not ride along as a message the
        batch will ack. Left in `keep`, it is acked on the strength of OTHER
        readings having been written."""
        p, m = _pipeline()
        good, bad = _Msg(reading()), _Msg({"payload": {"env": {}}})  # no point_id
        out = run(p._parse_messages([good, bad]))
        assert out["keep"] == [good]
        assert len(out["rows"]) == 1
        assert m.messages_malformed == 1

    def test_a_malformed_message_is_parked_before_it_is_terminated(self):
        """`term()` stops redelivery. Without the DLQ copy first, term() is a
        permanent silent delete of a body nobody can ever look at — which is what
        this used to do (contract §18)."""
        js = _Js()
        p, m = _pipeline(js=js)
        bad = _Msg({"not": "an envelope"}, subject="tenant.t1.iot.reading.x")
        run(p._parse_messages([bad]))
        assert len(js.published) == 1
        subject, data, headers = js.published[0]
        assert subject.endswith("tenant.t1.iot.reading.x")
        assert data == bad.data                       # the BODY, not a summary
        assert headers["Nbt-Dlq-Reason"]
        assert bad.termed == 1
        assert bad.acked == 0
        assert m.messages_dead_lettered == 1

    def test_a_message_that_cannot_be_parked_is_still_terminated(self):
        """An unparkable poison message that keeps being redelivered blocks the
        consumer for every other reading behind it. Losing the body is bad;
        wedging the feed is worse, and the DLQ failure is logged."""
        p, m = _pipeline(js=_Js(fail=True))
        bad = _Msg({"payload": None})
        run(p._parse_messages([bad]))
        assert bad.termed == 1
        assert m.messages_dead_lettered == 0

    def test_one_malformed_message_does_not_take_the_whole_pull_with_it(self):
        """A single bad body killing the parse would NAK (or drop) every good
        reading that arrived in the same pull."""
        p, _ = _pipeline()
        first, bad, last = _Msg(reading()), _Msg(b"{not json"), _Msg(reading())
        out = run(p._parse_messages([first, bad, last]))
        assert out["keep"] == [first, last]
        assert len(out["rows"]) == 2

    def test_the_refusal_reason_travels_with_the_parked_body(self):
        """A DLQ full of bodies and no reasons is a folder nobody can triage."""
        js = _Js()
        p, _ = _pipeline(js=js)
        run(p._parse_messages([_Msg({"payload": {"env": {}}})]))
        assert "point_id" in js.published[0][2]["Nbt-Dlq-Reason"]


# ── the fetch failure streak ─────────────────────────────────────────────────


class TestFetchFailure:
    def test_a_single_failed_pull_is_counted_and_waited_out(self):
        """A rebind can cost a full stream replay, which is far too expensive to
        spend on one blip."""
        p, m = _pipeline()
        rebinds = []
        p._rebind = lambda: _record(rebinds)
        run(p._note_fetch_failure(RuntimeError("blip"), 1))
        assert m.fetch_failures == 1
        assert rebinds == []

    def test_a_streak_recreates_the_consumer(self):
        """A durable deleted out of band fails every pull identically, forever.
        The rebind is the only exit, and without it the service reports healthy
        while consuming nothing."""
        p, _ = _pipeline()
        rebinds = []
        p._rebind = lambda: _record(rebinds)
        run(p._note_fetch_failure(RuntimeError("consumer not found"), REBIND_AFTER_FAILURES))
        assert len(rebinds) == 1

    def test_a_failed_pull_does_not_stamp_the_liveness_heartbeat(self):
        """The heartbeat means "a pull was ANSWERED". Stamping it on a failure
        makes a service whose every pull raises look perfectly alive — which is
        the wedge `consuming` was written to catch."""
        p, m = _pipeline()
        m.note_fetch_answer()
        before = m.last_fetch_answer_mono
        p._rebind = lambda: _record([])
        run(p._note_fetch_failure(RuntimeError("x"), 1))
        assert m.last_fetch_answer_mono == before


# ── helpers ──────────────────────────────────────────────────────────────────


async def _record(into: list) -> None:
    into.append(1)


import app.pipeline as _mod  # noqa: E402

_REAL_WRITE_BATCH = _mod.write_batch


class _writing:
    """Swap `pipeline.write_batch` for the duration of a block.

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
