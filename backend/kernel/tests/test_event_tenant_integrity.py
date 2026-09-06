"""The subject decides which tenant an event is about, not the body.

kernel.lifecycle's offboard handler reads tenant_id from the envelope body and
deletes every row matching it. Nothing checked the body agreed with the subject the
message arrived on, so a publisher could name any tenant it liked.

Every kernel publisher derives the envelope FROM the subject, so agreement is the
normal case and a mismatch means the body was written by something other than the
thing that chose the subject.
"""

from __future__ import annotations

import asyncio
import json

from kernel.events import _tenant_mismatch

TENANT_A = "11111111-1111-1111-1111-111111111111"
TENANT_B = "22222222-2222-2222-2222-222222222222"


def test_agreement_is_not_a_mismatch():
    subject = f"tenant.{TENANT_A}.tenant.offboarded"
    assert _tenant_mismatch(subject, {"tenant_id": TENANT_A}) is None


def test_a_body_naming_another_tenant_is_a_mismatch():
    """The forged offboard: arrive on your own tenant's subject, name the victim."""
    subject = f"tenant.{TENANT_A}.tenant.offboarded"
    reason = _tenant_mismatch(subject, {"tenant_id": TENANT_B})
    assert reason and TENANT_B in reason


def test_a_platform_subject_and_a_tenant_body_disagree():
    assert _tenant_mismatch("tenant.platform.tenant.offboarded", {"tenant_id": TENANT_A})


def test_a_tenant_subject_and_an_absent_body_tenant_disagree():
    assert _tenant_mismatch(f"tenant.{TENANT_A}.access.event", {})


def test_platform_is_spelled_both_ways_and_still_agrees():
    """The subject says 'platform', the envelope says None. Same thing."""
    assert _tenant_mismatch("tenant.platform.tenant.offboarded", {"tenant_id": None}) is None
    assert _tenant_mismatch("tenant.platform.tenant.offboarded", {"tenant_id": "platform"}) is None


def test_a_non_dict_body_is_left_to_the_handler():
    """Shape is not this check's job — the decode path already refuses garbage."""
    assert _tenant_mismatch("tenant.x.y.z", ["not", "a", "dict"]) is None


def test_a_publisher_cannot_disagree_with_its_own_subject():
    """publish() builds the envelope from the subject, so the two are one value."""
    from kernel.events import _parse_subject, envelope

    subject = f"tenant.{TENANT_A}.access.door_opened"
    tenant_id, type_ = _parse_subject(subject)
    body = envelope(tenant_id=tenant_id, type=type_, source="test", payload={})
    assert _tenant_mismatch(subject, body) is None


class _Msg:
    def __init__(self, subject, body):
        self.subject = subject
        self.data = json.dumps(body).encode()
        self.metadata = type("M", (), {"num_delivered": 1})()
        self.terminated = False
        self.acked = False

    async def term(self):
        self.terminated = True

    async def ack(self):
        self.acked = True

    async def nak(self, delay=None):
        pass

    async def in_progress(self):
        pass


def test_a_mismatched_message_never_reaches_the_handler():
    """The check has to run before the handler, not inside it — lifecycle is not
    the only consumer that reads tenant_id from the body."""
    from kernel.events import EventBus

    bus = EventBus(source="test")
    seen = []

    async def handler(env):
        seen.append(env)

    async def _no_dlq(*a, **k):
        return True

    bus._dead_letter = _no_dlq
    msg = _Msg(f"tenant.{TENANT_A}.tenant.offboarded", {"tenant_id": TENANT_B})
    asyncio.run(bus._deliver("tenant.*.tenant.offboarded", "test-durable", handler, msg))

    assert seen == [], "the handler ran on a forged tenant"
    assert msg.terminated, "a mismatch must be parked, not retried"
    assert not msg.acked


def test_a_matching_message_does_reach_the_handler():
    """Otherwise the check is just an outage."""
    from kernel.events import EventBus

    bus = EventBus(source="test")
    seen = []

    async def handler(env):
        seen.append(env)

    msg = _Msg(f"tenant.{TENANT_A}.tenant.offboarded", {"tenant_id": TENANT_A})
    asyncio.run(bus._deliver("tenant.*.tenant.offboarded", "test-durable", handler, msg))

    assert len(seen) == 1
    assert msg.acked
