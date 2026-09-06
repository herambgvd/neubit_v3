"""The read surfaces: events, sync-jobs, and the two controller proxies.

`/events` is the one that matters most and was the one with no test. It is the
only route that returns `cardholder_ref` — who went through which door and when —
and it takes eight filters, none of which had ever been exercised. A filter that
silently does nothing is not a visible failure: the caller asks for one door and
gets the whole estate, and the response still looks like a valid answer.

Isolation on this route is NOT a tenant filter on the event rows. `list_events`
selects on `instance_id` alone and relies on `_row(instance_id)` refusing an
instance the caller does not own. That is sound, and it is asserted here directly
rather than assumed, because it means every one of these filters runs against
rows already narrowed to one instance.

The two proxies (`/hardware/{set}`, `/scheduled/{set}`) are asserted only on the
half that needs no controller: the set-name allowlist. An invented set name must
be refused BEFORE anything leaves the box. The reachable-controller half belongs
in an integration test with a controller in it — there is none here, and a test
that depends on a failed DNS lookup is a test of the sandbox.
"""

from __future__ import annotations

import datetime as dt
import uuid

import pytest

from conftest import PREFIX, _client, auth
from app.access.models import AccessEvent, Instance

pytestmark = pytest.mark.asyncio

TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()
READ = ["access.read"]

T0 = dt.datetime(2026, 3, 1, 9, 0, tzinfo=dt.timezone.utc)


