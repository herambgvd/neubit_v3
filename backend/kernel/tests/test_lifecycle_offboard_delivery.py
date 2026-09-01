"""The offboard handler's failure contract, end to end through the bus.

A tenant offboard is a GDPR/DPDP right-to-erase. The handler used to catch every
exception and return — under manual ack that meant an erasure that failed on a
database OUTAGE was acked and never retried: silently not honoured. These tests
pin the honest behaviour by composing the real pieces exactly as production
does — ``subscribe_tenant_offboard`` builds the handler, ``EventBus._deliver``
makes the ack decision:

* database down (transient)  → the message is NAK'd for redelivery, never acked;
* tenant id that cannot parse (permanent) → refused via ``Unprocessable``:
  dead-lettered to EVENTS_DLQ and terminated on the FIRST delivery;
* no tenant / platform scope → a clean skip, acked.
"""

from __future__ import annotations

import asyncio
import json

from kernel.events import DLQ_SUBJECT_PREFIX, EventBus, envelope
from kernel.lifecycle import subscribe_tenant_offboard

from test_events_delivery import FakeJS, FakeMsg


def _run(coro):
    return asyncio.run(coro)


class CapturingBus:
    """Stands in for EventBus at SUBSCRIBE time only — it captures the handler
    lifecycle wires, which the tests then drive through the REAL _deliver."""

    def __init__(self) -> None:
        self.handler = None

    async def subscribe(self, pattern, handler, *, durable=None) -> None:
        self.handler = handler


class DownDatabase:
    """A database whose every session attempt fails — a simulated outage."""

    database_url = "postgresql+asyncpg://x:x@nowhere:5432/gone"

    def get_sessionmaker(self):
        def _sessionmaker():
            raise ConnectionError("database is down")

        return _sessionmaker


def _offboard_msg(tenant_id, delivery: int = 1) -> FakeMsg:
    body = envelope(tenant_id=tenant_id, type="tenant.offboarded", source="core")
    return FakeMsg(f"tenant.{tenant_id}.tenant.offboarded", json.dumps(body).encode(), delivery)


def _wired_handler():
    cap = CapturingBus()
    _run(subscribe_tenant_offboard(cap, DownDatabase(), durable="svc-offboard"))
    assert cap.handler is not None
    return cap.handler


def test_offboard_naks_on_a_database_outage():
    handler = _wired_handler()
    bus = EventBus(source="svc")
    bus._js = js = FakeJS()
    bus._nc = object()

    msg = _offboard_msg("6a3f6a1e-6f0f-4a3e-9f5d-0d3f2a9b7c11", delivery=1)
    _run(bus._deliver("tenant.*.tenant.offboarded", "svc-offboard", handler, msg))

    # The erasure is NOT done, so the message must come back: NAK, no ack, no
    # term, nothing parked. JetStream will redeliver it when the DB is back.
    assert msg.naked and not msg.acked and not msg.termed
    assert js.published == []


def test_offboard_refuses_an_unparseable_tenant_on_first_delivery():
    handler = _wired_handler()
    bus = EventBus(source="svc")
    bus._js = js = FakeJS()
    bus._nc = object()

    msg = _offboard_msg("not-a-uuid", delivery=1)
    _run(bus._deliver("tenant.*.tenant.offboarded", "svc-offboard", handler, msg))

    # Redelivery cannot make "not-a-uuid" parse: parked + terminated at once.
    assert msg.termed and not msg.acked and not msg.naked
    assert len(js.published) == 1
    subj, data, headers = js.published[0]
    assert subj == DLQ_SUBJECT_PREFIX + msg.subject
    assert data == msg.data
    assert headers["Nbt-Dlq-Deliveries"] == "1"
    assert "not a uuid" in headers["Nbt-Dlq-Reason"]


def test_offboard_skips_platform_scope_cleanly():
    handler = _wired_handler()
    bus = EventBus(source="svc")
    bus._js = js = FakeJS()
    bus._nc = object()

    body = envelope(tenant_id=None, type="tenant.offboarded", source="core")
    msg = FakeMsg("tenant.platform.tenant.offboarded", json.dumps(body).encode(), 1)
    _run(bus._deliver("tenant.*.tenant.offboarded", "svc-offboard", handler, msg))

    # Nothing to erase is a SUCCESS, not a failure: acked, nothing parked.
    assert msg.acked and not msg.naked and not msg.termed
    assert js.published == []
