"""That a message which stored nothing cannot make a dead point look alive.

The failure under test is the one that put `points.last_seen_at` three days ahead
of `max(readings.ts)` on `4F Khem Chiller02 / IWT`. The writer upserted the
dimension row for every message and THEN inserted the readings `ON CONFLICT DO
NOTHING`, so a retained MQTT message the broker replays on every poll — which
stores nothing, by design — still dragged `last_seen_at` to now() and erased
`retired_at`. `LIVE_POINT` reads that column, so the address stayed live, outlived
the 30-day horizon, and offered itself for confirmation like a working point.

`dimension_rows` is the whole decision and it is pure: which points a batch
earned a row for, and what `last_seen_at` may say. The SQL around it only carries
the answer. Nothing here touches a database.

The negative half matters as much as the positive one. A guard that also dropped
the row for a genuinely NEW point would make a new sensor invisible instead of
merely wrong — `/bi/intake`'s `awaiting_first_reading` state depends on that row
existing before anyone has confirmed anything — so "first reading lands, row
appears" is asserted here as loudly as "replay changes nothing".
"""

from __future__ import annotations

import datetime as dt
import uuid

from app.envelope import ParsedReading
from app.store import _fingerprint, dimension_rows

NOW = dt.datetime(2026, 9, 5, 12, 0, tzinfo=dt.timezone.utc)
TENANT = uuid.UUID("11111111-1111-1111-1111-111111111111")
IWT = uuid.UUID("22222222-2222-2222-2222-222222222222")
OWT = uuid.UUID("33333333-3333-3333-3333-333333333333")


def _r(point_id: uuid.UUID = IWT, ts: dt.datetime = NOW, **kw) -> ParsedReading:
    row = {
        "ts": ts,
        "tenant_id": TENANT,
        "point_id": point_id,
        "num": 7.5,
        "txt": None,
        "quality": 0,
        "conn_id": None,
        "device_id": None,
        "device_tag": "4F Khem Chiller02",
        "point_tag": "IWT",
        "unit": None,
        "category": None,
        "device_type": None,
        "type": "num",
        "meta": None,
    }
    row.update(kw)
    return ParsedReading(**row)


# ── the replay, which is the bug ─────────────────────────────────────────────


def test_a_batch_that_stored_nothing_earns_no_dimension_row():
    """The retained message. It names a point; it is not evidence about one."""
    assert dimension_rows([_r()], stored_ids=set(), now=NOW) == {}


def test_a_replayed_point_is_dropped_while_a_live_one_beside_it_is_kept():
    """Mixed batches are the normal case: one dead address on a live device."""
    rows = [_r(point_id=IWT), _r(point_id=OWT, point_tag="4FKC2_OWT")]
    out = dimension_rows(rows, stored_ids={OWT}, now=NOW)
    assert set(out) == {OWT}


# ── what last_seen_at is allowed to say ──────────────────────────────────────


def test_last_seen_at_is_the_reading_ts_not_the_arrival_time():
    """`now()` is what let a three-day-old address report itself as live."""
    measured = NOW - dt.timedelta(hours=3)
    out = dimension_rows([_r(ts=measured)], stored_ids={IWT}, now=NOW)
    assert out[IWT]["last_seen_at"] == measured
    assert out[IWT]["first_seen_at"] == NOW


def test_last_seen_at_takes_the_newest_ts_in_the_batch_not_the_last_one():
    """This estate publishes bursts, and a burst is not guaranteed ordered."""
    newest = NOW - dt.timedelta(minutes=1)
    rows = [_r(ts=newest), _r(ts=NOW - dt.timedelta(minutes=9))]
    out = dimension_rows(rows, stored_ids={IWT}, now=NOW)
    assert out[IWT]["last_seen_at"] == newest


def test_a_conflicting_ts_still_counts_because_that_row_is_already_stored():
    """A duplicate ts is not a lie about storage — it is proof of it.

    The batch stored the newer row; the older one conflicted, which means it was
    written by an earlier batch. Either way a reading exists at the ts written.
    """
    rows = [_r(ts=NOW - dt.timedelta(minutes=5)), _r(ts=NOW)]
    out = dimension_rows(rows, stored_ids={IWT}, now=NOW)
    assert out[IWT]["last_seen_at"] == NOW


# ── the negative half: a new point must still appear ─────────────────────────


def test_a_points_first_ever_reading_earns_its_row_immediately():
    """A new point_id cannot conflict, so its first reading always lands."""
    out = dimension_rows([_r()], stored_ids={IWT}, now=NOW)
    assert out[IWT]["point_id"] == IWT
    assert out[IWT]["point_tag"] == "IWT"


# ── the dedup ON CONFLICT DO UPDATE requires ─────────────────────────────────


def test_one_row_per_point_carrying_the_last_messages_description():
    """Two rows for one key make Postgres refuse the whole statement."""
    rows = [_r(device_tag="old"), _r(ts=NOW - dt.timedelta(minutes=5), device_tag="new")]
    out = dimension_rows(rows, stored_ids={IWT}, now=NOW)
    assert len(out) == 1
    assert out[IWT]["device_tag"] == "new"
    assert out[IWT]["last_seen_at"] == NOW


# ── the fingerprint, which decides when a cold point re-upserts early ────────


def test_a_reclassified_point_changes_its_fingerprint():
    a = dimension_rows([_r()], {IWT}, NOW)[IWT]
    b = dimension_rows([_r(category="energy")], {IWT}, NOW)[IWT]
    assert _fingerprint(a) != _fingerprint(b)


def test_a_new_timestamp_alone_does_not_change_the_fingerprint():
    """Otherwise every reading re-upserts and `points` is as hot as `readings`."""
    a = dimension_rows([_r(ts=NOW)], {IWT}, NOW)[IWT]
    b = dimension_rows([_r(ts=NOW + dt.timedelta(minutes=5))], {IWT}, NOW)[IWT]
    assert _fingerprint(a) == _fingerprint(b)
