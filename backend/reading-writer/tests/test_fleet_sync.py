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


# ── commands: approve / revoke / tokens ─────────────────────────────────────
#
# These are the first calls that CHANGE something on the gateway server, and
# every one of them can be refused for a reason only that server knows. The
# tests below are mostly about what an operator is told when that happens.

from app.fleet_sync import _detail  # noqa: E402


def test_detail_returns_the_gateway_servers_own_sentence():
    # conflux answers `{"error": "..."}`. Swallowing it and reporting the status
    # code sends an operator looking for a bug; the sentence IS the answer.
    r = httpx.Response(400, json={"error": "this instance is not an enrolled gateway"})
    assert _detail(r) == "this instance is not an enrolled gateway"


def test_detail_is_empty_for_a_body_that_is_not_its_error_shape():
    # An HTML error page from something in between must not be quoted at an
    # operator; the caller falls back to naming the status.
    assert _detail(httpx.Response(502, text="<html>bad gateway</html>")) == ""
    assert _detail(httpx.Response(400, json=["nope"])) == ""
    assert _detail(httpx.Response(400, json={})) == ""


def test_detail_is_bounded_because_it_lands_in_a_toast():
    assert len(_detail(httpx.Response(400, json={"error": "x" * 5000}))) == 300


@pytest.mark.asyncio
async def test_approve_posts_to_the_gateways_approve_route():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["method"] = request.method
        return httpx.Response(204)

    await _command_via(handler, lambda c: c.approve_gateway("g1"))
    assert seen["method"] == "POST"
    assert seen["url"].endswith("/api/fleet/gateways/g1/approve")


@pytest.mark.asyncio
async def test_revoke_posts_to_the_gateways_revoke_route():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(204)

    await _command_via(handler, lambda c: c.revoke_gateway("g1"))
    assert seen["url"].endswith("/api/fleet/gateways/g1/revoke")


@pytest.mark.asyncio
async def test_a_refused_command_reports_the_gateways_reason_not_the_status():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "this instance is not an enrolled gateway"})

    with pytest.raises(FleetError) as err:
        await _command_via(handler, lambda c: c.revoke_gateway("g1"))
    assert "not an enrolled gateway" in str(err.value)
    assert "HTTP 400" not in str(err.value)


@pytest.mark.asyncio
async def test_a_403_on_a_command_names_the_role_setting():
    # The likely cause is not a broken token but one narrowed below what this
    # command needs — EDGE_TOKEN_ROLE. An operator has to be told which knob.
    with pytest.raises(FleetError) as err:
        await _command_via(lambda r: httpx.Response(403, json={}), lambda c: c.approve_gateway("g1"))
    assert "EDGE_TOKEN_ROLE" in str(err.value)


@pytest.mark.asyncio
async def test_a_minted_token_is_never_in_an_error_message():
    # The one call whose body is a credential. A failed mint can still echo what
    # was sent, so this branch must not include the body at all.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "cfxe_abcd_supersecret"})

    with pytest.raises(FleetError) as err:
        await _command_via(handler, lambda c: c.mint_token("x"))
    assert "supersecret" not in str(err.value)


@pytest.mark.asyncio
async def test_tokens_accepts_both_body_shapes():
    got = await _command_via(
        lambda r: httpx.Response(200, json={"tokens": [{"id": "t1"}]}), lambda c: c.tokens()
    )
    assert got == [{"id": "t1"}]
    got = await _command_via(lambda r: httpx.Response(200, json=[{"id": "t1"}]), lambda c: c.tokens())
    assert got == [{"id": "t1"}]


async def _command_via(handler, call, *, url="http://conflux:8000", token="t"):
    """Run one FleetClient command against a mock transport."""
    client = FleetClient(url, token, 2.0)
    transport = httpx.MockTransport(handler)
    real = httpx.AsyncClient

    class _Client(real):
        def __init__(self, *a, **kw):
            kw["transport"] = transport
            super().__init__(*a, **kw)

    httpx.AsyncClient = _Client  # type: ignore[misc]
    try:
        return await call(client)
    finally:
        httpx.AsyncClient = real  # type: ignore[misc]


# ── delete ──────────────────────────────────────────────────────────────────
#
# The only irreversible action on this surface. What matters is the order it
# happens in and what it treats as success.

@pytest.mark.asyncio
async def test_delete_goes_to_the_gateways_point_route():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["url"] = str(request.url)
        return httpx.Response(204)

    await _command_via(handler, lambda c: c.delete_point("p1"))
    assert seen["method"] == "DELETE"
    assert seen["url"].endswith("/api/points/p1")


@pytest.mark.asyncio
async def test_a_point_the_gateway_has_already_forgotten_is_a_SUCCESS():
    # The caller's intent is "this should not exist". A gateway that no longer
    # has it has satisfied that — and failing here would leave an operator
    # unable to clean up this store's copy of something already gone.
    got = await _command_via(lambda r: httpx.Response(404), lambda c: c.delete_point("p1"))
    assert got == "absent"


