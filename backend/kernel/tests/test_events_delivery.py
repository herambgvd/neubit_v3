"""Delivery / ack-policy pins for ``kernel.events.EventBus._deliver``.

The two-kind failure taxonomy (module docstring, ``HANDLER FAILURES COME IN TWO
KINDS``) is behaviour, not documentation, and these tests pin it:

* an :class:`~kernel.events.Unprocessable` refusal is dead-lettered to
  ``EVENTS_DLQ`` — body intact, ``Nbt-Dlq-*`` headers matching the Go bus — and
  ``term()``'d on the FIRST delivery;
* an UNMARKED exception stays retryable (the safe default): NAK'd with backoff
  through the whole MAX_DELIVER budget, dead-lettered + terminated only on the
  final delivery;
* an undecodable body terminates immediately, also parked first;
* a clean return acks, and nothing else does.

No broker: a fake JetStream context records publishes, a fake message records
its terminal ack state. ``_deliver`` is exercised directly, exactly as the
subscribe callback calls it.
"""

from __future__ import annotations

import asyncio
import json

from kernel.events import (
    DLQ_SUBJECT_PREFIX,
    MAX_DELIVER,
    EventBus,
    Unprocessable,
    envelope,
    retryable,
)


def _run(coro):
    return asyncio.run(coro)


class FakeMetadata:
    def __init__(self, num_delivered: int) -> None:
        self.num_delivered = num_delivered


class FakeMsg:
    """One JetStream message that records which terminal state it reached."""

    def __init__(self, subject: str, data: bytes, delivery: int = 1) -> None:
        self.subject = subject
        self.data = data
        self.metadata = FakeMetadata(delivery)
        self.acked = False
        self.naked = False
        self.nak_delay: float | None = None
        self.termed = False

    async def ack(self) -> None:
        self.acked = True

    async def nak(self, delay: float | None = None) -> None:
        self.naked = True
        self.nak_delay = delay

    async def term(self) -> None:
        self.termed = True


class FakeJS:
    """Records every publish — the DLQ parking spot."""

    def __init__(self) -> None:
        self.published: list[tuple[str, bytes, dict]] = []

    async def publish(self, subject: str, data: bytes, headers: dict | None = None):
        self.published.append((subject, data, headers or {}))


def _bus() -> tuple[EventBus, FakeJS]:
    bus = EventBus(source="test")
    js = FakeJS()
    bus._js = js
    bus._nc = object()  # "connected"
    return bus, js


def _msg(delivery: int = 1, subject: str = "tenant.t1.tenant.offboarded") -> FakeMsg:
    body = envelope(tenant_id="t1", type="tenant.offboarded", source="test")
    return FakeMsg(subject, json.dumps(body).encode(), delivery)


def test_unprocessable_dead_letters_and_terms_on_first_delivery():
    bus, js = _bus()
    msg = _msg(delivery=1)

    async def handler(env: dict) -> None:
        raise Unprocessable("tenant_id 'nope' is not a uuid")

    _run(bus._deliver("p", "d1", handler, msg))

    # Parked exactly once, under dlq.<original subject>, body byte-identical,
    # with the Go bus's header names and the refusal reason — on delivery 1.
    assert len(js.published) == 1
    subj, data, headers = js.published[0]
    assert subj == DLQ_SUBJECT_PREFIX + msg.subject
    assert data == msg.data
    assert headers["Nbt-Dlq-Origin-Subject"] == msg.subject
    assert headers["Nbt-Dlq-Consumer"] == "d1"
    assert headers["Nbt-Dlq-Deliveries"] == "1"
    assert headers["Nbt-Dlq-Reason"] == "unprocessable: tenant_id 'nope' is not a uuid"
    assert "Nbt-Dlq-At" in headers
    # Terminated, never acked, never retried.
    assert msg.termed and not msg.acked and not msg.naked


def test_unmarked_error_retries_through_the_whole_budget():
    bus, js = _bus()

    async def handler(env: dict) -> None:
        raise RuntimeError("database is down")

    # Deliveries 1 .. MAX_DELIVER-1: NAK with a growing delay, nothing parked.
    delays = []
    for delivery in range(1, MAX_DELIVER):
        msg = _msg(delivery=delivery)
        _run(bus._deliver("p", "d1", handler, msg))
        assert msg.naked and not msg.termed and not msg.acked, delivery
        assert js.published == []
        delays.append(msg.nak_delay)
    assert delays == sorted(delays)  # exponential backoff never shrinks

    # The final delivery of the budget: dead-letter + term.
    msg = _msg(delivery=MAX_DELIVER)
    _run(bus._deliver("p", "d1", handler, msg))
    assert msg.termed and not msg.naked and not msg.acked
    assert len(js.published) == 1
    _, _, headers = js.published[0]
    assert headers["Nbt-Dlq-Deliveries"] == str(MAX_DELIVER)
    assert "database is down" in headers["Nbt-Dlq-Reason"]


def test_undecodable_body_terms_immediately_with_the_bytes_parked():
    bus, js = _bus()
    msg = FakeMsg("tenant.t1.tenant.offboarded", b"\x00 not json", delivery=1)

    async def handler(env: dict) -> None:  # pragma: no cover — must never run
        raise AssertionError("handler must not see an undecodable body")

    _run(bus._deliver("p", "d1", handler, msg))
    assert msg.termed and not msg.acked and not msg.naked
    assert len(js.published) == 1
    subj, data, headers = js.published[0]
    assert data == msg.data  # the poison bytes are recoverable
    assert headers["Nbt-Dlq-Reason"].startswith("decode:")


def test_clean_return_acks_and_parks_nothing():
    bus, js = _bus()
    msg = _msg()

    async def handler(env: dict) -> None:
        return None

    _run(bus._deliver("p", "d1", handler, msg))
    assert msg.acked and not msg.termed and not msg.naked
    assert js.published == []


def test_retryable_is_the_default_and_unprocessable_is_the_marker():
    assert retryable(RuntimeError("db down"))
    assert retryable(ValueError("anything unmarked"))
    assert not retryable(Unprocessable("refused"))
