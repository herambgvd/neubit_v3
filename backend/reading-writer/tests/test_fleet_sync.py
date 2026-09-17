"""The IoT fleet channel: what it reads, what it writes, and what it refuses to.

This is the first code in this service that makes an OUTBOUND call to conflux,
so most of what matters here is failure behaviour — an unreachable or
mis-credentialled gateway server has to produce a sentence a console can show,
not a stack trace and not silence.
"""

from __future__ import annotations

import httpx
import pytest

from app.fleet_sync import FleetClient, FleetError, FleetStats, FleetSync, _pairs



# ── _pairs: turning an inventory into (gateway, connection) ──────────────────

def test_pairs_flattens_every_gateways_connections():
    gateways = [
        {"gatewayId": "g1", "connections": [{"id": "c1"}, {"id": "c2"}]},
        {"gatewayId": "g2", "connections": [{"id": "c3"}]},
    ]
    assert _pairs(gateways) == [("g1", "c1"), ("g1", "c2"), ("g2", "c3")]


def test_pairs_ignores_a_gateway_that_cannot_report_its_connections():
    # `connections: null` is an older build saying "I cannot tell you". Its
    # points must keep whatever gateway they already have.
    assert _pairs([{"gatewayId": "g1", "connections": None}]) == []


def test_pairs_ignores_a_gateway_with_no_id():
    # Nothing can be stamped with an empty gateway, and stamping NULL would
    # erase a mapping rather than skip it.
    assert _pairs([{"gatewayId": "", "connections": [{"id": "c1"}]}]) == []


def test_pairs_skips_a_connection_with_no_id_and_keeps_its_siblings():
    gateways = [{"gatewayId": "g1", "connections": [{"id": ""}, {"id": "c2"}, "junk"]}]
    assert _pairs(gateways) == [("g1", "c2")]


def test_pairs_of_nothing_is_empty():
    assert _pairs([]) == []


# ── FleetClient: every failure has to be a sentence ─────────────────────────

async def _gateways_via(handler, *, token="t", url="http://conflux:8000"):
    """Run FleetClient.gateways() against a mock transport."""
    client = FleetClient(url, token, 2.0)
    transport = httpx.MockTransport(handler)
    real = httpx.AsyncClient

    class _Client(real):
        def __init__(self, *a, **kw):
            kw["transport"] = transport
            super().__init__(*a, **kw)

    httpx.AsyncClient = _Client  # type: ignore[misc]
    try:
        return await client.gateways()
    finally:
        httpx.AsyncClient = real  # type: ignore[misc]


@pytest.mark.asyncio
async def test_a_bare_list_body_is_accepted():
    body = [{"gatewayId": "g1", "connections": []}]
    got = await _gateways_via(lambda r: httpx.Response(200, json=body))
    assert got == body


@pytest.mark.asyncio
async def test_a_wrapped_body_is_accepted():
    # conflux serves both shapes depending on the route; depending on which one
    # it is today is how this breaks six months from now.
    got = await _gateways_via(
        lambda r: httpx.Response(200, json={"gateways": [{"gatewayId": "g1"}]})
    )
    assert got == [{"gatewayId": "g1"}]


@pytest.mark.asyncio
async def test_the_credential_is_sent_as_a_bearer_token():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json=[])

    await _gateways_via(handler, token="secret-token")
    assert seen["auth"] == "Bearer secret-token"


@pytest.mark.asyncio
async def test_an_unreachable_server_names_the_host_it_tried():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(FleetError) as err:
        await _gateways_via(handler, url="http://conflux:8000")
    assert "http://conflux:8000" in str(err.value)
    assert "unreachable" in str(err.value)


@pytest.mark.asyncio
async def test_a_refused_credential_says_which_setting_to_check():
    # 401/403 is the one failure whose remedy is a specific env var, and an
    # operator reading "HTTP 403" has to go looking for it.
    with pytest.raises(FleetError) as err:
        await _gateways_via(lambda r: httpx.Response(403, json={}))
    assert "VE_IOT_FLEET_TOKEN" in str(err.value)


@pytest.mark.asyncio
async def test_the_token_is_never_in_an_error_message():
    with pytest.raises(FleetError) as err:
        await _gateways_via(lambda r: httpx.Response(500), token="super-secret")
    assert "super-secret" not in str(err.value)


@pytest.mark.asyncio
async def test_a_non_json_body_is_an_error_not_a_crash():
    with pytest.raises(FleetError):
        await _gateways_via(lambda r: httpx.Response(200, text="<html>nope</html>"))


@pytest.mark.asyncio
async def test_an_unexpected_json_shape_is_an_error():
    with pytest.raises(FleetError):
        await _gateways_via(lambda r: httpx.Response(200, json="a string"))


# ── FleetSync: the loop must survive a failing server ───────────────────────

class _Boom:
    async def gateways(self):
        raise FleetError("gateway server at http://x is unreachable: nope")


class _Ok:
    def __init__(self, gateways):
        self._g = gateways

    async def gateways(self):
        return self._g


@pytest.mark.asyncio
async def test_a_failed_pass_is_counted_and_described(monkeypatch):
    stats = FleetStats()
    sync = FleetSync(_Boom(), 300, stats)
    with pytest.raises(FleetError):
        await sync.once()
    # once() raises; _run is what swallows. Drive one iteration of the loop.
    sync._running = True

    async def _stop_after_first(_):
        sync._running = False

    monkeypatch.setattr("asyncio.sleep", _stop_after_first)
    await sync._run()
    assert stats.failures == 1
    assert "unreachable" in stats.last_error
    assert stats.syncs == 0


@pytest.mark.asyncio
async def test_a_successful_pass_clears_the_last_error(monkeypatch):
    stats = FleetStats()
    stats.last_error = "something old"
    stamped = {}

    async def _stamp(pairs):
        stamped["pairs"] = pairs
        return len(pairs)

    monkeypatch.setattr("app.fleet_sync.stamp_points", _stamp)
    sync = FleetSync(_Ok([{"gatewayId": "g1", "connections": [{"id": "c1"}]}]), 300, stats)
    changed = await sync.once()
    assert changed == 1
    assert stamped["pairs"] == [("g1", "c1")]
    assert stats.last_error == ""
    assert stats.syncs == 1
    assert stats.gateways == 1
    assert stats.connections == 1


@pytest.mark.asyncio
async def test_the_poll_interval_has_a_floor():
    # A one-second poll against a fleet server is a denial of service aimed at
    # your own gateway. The mapping being synced changes in days.
    sync = FleetSync(_Ok([]), 1, FleetStats())
    assert sync._every >= 30
