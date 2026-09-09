"""PULSE — what the estate view is allowed to claim.

The roll-up is where an honest per-recorder board can quietly become a dishonest
estate figure. "109 of 112 cameras online", computed from two recorders when three
are enrolled, is the worst kind of wrong: it looks precise, and the missing
recorder's cameras simply stop existing.

So these tests are almost entirely about the cases where something is NOT known:
a recorder that did not answer, a volume whose usage could not be read, a recorder
that is not recording (which is not the same as recording without gaps), a camera
an operator disabled on purpose (which is not a fault).
"""

from __future__ import annotations

from app.vms.pulse import rollup


def board(**over) -> dict:
    """A node's sysmon board, shaped as the recorder sends it."""
    body = {
        "generated_at": "2026-09-09T06:00:00Z",
        "verdict": {"level": "ok", "headline": "Recorder healthy", "detail": "all signals green"},
        "engine": {"recording": True, "streaming": True, "db_ok": True},
        "system": {"cpu_pct": 8, "mem_pct": 24},
        "sensors_reported": True,
        "volumes": [
            {"name": "recordings", "path": "/srv/rec", "pool_type": "local", "is_default": True,
             "usage": {"used_percent": 61.0}},
        ],
        "retention_default_days": 30,
        "cameras": {
            "total": 3, "online": 3, "recording_active": 3, "recording_gap_free": True,
            "items": [
                {"id": "c1", "name": "Lobby", "enabled": True, "status": "online"},
                {"id": "c2", "name": "Ramp", "enabled": True, "status": "online"},
                {"id": "c3", "name": "Stair", "enabled": True, "status": "online"},
            ],
        },
        "license": {"state": "valid"},
    }
    body.update(over)
    return body


def views(*boards) -> list[dict]:
    return [rollup.node_view(f"n{i}", f"node-{i}", b) for i, b in enumerate(boards)]


# ── a recorder that did not answer ───────────────────────────────────────────


def test_totals_count_only_the_recorders_that_answered():
    out = rollup.overview(
        views(board()),
        unreachable=[{"node_id": "n9", "name": "south", "error": "connection refused"}],
        offline=[],
    )
    assert out["totals"]["recorders"] == 2
    assert out["totals"]["recorders_answered"] == 1
    assert out["totals"]["cameras_total"] == 3  # the answering node's, not an estimate
    assert out["partial"] is True


def test_a_full_estate_is_not_marked_partial():
    out = rollup.overview(views(board(), board()), unreachable=[], offline=[])
    assert out["partial"] is False
    assert out["totals"]["cameras_total"] == 6


def test_an_unreachable_recorder_is_the_top_thing_needing_attention():
    # While it is unreachable every other number about it is unknown too, so it
    # outranks a full disk on a recorder that is still talking.
    out = rollup.overview(
        views(board(volumes=[{"name": "rec", "usage": {"used_percent": 97.0}}])),
        unreachable=[{"node_id": "n9", "name": "south", "error": "timeout"}],
        offline=[],
    )
    assert out["attention"][0]["kind"] == "recorder_unreachable"
    assert out["attention"][0]["severity"] == "critical"


# ── recording, which is not the same question as "is it online" ──────────────


def test_one_recorder_with_gaps_makes_the_estate_answer_false():
    out = rollup.overview(
        views(board(), board(cameras={**board()["cameras"], "recording_gap_free": False})),
        unreachable=[], offline=[],
    )
    assert out["totals"]["recording_gap_free"] is False
    kinds = [a["kind"] for a in out["attention"]]
    assert "recording_gaps" in kinds


def test_a_recorder_that_is_not_recording_is_unknown_not_gap_free():
    # None means "nothing is recording, so there is nothing to be gap-free about".
    # Reporting True there is a clean bill of health for footage nobody is writing.
    quiet = board(cameras={"total": 2, "online": 2, "recording_active": 0,
                           "recording_gap_free": None, "items": []})
    out = rollup.overview(views(quiet), unreachable=[], offline=[])
    assert out["totals"]["recording_gap_free"] is None
    assert "recording_gaps" not in [a["kind"] for a in out["attention"]]


def test_a_measured_true_still_wins_over_an_unmeasured_recorder():
    quiet = board(cameras={"total": 1, "online": 1, "recording_active": 0,
                           "recording_gap_free": None, "items": []})
    out = rollup.overview(views(board(), quiet), unreachable=[], offline=[])
    assert out["totals"]["recording_gap_free"] is True


# ── storage: a percentage nobody measured is not a percentage ────────────────