@pytest.mark.asyncio
async def test_a_drifted_id_is_resolved_by_IDENTITY_and_still_deleted():
    # THE bug this fallback exists for. A gateway re-materialises a point when
    # its topic publishes again and the new point carries a NEW uuid, while this
    # store still holds the old one. Deleting by id alone 404s and the gateway
    # quietly keeps the live point — "delete it everywhere" that deletes it in
    # one place.
    deleted: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if request.method == "DELETE":
            deleted.append(url)
            # Only the NEW id exists on the gateway.
            return httpx.Response(204 if "p-new" in url else 404)
        if url.endswith("/api/connections/c1/devices"):
            return httpx.Response(200, json=[{"id": "d1", "tag": "1F York Chiller1"}])
        if url.endswith("/api/devices/d1/points"):
            # Still one point left after the delete, so the device survives.
            return httpx.Response(200, json=[{"id": "p-new", "tag": "1FYC1_Sys Load"}])
        return httpx.Response(404)

    got = await _command_via(
        handler,
        lambda c: c.delete_point(
            "p-old", conn_id="c1", device_tag="1F York Chiller1", point_tag="1FYC1_Sys Load"
        ),
    )
    assert got == "by-identity"
    assert any("p-old" in u for u in deleted), "it should try the id it was given first"
    assert any("p-new" in u for u in deleted), "and then the one the gateway actually has"


@pytest.mark.asyncio
async def test_the_device_goes_when_its_LAST_point_does():
    # An empty device is not configuration anybody wants; it is the residue of
    # this operation, and leaving it is how `1F York Chiller1` survived a delete
    # as a bare row with nothing in it.
    deleted: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if request.method == "DELETE":
            deleted.append(url)
            return httpx.Response(204 if "p-new" in url or "/devices/" in url else 404)
        if url.endswith("/api/connections/c1/devices"):
            return httpx.Response(200, json=[{"id": "d1", "tag": "dev"}])
        if url.endswith("/api/devices/d1/points"):
            # First call lists the point; the re-read after the delete is empty.
            return httpx.Response(
                200, json=[] if any("p-new" in u for u in deleted) else [{"id": "p-new", "tag": "pt"}]
            )
        return httpx.Response(404)

    await _command_via(
        handler,
        lambda c: c.delete_point("p-old", conn_id="c1", device_tag="dev", point_tag="pt"),
    )
    assert any("/api/devices/d1" in u for u in deleted), "the emptied device should go too"


@pytest.mark.asyncio
async def test_a_device_that_gained_a_point_meanwhile_is_KEPT():
    # The re-read is not a formality: another point can be materialised between
    # the delete and the check, and taking the device then would delete a live
    # point with it.
    deleted: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if request.method == "DELETE":
            deleted.append(url)
            return httpx.Response(204 if "p-new" in url else 404)
        if url.endswith("/api/connections/c1/devices"):
            return httpx.Response(200, json=[{"id": "d1", "tag": "dev"}])
        if url.endswith("/api/devices/d1/points"):
            return httpx.Response(200, json=[{"id": "p-new", "tag": "pt"}, {"id": "p-fresh", "tag": "other"}])
        return httpx.Response(404)

    await _command_via(
        handler,
        lambda c: c.delete_point("p-old", conn_id="c1", device_tag="dev", point_tag="pt"),
    )
    assert not any("/api/devices/d1" in u for u in deleted), "a device with points left must survive"


@pytest.mark.asyncio
async def test_without_an_identity_a_missing_point_stays_absent():
    # Nothing to look up: report honestly rather than guessing at a tag.
    got = await _command_via(lambda r: httpx.Response(404), lambda c: c.delete_point("p1"))
    assert got == "absent"


@pytest.mark.asyncio
async def test_a_point_deleted_by_its_own_id_does_not_go_looking():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(f"{request.method} {request.url}")
        return httpx.Response(204)

    got = await _command_via(
        handler, lambda c: c.delete_point("p1", conn_id="c1", device_tag="d", point_tag="p")
    )
    assert got == "by-id"
    assert len(calls) == 1, f"the id worked; nothing else should have been fetched: {calls}"


@pytest.mark.asyncio
async def test_a_refused_delete_reports_the_gateways_reason():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"error": "a rule still watches this point"})

    with pytest.raises(FleetError) as err:
        await _command_via(handler, lambda c: c.delete_point("p1"))
    assert "a rule still watches this point" in str(err.value)


@pytest.mark.asyncio
async def test_a_403_on_delete_names_the_role_setting():
    with pytest.raises(FleetError) as err:
        await _command_via(lambda r: httpx.Response(403, json={}), lambda c: c.delete_point("p1"))
    assert "EDGE_TOKEN_ROLE" in str(err.value)


@pytest.mark.asyncio
async def test_an_unreachable_gateway_fails_the_delete_rather_than_half_doing_it():
    # If this did not raise, the caller would go on to delete the readings while
    # the gateway still had the point — and the next reading would recreate a
    # point with no history.
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(FleetError):
        await _command_via(handler, lambda c: c.delete_point("p1"))
