"""What an authorised delivery turns into — routing, publish, and the log row.

Past the auth gate (test_receiver_auth_dispatch.py) the receiver decides three
things no sender can see: which subject the event goes out on, which shape its
body has, and what the delivery log says when it does not go out at all. Each of
those has a failure mode that is silent by construction — the sender is told 202,
or 422 with no detail, and the operator's only witness is the ``IngestEventLog``
row.

The bus is a RECORDER, not a no-op. Ingest runs with ``VE_NATS_URL`` unset in
tests, so a real ``EventBus.publish`` succeeds by doing nothing — which cannot
tell "published the right subject" from "published nothing". These tests hold the
subject and the payload, so they need to see them.

What is pinned here, and what breaks without it:

  * a rule-routed webhook with NO matching rule publishes NOTHING. Falling back to
    the webhook's default type emits an event under a type no consumer subscribes
    to, and both the sender and the operator see a success;
  * the winning rule's ``field_map`` REPLACES the webhook transform rather than
    chaining onto it — a rule extracts from the vendor's body, not from an
    extraction, and chaining would feed it a body whose fields have been renamed;
  * rules are matched against the RAW payload for the same reason: the transform
    may have dropped the very field a condition tests;
  * a publish that FAILS is still a row. Without it a NATS outage is a set of
    deliveries that were accepted, transformed and then forgotten.
"""

from __future__ import annotations

import uuid

import pytest

from kernel.auth import Scope
from kernel.errors import NotFoundError, ValidationError

from app.ingest.models import IngestCategory, IngestEventLog, IngestEventRule, Webhook
from app.ingest.service import EventLogService, ReceiverService

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()


class _Bus:
    """Records what was published instead of sending it."""

    def __init__(self, fail: Exception | None = None):
        self.published: list[tuple[str, dict]] = []
        self.fail = fail

    async def publish(self, subj, payload):
        if self.fail:
            raise self.fail
        self.published.append((subj, payload))


@pytest.fixture
def bus():
    return _Bus()


async def _webhook(session, *, domain="ingest", transform=None, schema=None,
                   event_type=None, tenant=TENANT, lookup=None):
    cat = IngestCategory(tenant_id=tenant, name=f"cat-{uuid.uuid4().hex[:6]}", target_domain=domain)
    session.add(cat)
    await session.commit()
    await session.refresh(cat)
    wh = Webhook(
        tenant_id=tenant,
        category_id=cat.id,
        name="hook",
        slug=f"s-{uuid.uuid4().hex[:8]}",
        request_method="post",
        auth_type="none",
        payload_schema=schema or {},
        transform=transform or {},
        event_type=event_type,
        device_lookup_expr=lookup,
        is_active=True,
    )
    session.add(wh)
    await session.commit()
    await session.refresh(wh)
    return wh