def test_a_volume_with_no_readable_usage_is_not_counted_as_full_or_empty():
    b = board(volumes=[
        {"name": "cold", "pool_type": "s3", "usage_error": "s3 pool has no probeable path"},
        {"name": "rec", "pool_type": "local", "usage": {"used_percent": 40.0}},
    ])
    out = rollup.overview(views(b), unreachable=[], offline=[])
    assert out["storage"]["worst_used_percent"] == 40.0
    assert out["storage"]["volumes_measured"] == 1
    assert out["storage"]["volumes_total"] == 2
    # …and the unreadable one is surfaced rather than dropped silently.
    assert "volume_unreadable" in [a["kind"] for a in out["attention"]]


def test_used_percent_is_computed_from_bytes_when_the_node_sends_those():
    pct = rollup.volume_used_pct({"usage": {"total_bytes": 1000, "used_bytes": 900}})
    assert pct == 90.0


def test_a_full_volume_is_critical_and_a_high_one_is_a_warning():
    out = rollup.overview(
        views(board(volumes=[{"name": "a", "usage": {"used_percent": 96.0}},
                             {"name": "b", "usage": {"used_percent": 88.0}}])),
        unreachable=[], offline=[],
    )
    by_kind = {a["kind"]: a for a in out["attention"]}
    assert by_kind["volume_full"]["severity"] == "critical"
    assert by_kind["volume_high"]["severity"] == "warning"


def test_the_estate_retention_is_the_shortest_one_not_an_average():
    # The horizon an operator can actually promise across the estate.
    out = rollup.overview(views(board(retention_default_days=30), board(retention_default_days=7)),
                          unreachable=[], offline=[])
    assert out["storage"]["retention_days_min"] == 7


# ── cameras: named, and only the ones that are a fault ───────────────────────


def test_offline_cameras_are_named_with_the_recorder_that_owns_them():
    b = board(cameras={
        "total": 2, "online": 1, "recording_active": 1, "recording_gap_free": True,
        "items": [
            {"id": "c1", "name": "Lobby", "enabled": True, "status": "online"},
            {"id": "c2", "name": "Ramp", "enabled": True, "status": "offline",
             "last_error": "no route to host", "last_seen_at": "2026-09-09T05:00:00Z"},
        ],
    })
    out = rollup.offline_cameras("n1", "north", b)
    assert len(out) == 1
    assert out[0]["name"] == "Ramp"
    assert out[0]["node_name"] == "north"
    assert out[0]["last_error"] == "no route to host"


def test_a_camera_an_operator_disabled_is_not_a_fault():
    # It was taken out of service on purpose; listing it buries the ones that broke.
    b = board(cameras={
        "total": 2, "online": 1, "recording_active": 1, "recording_gap_free": True,
        "items": [
            {"id": "c1", "name": "Lobby", "enabled": True, "status": "online"},
            {"id": "c2", "name": "Old dome", "enabled": False, "status": "offline"},
        ],
    })
    assert rollup.offline_cameras("n1", "north", b) == []


def test_an_offline_camera_reaches_the_attention_list_with_where_to_go():
    offline = [{"camera_id": "c2", "name": "Ramp", "node_id": "n1", "node_name": "north",
                "status": "offline", "last_error": "no route to host"}]
    out = rollup.overview(views(board()), unreachable=[], offline=offline)
    item = next(a for a in out["attention"] if a["kind"] == "camera_offline")
    assert item["camera_id"] == "c2" and item["node_id"] == "n1"
    assert item["where"] == "north"


# ── the node projection ──────────────────────────────────────────────────────


def test_a_board_with_no_hardware_sample_says_so_rather_than_reading_zero():
    # `sensors_reported` False with a zeroed system block is a box that was never
    # measured; a reader that ignores the flag prints "0% CPU, 0°C".
    v = rollup.node_view("n1", "north", board(sensors_reported=False, system={}))
    assert v["sensors_reported"] is False


def test_the_projection_drops_the_per_camera_rows_the_strip_cannot_use():
    # They are served whole by the drill-down; carrying every camera of every
    # recorder into the estate payload is how this page gets slow.
    v = rollup.node_view("n1", "north", board())
    assert "items" not in v["cameras"]
    assert v["cameras"]["online"] == 3


def test_a_degraded_recorder_is_a_warning_and_a_down_one_is_critical():
    out = rollup.overview(
        views(board(verdict={"level": "degraded", "headline": "Streaming engine stalled"}),
              board(verdict={"level": "down", "headline": "Recording engine down"})),
        unreachable=[], offline=[],
    )
    by_kind = {a["kind"]: a for a in out["attention"]}
    assert by_kind["recorder_degraded"]["severity"] == "warning"
    assert by_kind["recorder_down"]["severity"] == "critical"
    assert out["attention"][0]["severity"] == "critical"
