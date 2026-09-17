"""What the IoT gateway API joins, and what it refuses to merge.

The endpoint puts two different numbers next to each other for every
connection: what the gateway has CONFIGURED, and what has actually ARRIVED
here. The temptation is to reconcile them into one figure. The gap between them
is the finding — a connection configured with 437 points that has delivered 436
is a fault neither side can see alone — so they stay side by side.
"""

from __future__ import annotations

from app.api.iot import _merge


def test_each_connection_carries_both_sides_numbers():
    gateway = {
        "gatewayId": "g1",
        "connections": [{"id": "c1", "slug": "aeon", "devices": 38, "points": 437}],
    }
    arrived = {"c1": {"devices": 38, "points": 436, "last_seen_at": "2026-09-17T17:59:16+00:00"}}
    out = _merge(gateway, arrived)
    c = out["connections"][0]
    # The gateway's own figures are untouched...
    assert c["devices"] == 38
    assert c["points"] == 437
    # ...and ours sit beside them, never merged into them.
    assert c["arrived"] == {
        "devices": 38,
        "points": 436,
        "last_seen_at": "2026-09-17T17:59:16+00:00",
    }


def test_a_connection_nothing_has_arrived_from_reads_zero_not_missing():
    # A configured connection that has delivered nothing is the single most
    # important row on this screen. It must render as 0, not as absent.
    out = _merge({"gatewayId": "g1", "connections": [{"id": "c1", "points": 40}]}, {})
    assert out["connections"][0]["arrived"] == {
        "devices": 0,
        "points": 0,
        "last_seen_at": None,
    }


def test_a_gateway_that_cannot_report_its_connections_stays_null():
    # `null` means "this gateway is on a build that cannot tell me". Turning it
    # into [] would make the console say "this gateway has no connections",
    # which is a different and much more alarming claim.
    out = _merge({"gatewayId": "g1", "connections": None}, {"c1": {"points": 5}})
    assert out["connections"] is None


def test_an_empty_inventory_stays_empty():
    out = _merge({"gatewayId": "g1", "connections": []}, {})
    assert out["connections"] == []


def test_junk_in_the_inventory_is_skipped_not_fatal():
    gateway = {"gatewayId": "g1", "connections": ["not-a-dict", {"id": "c1"}]}
    out = _merge(gateway, {})
    assert [c["id"] for c in out["connections"]] == ["c1"]


def test_the_gateways_own_fields_survive_the_merge():
    gateway = {
        "gatewayId": "g1",
        "label": "Head office",
        "site": "Pune",
        "state": "approved",
        "connections": [],
    }
    out = _merge(gateway, {})
    assert out["label"] == "Head office"
    assert out["site"] == "Pune"
    assert out["state"] == "approved"


def test_merge_does_not_mutate_what_the_gateway_sent():
    # The same gateway dict is merged once per request; mutating it in place
    # would make a second call see the first call's `arrived` blocks.
    gateway = {"gatewayId": "g1", "connections": [{"id": "c1"}]}
    _merge(gateway, {"c1": {"devices": 1, "points": 2, "last_seen_at": None}})
    assert "arrived" not in gateway["connections"][0]