async def _rule(session, wh, *, conditions, field_map=None, event_type=None,
                domain=None, priority=10, enabled=True):
    row = IngestEventRule(
        tenant_id=wh.tenant_id,
        webhook_id=wh.id,
        name=f"rule-{priority}",
        priority=priority,
        match_conditions=conditions,
        field_map=field_map or {},
        event_type=event_type,
        target_domain=domain,
        enabled=enabled,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def _run(session, bus, wh, payload):
    return await ReceiverService(session, bus).run_pipeline(
        wh, payload=payload, source_ip="10.0.0.1", auth_ok=True, is_replay=False
    )


# ── the subject an event goes out on ─────────────────────────────────────────


async def test_a_delivery_publishes_on_its_categorys_domain_under_its_tenant(session, bus):
    wh = await _webhook(session, domain="access", event_type="door.forced")
    row = await _run(session, bus, wh, {"door": 3})

    assert row.published is True
    subj, payload = bus.published[0]
    # tenant.<tid>.<domain>.event.received — the tenant segment is what keeps one
    # customer's consumers from seeing another's events.
    assert subj == f"tenant.{TENANT}.access.event.received"
    assert row.target_subject == subj
    assert payload["event_type"] == "door.forced"
    assert payload["webhook_slug"] == wh.slug


async def test_a_matching_rule_moves_the_event_to_its_own_domain_and_type(session, bus):
    # The rule, not the category, decides where a matched payload lands — that is
    # the whole point of rule routing, and a consumer subscribed to the rule's
    # domain sees nothing if the category's wins instead.
    wh = await _webhook(session, domain="ingest", event_type="generic")
    await _rule(
        session, wh,
        conditions=[{"path": "kind", "op": "equals", "value": "fire"}],
        event_type="alarm.fire",
        domain="access",
    )
    row = await _run(session, bus, wh, {"kind": "fire"})

    subj, payload = bus.published[0]
    assert subj == f"tenant.{TENANT}.access.event.received"
    assert payload["event_type"] == "alarm.fire"
    assert row.matched_rule_id is not None


async def test_rules_are_walked_in_priority_order_and_the_first_match_wins(session, bus):
    # Both rules match. Priority is the operator's only way to say which reading of
    # an ambiguous payload is the right one.
    wh = await _webhook(session, domain="ingest")
    await _rule(session, wh, conditions=[], event_type="catch.all", priority=99)
    await _rule(
        session, wh,
        conditions=[{"path": "kind", "op": "exists"}],
        event_type="specific", priority=1,
    )
    await _run(session, bus, wh, {"kind": "fire"})
    assert bus.published[0][1]["event_type"] == "specific"


async def test_a_disabled_rule_does_not_route_anything(session, bus):
    # Disabling a rule is how an operator takes a route out of service without
    # deleting it; a disabled rule that still matched would make the switch a lie.
    wh = await _webhook(session, domain="ingest", event_type="fallback")
    await _rule(
        session, wh, conditions=[], event_type="disabled.route", enabled=False
    )
    row = await _run(session, bus, wh, {"kind": "fire"})
    # No ENABLED rules at all → the webhook's own default, not a rejection.
    assert row.published is True
    assert bus.published[0][1]["event_type"] == "fallback"


async def test_a_rule_routed_webhook_publishes_nothing_when_no_rule_matches(session, bus):
    # The silent one. Publishing under the default type here emits an event no
    # consumer is configured for: the sender is told 202 and nothing ever acts on
    # it. The delivery is refused instead, and the reason is on the row.
    wh = await _webhook(session, domain="ingest", event_type="fallback")
    await _rule(session, wh, conditions=[{"path": "kind", "op": "equals", "value": "fire"}])
    row = await _run(session, bus, wh, {"kind": "smoke"})

    assert bus.published == []
    assert row.published is False
    assert row.status == "no_rule_match"
    assert "no rule matched" in (row.error or "")


# ── which body is matched, and which body goes out ───────────────────────────


async def test_a_rules_field_map_replaces_the_webhook_transform_rather_than_chaining(
    session, bus
):
    # Chaining would hand the rule a body whose fields the webhook transform had
    # already renamed, so every rule field_map written against the vendor's
    # documentation would extract null — quietly, since a null is a legal value.
    wh = await _webhook(session, transform={"device": "sensor.id"})
    await _rule(
        session, wh,
        conditions=[{"path": "kind", "op": "equals", "value": "fire"}],
        field_map={"zone": "sensor.zone"},
    )
    row = await _run(session, bus, wh, {"kind": "fire", "sensor": {"id": "s1", "zone": "z9"}})

    assert row.transformed_payload == {"zone": "z9"}
    assert bus.published[0][1]["data"] == {"zone": "z9"}


async def test_a_rule_matches_the_raw_payload_and_not_the_transformed_one(session, bus):
    # The webhook transform keeps only `device`, and the condition tests `kind` —
    # a field the transform drops. Matching the transformed body would make this
    # rule unmatchable, and the operator wrote the path against the body they were
    # shown by the vendor.
    wh = await _webhook(session, transform={"device": "sensor.id"})
    await _rule(
        session, wh,
        conditions=[{"path": "kind", "op": "equals", "value": "fire"}],
        event_type="alarm.fire",
    )
    row = await _run(session, bus, wh, {"kind": "fire", "sensor": {"id": "s1"}})

    assert row.published is True
    assert bus.published[0][1]["event_type"] == "alarm.fire"


async def test_a_payload_that_fails_the_schema_is_refused_before_anything_is_published(
    session, bus
):
    wh = await _webhook(
        session,
        schema={"type": "object", "required": ["temp"], "properties": {"temp": {"type": "number"}}},
    )
    row = await _run(session, bus, wh, {"humidity": 40})

    assert bus.published == []
    assert row.status == "rejected_schema"
    assert row.schema_outcome == "failed"
    # The routing and transform stages must not have run on a body the operator's
    # own schema rejected.
    assert row.transform_outcome == "skipped"
    assert (row.error or "").startswith("schema:")


async def test_a_transform_that_cannot_be_evaluated_is_a_refusal_not_an_empty_event(
    session, bus
):
    # A broken JMESPath expression publishing {} would deliver a well-formed event
    # with no content, which downstream reads as "nothing happened".
    wh = await _webhook(session, transform={"device": "this is not ] jmespath"})
    row = await _run(session, bus, wh, {"sensor": {"id": "s1"}})

    assert bus.published == []
    assert row.status == "transform_failed"
    assert row.transform_outcome == "failed"
    assert (row.error or "").startswith("transform:")


async def test_the_device_lookup_value_ships_with_the_event_for_a_consumer_to_resolve(
    session, bus
):
    # v3 has no device registry, so the receiver must NOT reject an unresolved
    # device — it carries the raw value through instead. Reinstating v2's
    # rejection would drop every delivery from a webhook that configures a lookup.
    wh = await _webhook(session, lookup="sensor.serial")
    row = await _run(session, bus, wh, {"sensor": {"serial": "SN-42"}})

    assert row.published is True
    assert row.device_lookup_value == "SN-42"
    assert bus.published[0][1]["device_lookup_value"] == "SN-42"


# ── when the bus is the thing that failed ────────────────────────────────────


async def test_a_publish_that_fails_is_recorded_rather_than_lost(session):
    # A NATS outage otherwise leaves deliveries that were authorised, validated and
    # transformed, and then simply are not anywhere. The row is what the operator
    # replays from.
    broken = _Bus(fail=RuntimeError("nats: no servers available"))
    wh = await _webhook(session)
    row = await _run(session, broken, wh, {"temp": 21})

    assert row.published is False
    assert row.status == "publish_failed"
    assert "nats: no servers available" in (row.error or "")
    # The subject it would have gone out on is still on the row — a replay has to
    # know where the event was meant to land.
    assert row.target_subject == f"tenant.{TENANT}.ingest.event.received"


async def test_a_publish_failure_answers_the_sender_with_a_refusal_not_a_202(
    app, session, monkeypatch
):
    # End to end, through the route: the sender must learn the event did not go
    # out. A 202 here means the integration on the other side stops retrying.
    wh = await _webhook(session)

    async def boom(*a, **kw):
        raise RuntimeError("nats down")

    import app.main as main_mod

    # The router is bound to this exact bus instance at create_app() time, so the
    # patch has to land on the instance rather than on a fresh one.
    monkeypatch.setattr(main_mod.bus, "publish", boom)

    from conftest import _client

    async with _client(app) as c:
        r = await c.post(f"/ingest/hooks/{wh.slug}", json={"temp": 21})
    assert r.status_code == 422


# ── replay ───────────────────────────────────────────────────────────────────


def _scope(tenant=TENANT) -> Scope:
    return Scope(tenant_id=tenant, is_superadmin=False)


async def test_a_replay_writes_a_new_row_and_leaves_the_original_alone(session, bus):
    wh = await _webhook(session)
    original = await _run(session, bus, wh, {"temp": 21})

    replayed = await EventLogService(session, _scope(), bus).replay(original.id)

    assert replayed.id != original.id
    assert replayed.is_replay is True
    assert original.is_replay is False
    assert replayed.published is True
    # Two events on the wire, with different ingest ids: a replay is a new
    # delivery, not a re-announcement of the old one.
    assert len(bus.published) == 2
    assert bus.published[0][1]["ingest_event_id"] != bus.published[1][1]["ingest_event_id"]


async def test_a_truncated_payload_is_refused_rather_than_replayed_as_something_else(
    session, bus
):
    # The stored body was capped, so replaying it would publish a DIFFERENT event
    # from the one that arrived — under the same provenance.
    wh = await _webhook(session)
    row = await _run(session, bus, wh, {"temp": 21})
    row.raw_truncated = True
    await session.commit()

    with pytest.raises(ValidationError):
        await EventLogService(session, _scope(), bus).replay(row.id)


async def test_another_tenants_event_log_cannot_be_replayed(session, bus):
    # Replay publishes under the OWNING tenant's subject, so a cross-tenant replay
    # would let one customer inject events into another's stream.
    wh = await _webhook(session, tenant=OTHER_TENANT)
    row = await _run(session, bus, wh, {"temp": 21})
    before = len(bus.published)

    with pytest.raises(NotFoundError):
        await EventLogService(session, _scope(TENANT), bus).replay(row.id)
    assert len(bus.published) == before


async def test_a_log_row_with_no_webhook_is_refused_rather_than_replayed_blind(session, bus):
    # A log row can outlive the webhook it came from. Replay needs the webhook for
    # its schema, transform and rules, so there is nothing to re-run against — and
    # the refusal has to be the reason, not an AttributeError.
    wh = await _webhook(session)
    row = await _run(session, bus, wh, {"temp": 21})
    row.webhook_id = None
    await session.commit()

    with pytest.raises(ValidationError):
        await EventLogService(session, _scope(), bus).replay(row.id)