async def _instance(session, tenant_id) -> str:
    row = Instance(
        tenant_id=tenant_id, brand="dds", name=f"ctrl-{uuid.uuid4().hex[:8]}",
        base_url="https://controller.example", auth_type="basic", username="svc",
        verify_tls=True, is_active=True, status="unknown",
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return str(row.id)


async def _events(session, tenant_id, instance_id):
    """Three events that differ in every filterable dimension."""
    rows = [
        AccessEvent(
            tenant_id=tenant_id, instance_id=instance_id, category="access",
            event_type="AccessGranted", result="granted", door_ref="D-LOBBY",
            cardholder_ref="CH-1", occurred_at=T0, raw={},
        ),
        AccessEvent(
            tenant_id=tenant_id, instance_id=instance_id, category="access",
            event_type="AccessDenied", result="denied", door_ref="D-SERVER",
            cardholder_ref="CH-2", occurred_at=T0 + dt.timedelta(hours=1), raw={},
        ),
        AccessEvent(
            tenant_id=tenant_id, instance_id=instance_id, category="alarm",
            event_type="ZoneArmed", result="unknown", door_ref=None,
            cardholder_ref=None, occurred_at=T0 + dt.timedelta(hours=2), raw={},
        ),
    ]
    session.add_all(rows)
    await session.commit()
    return rows


# ── events ───────────────────────────────────────────────────────────────────

async def test_events_starts_empty_and_then_lists(app, session):
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        first = await c.get(
            f"{PREFIX}/access/instances/{iid}/events",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
        assert first.status_code == 200, first.text
        assert first.json()["items"] == []

        await _events(session, TENANT_A, iid)
        after = await c.get(
            f"{PREFIX}/access/instances/{iid}/events",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
    assert after.status_code == 200, after.text
    assert len(after.json()["items"]) == 3


@pytest.mark.parametrize(
    "query,expected_types",
    [
        ("category=access", {"AccessGranted", "AccessDenied"}),
        ("category=alarm", {"ZoneArmed"}),
        ("result=denied", {"AccessDenied"}),
        ("result=granted", {"AccessGranted"}),
        ("door_ref=D-SERVER", {"AccessDenied"}),
        ("cardholder_ref=CH-1", {"AccessGranted"}),
        ("event_type=ZoneArmed", {"ZoneArmed"}),
        # Both bounds, naming the middle event's hour only.
        ("from=2026-03-01T09:30:00Z&to=2026-03-01T10:30:00Z", {"AccessDenied"}),
        # A filter that matches nothing must return nothing, not everything.
        ("cardholder_ref=CH-NOBODY", set()),
    ],
)
async def test_every_event_filter_narrows(app, session, query, expected_types):
    """A filter that is accepted and ignored returns a plausible wrong answer."""
    iid = await _instance(session, TENANT_A)
    await _events(session, TENANT_A, iid)
    async with _client(app) as c:
        r = await c.get(
            f"{PREFIX}/access/instances/{iid}/events?{query}",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
    assert r.status_code == 200, r.text
    assert {e["event_type"] for e in r.json()["items"]} == expected_types


async def test_events_are_refused_for_another_tenants_instance(app, session):
    """The whole isolation of this route. The rows carry a tenant_id and the query
    does not filter on it — the instance gate is what stands between them."""
    iid = await _instance(session, TENANT_A)
    await _events(session, TENANT_A, iid)
    async with _client(app) as c:
        r = await c.get(
            f"{PREFIX}/access/instances/{iid}/events",
            headers=auth(tenant_id=TENANT_B, permissions=READ),
        )
    assert r.status_code == 404, r.text
    assert "CH-1" not in r.text


async def test_the_event_page_size_is_bounded(app, session):
    """A caller must not be able to ask for the whole table in one response."""
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        too_big = await c.get(
            f"{PREFIX}/access/instances/{iid}/events?limit=501",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
        at_the_edge = await c.get(
            f"{PREFIX}/access/instances/{iid}/events?limit=500",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
    assert too_big.status_code == 422, too_big.text
    assert at_the_edge.status_code == 200, at_the_edge.text


# ── sync jobs ────────────────────────────────────────────────────────────────

async def test_sync_jobs_lists_and_is_instance_gated(app, session):
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        mine = await c.get(
            f"{PREFIX}/access/instances/{iid}/sync-jobs",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
        theirs = await c.get(
            f"{PREFIX}/access/instances/{iid}/sync-jobs",
            headers=auth(tenant_id=TENANT_B, permissions=READ),
        )
        too_big = await c.get(
            f"{PREFIX}/access/instances/{iid}/sync-jobs?limit=201",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
    assert mine.status_code == 200, mine.text
    assert mine.json()["items"] == []
    assert theirs.status_code == 404, theirs.text
    assert too_big.status_code == 422, too_big.text


# ── the two controller proxies ───────────────────────────────────────────────

@pytest.mark.parametrize(
    "segment,bad",
    [("hardware", "everything"), ("scheduled", "everything")],
)
async def test_an_invented_set_name_is_refused_before_the_controller(
    app, session, segment, bad
):
    """The allowlist is the point: `hardware_set` is interpolated into the
    upstream path, so a name that is not in the closed list must never get there.
    No network is available in this suite, so a request that DID leave the box
    would fail differently — a 404 here is proof it did not."""
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.get(
            f"{PREFIX}/access/instances/{iid}/{segment}/{bad}",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
    assert r.status_code == 404, r.text


@pytest.mark.parametrize(
    "segment,good",
    [
        ("hardware", "alarm-zones"),
        ("hardware", "alarm_zones"),
        ("scheduled", "scheduled-mags"),
        ("scheduled", "scheduled_mags"),
    ],
)
async def test_a_known_set_name_passes_the_allowlist(app, session, segment, good):
    """Dashed and underscored spellings are both accepted.

    Two things are asserted and the second is the one worth having. Not 404: the
    allowlist let it through. Not 500: there is no controller behind this suite,
    and an unreachable controller must be reported as an UPSTREAM error the caller
    can retry, never as an internal one. It comes back 502 today; the assertion is
    written as the invariant rather than the number, because what an unreachable
    host does is the sandbox's business and what this service does with it is not.
    """
    iid = await _instance(session, TENANT_A)
    async with _client(app) as c:
        r = await c.get(
            f"{PREFIX}/access/instances/{iid}/{segment}/{good}",
            headers=auth(tenant_id=TENANT_A, permissions=READ),
        )
    assert r.status_code != 404, f"{good} was rejected by the allowlist: {r.text[:200]}"
    assert r.status_code < 500 or r.status_code in (502, 503, 504), r.text[:200]
    if r.status_code >= 500:
        assert r.json()["error"]["code"] in ("UPSTREAM_ERROR", "UNAVAILABLE",
                                             "UPSTREAM_TIMEOUT"), r.text[:200]
