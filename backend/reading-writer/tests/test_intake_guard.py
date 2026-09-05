"""That an assertion about a point with no data cannot succeed by accident.

The failure under test happened on the live estate: `inlet_water_temp` and
`outlet_water_temp` were bound on `4F Khem Chiller02` to points named `IWT` and
`OWT` while the device publishes `4FKC2_IWT` / `4FKC2_OWT`. The confirmation was
accepted, the metric refused `no_data`, and the chiller looked broken for days
while it ran perfectly.

The bar has TWO halves and the negative one matters more. A guard that refuses
every point with no readings would fire on the two chillers that arrive this
week, during the exact minutes an operator is looking at them — and a guard that
refuses correct work is a guard that gets removed, taking the real protection
with it. So "arrived a moment ago and has not reported yet" is asserted here to
be PERMITTED, as loudly as the wrong binding is asserted to be refused.

`classify` and `refusals` are pure and are the whole decision; the SQL around
them only supplies `max(readings.ts)`. Nothing here touches a database.
"""

from __future__ import annotations

import datetime as dt

from app.api.intake import (
    CHALLENGED,
    FIRST_READING_GRACE_MIN,
    SILENT_AFTER_HOURS,
    STATES,
    classify,
    refusals,
)

NOW = dt.datetime(2026, 9, 5, 12, 0, tzinfo=dt.timezone.utc)


def _point(**kw):
    row = {
        "point_id": "11111111-1111-1111-1111-111111111111",
        "device_tag": "4F Khem Chiller02",
        "point_tag": "IWT",
        "first_seen_at": NOW - dt.timedelta(days=6),
        "last_reading_at": NOW - dt.timedelta(minutes=5),
        "siblings": ["4FKC2_IWT", "4FKC2_OWT"],
    }
    row.update(kw)
    return row


# ── classify ─────────────────────────────────────────────────────────────────


def test_a_point_reporting_now_is_reporting():
    assert classify(NOW - dt.timedelta(days=30), NOW - dt.timedelta(minutes=5), NOW) == "reporting"


def test_a_brand_new_point_with_no_reading_yet_is_awaiting_not_dead():
    """The two chillers that arrived this morning. Ordinary, not a fault."""
    fresh = NOW - dt.timedelta(minutes=FIRST_READING_GRACE_MIN - 1)
    assert classify(fresh, None, NOW) == "awaiting_first_reading"


def test_a_point_that_never_reported_past_the_grace_is_never_reported():
    stale = NOW - dt.timedelta(minutes=FIRST_READING_GRACE_MIN + 1)
    assert classify(stale, None, NOW) == "never_reported"


def test_a_point_that_reported_once_and_stopped_is_silent():
    """The address that WAS right until the device was re-tagged."""
    last = NOW - dt.timedelta(hours=SILENT_AFTER_HOURS + 1)
    assert classify(NOW - dt.timedelta(days=6), last, NOW) == "silent"


def test_the_silence_horizon_is_inclusive_at_its_edge():
    """A point exactly at the threshold is still reporting: the boundary must
    not flicker a row between states on consecutive page loads."""
    edge = NOW - dt.timedelta(hours=SILENT_AFTER_HOURS)
    assert classify(NOW - dt.timedelta(days=6), edge, NOW) == "reporting"


def test_a_row_with_no_first_seen_at_and_no_reading_is_never_reported():
    """`first_seen_at` is NOT NULL in the schema, so this is unreachable through
    the writer — asserted anyway, because the fallback must not be the
    permissive one if a row ever arrives another way."""
    assert classify(None, None, NOW) == "never_reported"


def test_every_state_classify_returns_is_declared():
    seen = {
        classify(NOW, None, NOW),
        classify(NOW - dt.timedelta(days=9), None, NOW),
        classify(NOW - dt.timedelta(days=9), NOW, NOW),
        classify(NOW - dt.timedelta(days=9), NOW - dt.timedelta(days=3), NOW),
    }
    assert seen == set(STATES)


# ── the decision ─────────────────────────────────────────────────────────────


def test_a_reporting_point_is_not_challenged():
    assert refusals([_point()], now=NOW) == []


def test_a_new_and_quiet_point_is_not_challenged():
    """This is the half that stops the guard from being switched off."""
    fresh = _point(first_seen_at=NOW - dt.timedelta(minutes=1), last_reading_at=None)
    assert refusals([fresh], now=NOW) == []


def test_the_wrong_binding_is_challenged_and_names_the_spelling_that_works():
    dead = _point(first_seen_at=NOW - dt.timedelta(days=6), last_reading_at=None)
    (bad,) = refusals([dead], now=NOW)
    assert bad["state"] == "never_reported"
    assert bad["point_tag"] == "IWT"
    # Named, never chosen: the operator is shown the device's live points and
    # the server binds nothing on their behalf.
    assert bad["reporting_siblings"] == ["4FKC2_IWT", "4FKC2_OWT"]


def test_a_point_that_went_silent_is_challenged_too():
    """The actual state of the mis-bound chiller points on this estate: they
    reported until the device was re-tagged, then stopped. Keyed on
    max(readings.ts), a re-delivered retained message cannot hide that."""
    quiet = _point(last_reading_at=NOW - dt.timedelta(days=3))
    (bad,) = refusals([quiet], now=NOW)
    assert bad["state"] == "silent"


def test_a_mixed_batch_challenges_only_the_points_that_deserve_it():
    rows = [
        _point(point_id="a", point_tag="4FKC2_IWT"),
        _point(point_id="b", point_tag="IWT", last_reading_at=None,
               first_seen_at=NOW - dt.timedelta(days=6)),
        _point(point_id="c", point_tag="OWT", last_reading_at=NOW - dt.timedelta(days=4)),
    ]
    assert [b["point_id"] for b in refusals(rows, now=NOW)] == ["b", "c"]


def test_only_the_two_data_free_states_are_challenged():
    assert set(CHALLENGED) == {"never_reported", "silent"}
    assert "reporting" not in CHALLENGED and "awaiting_first_reading" not in CHALLENGED


def test_a_refusal_carries_no_datetime_object():
    """`kernel.errors` renders an AppError's `details` with `json.dumps`, not
    `jsonable_encoder`. A datetime in there turned the refusal into a 500
    INTERNAL_ERROR — the operator got no message at all, which is worse than the
    silent success this guard replaces."""
    import json

    quiet = _point(last_reading_at=NOW - dt.timedelta(days=3))
    json.dumps(refusals([quiet], now=NOW))
