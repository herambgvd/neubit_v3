"""publish() has to say whether the event actually went.

It returned None on every path, so a dropped event looked exactly like a delivered
one — including when there was no JetStream connection at all.
"""

from __future__ import annotations

import asyncio
import json

from kernel.events import (
    EVENTS_MAX_AGE_SEC,
    EVENTS_MAX_BYTES,
    EventBus,
    _parse_subject,
    envelope,
)

SUBJECT = "tenant.11111111-1111-1111-1111-111111111111.access.door_opened"


class _JS:
    def __init__(self, fail=False):
        self.fail = fail
        self.published = []

    async def publish(self, subj, data, headers=None):
        if self.fail:
            raise RuntimeError("broker down")
        self.published.append((subj, json.loads(data.decode()), headers or {}))


def test_no_connection_reports_failure():
    bus = EventBus(source="test")
    bus._js = None
    assert asyncio.run(bus.publish(SUBJECT, {"a": 1})) is False


def test_a_broker_failure_reports_failure_and_does_not_raise():
    """A failed event must not roll back the caller's committed transaction — but
    it must not be silent either."""
    bus = EventBus(source="test")
    bus._js = _JS(fail=True)
    assert asyncio.run(bus.publish(SUBJECT, {"a": 1})) is False


def test_a_delivered_event_reports_success():
    bus = EventBus(source="test")
    bus._js = js = _JS()
    assert asyncio.run(bus.publish(SUBJECT, {"a": 1})) is True
    assert len(js.published) == 1


def test_every_event_carries_a_dedup_id():
    """Without Nats-Msg-Id, a retry after a timeout that actually succeeded
    delivers the event twice."""
    bus = EventBus(source="test")
    bus._js = js = _JS()
    asyncio.run(bus.publish(SUBJECT, {"a": 1}))
    _subj, body, headers = js.published[0]
    assert headers.get("Nats-Msg-Id") == body["event_id"]


def test_the_envelope_is_derived_from_the_subject():
    """So a publisher cannot disagree with its own subject — which is what the
    consumer-side tenant check relies on."""
    bus = EventBus(source="test")
    bus._js = js = _JS()
    asyncio.run(bus.publish(SUBJECT, {"a": 1}))
    _subj, body, _h = js.published[0]
    tenant_id, type_ = _parse_subject(SUBJECT)
    assert body["tenant_id"] == tenant_id
    assert body["type"] == type_


def test_the_events_stream_is_bounded():
    """It was created unbounded while the DLQ beside it was carefully limited, so
    it grew forever and kept a permanent replay archive of every offboard."""
    assert EVENTS_MAX_AGE_SEC > 0
    assert EVENTS_MAX_BYTES > 0


def test_the_envelope_shape_is_stable():
    """Consumers in five services read these keys."""
    body = envelope(tenant_id="t1", type="a.b", source="test", payload={"x": 1})
    assert set(body) == {"event_id", "tenant_id", "type", "occurred_at", "source", "payload"}
