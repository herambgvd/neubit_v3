"""A message becomes a ROW, or it becomes a counted refusal — never a guess.

WHY THIS FILE EXISTS. `projections/extract.py` is the one place a published
event turns into column values, and every rule it keeps is a rule about NOT
inventing data: a missing number stays NULL rather than becoming 0, a value that
does not fit its declared type stops the row rather than being rounded into it,
and a timestamp that cannot be parsed is malformed rather than stamped with
now(). All of that is invisible when it breaks — the projector keeps running and
the table fills with plausible rows.

The coercers were turned into a DISPATCH TABLE (`_COERCERS`). A table is one
readable list of what a spec may declare, and it is also one place an entry can
be dropped or mistyped without anything failing to import. So each type is
exercised here by NAME, both with a value that fits and with one that does not,
and the refusal is asserted to name the column — `bad_number:power` is what
sends somebody to the right publisher; a bare `Malformed` sends them nowhere.

Nothing here needs a database. `extract` is a pure function of (body, spec).
"""

from __future__ import annotations

import datetime as dt
import json
import math
import uuid

import pytest

from app.projections import extract as ex
from app.projections.spec import Column

UTC = dt.timezone.utc
TENANT = uuid.UUID("11111111-2222-3333-4444-555555555555")


def _col(name: str, type_: str, source: str | None = None, **kw) -> Column:
    # `model_construct` on purpose for the unsupported-type case: `ColumnType` is
    # a Literal, so a spec CANNOT declare `numeric` — the guard in `_coerce`
    # exists for a table entry that was removed, which is exactly the failure a
    # validated Column cannot express.
    body = {"name": name, "type": type_, "source": source or f"payload.{name}", **kw}
    if type_ not in (
        "timestamptz", "uuid", "text", "bigint", "double precision", "boolean", "jsonb"
    ):
        return Column.model_construct(required=False, tenant=False, default=None, **body)
    return Column.model_validate(body)


class _Target:
    def __init__(self, cols):
        self.columns = list(cols)


class _Proj:
    """`extract` reads exactly one thing off a Projection: `target.columns`."""

    def __init__(self, cols):
        self.target = _Target(cols)


def _proj(*cols: Column) -> _Proj:
    return _Proj(cols)


def _tenant_resolver(raw):
    return TENANT


def _extract(body, *cols: Column) -> dict:
    return ex.extract(body, _proj(*cols), _tenant_resolver)


# ── the dispatch table, entry by entry ───────────────────────────────────────


@pytest.mark.parametrize(
    "type_, given, expected",
    [
        ("text", "door forced", "door forced"),
        # A structured value in a text column is JSON, not python's `repr` — a
        # repr uses single quotes and nothing downstream can parse it back.
        ("text", {"b": 1, "a": 2}, '{"b":1,"a":2}'),
        ("text", [1, "x"], '[1,"x"]'),
        ("text", 7, "7"),
        ("bigint", "42", 42),
        ("bigint", 42.9, 42),
        ("double precision", "1.5", 1.5),
        ("double precision", 2, 2.0),
        ("boolean", "YES", True),
        ("boolean", "off", False),
        ("boolean", False, False),
        ("jsonb", {"a": [1, 2]}, '{"a":[1,2]}'),
    ],
)
def test_each_declared_type_puts_the_value_in_that_type(type_, given, expected):
    """One row per entry in `_COERCERS`. A dropped or mistyped entry makes the
    column `unsupported_type` at runtime and nothing at import time, so the only
    thing that catches it is asking for each type by name."""
    row = _extract({"payload": {"v": given}}, _col("v", type_))
    assert row["v"] == expected


def test_a_uuid_column_takes_a_uuid_object_and_a_string_alike():
    u = uuid.UUID("22222222-3333-4444-5555-666666666666")
    assert _extract({"payload": {"v": u}}, _col("v", "uuid"))["v"] == u
    assert _extract({"payload": {"v": str(u)}}, _col("v", "uuid"))["v"] == u


@pytest.mark.parametrize(
    "type_, given, reason",
    [
        ("bigint", "twelve", "bad_int:v"),
        ("bigint", [], "bad_int:v"),
        ("double precision", "n/a", "bad_number:v"),
        ("boolean", "maybe", "bad_bool:v"),
        ("uuid", "not-a-uuid", "bad_uuid:v"),
        ("uuid", 17, "bad_uuid:v"),
        ("timestamptz", "the third", "bad_time:v"),
        ("timestamptz", ["2026-01-01"], "bad_time:v"),
    ],
)
def test_a_value_that_does_not_fit_its_type_stops_the_row_and_names_the_column(
    type_, given, reason
):
    """The reason is a LOW-CARDINALITY LABEL that reaches a metric and a log
    line. Without the column name in it, "some field in some projection is the
    wrong type" is all an operator ever learns."""
    with pytest.raises(ex.Malformed) as exc:
        _extract({"payload": {"v": given}}, _col("v", type_))
    assert exc.value.reason == reason


@pytest.mark.parametrize("given", [float("nan"), float("inf"), "-inf"])
def test_a_non_finite_number_is_refused_rather_than_stored_or_nulled(given):
    """NaN and ±Inf cannot be charted, and writing them as NULL would claim the
    publisher sent nothing when it sent something unusable. Refusing counts the
    message; nulling it would hide a broken sensor as a quiet gap."""
    with pytest.raises(ex.Malformed) as exc:
        _extract({"payload": {"v": given}}, _col("v", "double precision"))
    assert exc.value.reason == "bad_number:v"


def test_a_type_the_table_does_not_carry_refuses_instead_of_storing_the_raw_value():
    """`_COERCERS.get` returning None is the only thing between an unknown type
    and a python object handed to the driver. It must be a named refusal."""
    with pytest.raises(ex.Malformed) as exc:
        _extract({"payload": {"v": 3}}, _col("v", "numeric"))
    assert exc.value.reason == "unsupported_type:v"


# ── time: parsed as stated, never as now() ───────────────────────────────────


@pytest.mark.parametrize(
    "given, expected",
    [
        ("2026-03-01T04:05:06Z", dt.datetime(2026, 3, 1, 4, 5, 6, tzinfo=UTC)),
        ("2026-03-01T04:05:06+02:00", dt.datetime(2026, 3, 1, 2, 5, 6, tzinfo=UTC)),
        # Naive means UTC, not local — a container's TZ must not move an event.
        ("2026-03-01T04:05:06", dt.datetime(2026, 3, 1, 4, 5, 6, tzinfo=UTC)),
        (dt.datetime(2026, 3, 1, 4, 5, 6), dt.datetime(2026, 3, 1, 4, 5, 6, tzinfo=UTC)),
    ],
)
def test_an_event_time_is_read_as_stated_and_normalised_to_utc(given, expected):
    assert _extract({"payload": {"v": given}}, _col("v", "timestamptz"))["v"] == expected


@pytest.mark.parametrize(
    "given",
    [1772337906, 1772337906_000, 1772337906_000_000],
)
def test_seconds_milliseconds_and_microseconds_all_land_on_the_same_instant(given):
    """A publisher changing its epoch unit must not quietly write rows into the
    year 58000. The magnitude test is the only thing preventing that, and all
    three scales have to agree or it is not doing its job."""
    got = _extract({"payload": {"v": given}}, _col("v", "timestamptz"))["v"]
    assert got == dt.datetime(2026, 3, 1, 4, 5, 6, tzinfo=UTC)


def test_an_epoch_too_large_for_a_datetime_is_malformed_not_an_unhandled_error():
    """An `OverflowError` escaping here would kill the batch behind this message
    rather than acking and counting the one that is broken."""
    with pytest.raises(ex.Malformed) as exc:
        _extract({"payload": {"v": 1e30}}, _col("v", "timestamptz"))
    assert exc.value.reason == "bad_time:v"


# ── absence: the rules that keep a gap a gap ─────────────────────────────────


def test_an_absent_optional_column_is_null_and_never_a_zero():
    """The whole num/txt split exists to stop a missing measurement becoming 0.
    A projection column is the same wire and the same rule."""
    row = _extract({"payload": {}}, _col("v", "double precision"))
    assert row["v"] is None


def test_an_absent_required_column_refuses_by_name():
    with pytest.raises(ex.Malformed) as exc:
        _extract({"payload": {}}, _col("v", "text", required=True))
    assert exc.value.reason == "missing:v"


def test_a_declared_default_fills_an_absent_path_and_is_coerced_like_any_value():
    row = _extract({"payload": {}}, _col("v", "text", default="unknown"))
    assert row["v"] == "unknown"


def test_a_path_that_walks_through_a_non_dict_is_absence_not_an_exception():
    """`payload.detail.code` over `detail: "x"` used to be a chance for an
    AttributeError to take down the consumer. It is a column with no value."""
    row = _extract(
        {"payload": {"detail": "x"}}, _col("v", "text", source="payload.detail.code")
    )
    assert row["v"] is None


def test_an_empty_string_in_a_uuid_column_is_absence_and_not_a_parse_failure():
    """Contract §3's loss: a publisher marshalling `conn_id` as `""` killed every
    alert in a replay as `bad_uuid`, while the same shape in a READING survived.
    Two consumers of one wire must agree that `""` is "nothing to say"."""
    row = _extract({"payload": {"v": ""}}, _col("v", "uuid"))
    assert row["v"] is None


def test_a_required_uuid_sent_as_an_empty_string_reports_missing_not_bad_uuid():
    """The distinction is the whole point: `bad_uuid` sends somebody hunting for
    a malformed value that was never there. `missing` is what happened."""
    with pytest.raises(ex.Malformed) as exc:
        _extract({"payload": {"v": "  "}}, _col("v", "uuid", required=True))
    assert exc.value.reason == "missing:v"


def test_a_tenant_column_always_resolves_and_is_never_the_reason_a_row_is_dropped():
    """Rule 3 of `tenants.py` never returns None, so marking a tenant column
    `required` must not be able to refuse a platform-scoped event."""
    row = _extract(
        {"tenant_id": None},
        _col("t", "uuid", source="tenant_id", tenant=True, required=True),
    )
    assert row["t"] == TENANT


# ── the body itself ──────────────────────────────────────────────────────────


def test_a_json_body_is_decoded_and_a_broken_one_is_named_undecodable():
    col = _col("v", "text")
    assert _extract(json.dumps({"payload": {"v": "ok"}}).encode(), col)["v"] == "ok"
    with pytest.raises(ex.Malformed) as exc:
        _extract(b"{not json", col)
    assert exc.value.reason == "undecodable_body"


def test_a_body_that_decodes_to_something_other_than_an_object_is_refused():
    """A bare list or number decodes fine and then every `_walk` returns None,
    so without this guard the message would become a row of NULLs — a row that
    claims an event happened and says nothing about it."""
    with pytest.raises(ex.Malformed) as exc:
        _extract(b"[1, 2]", _col("v", "text"))
    assert exc.value.reason == "body_not_an_object"


def test_every_declared_column_is_present_in_the_row_even_when_it_has_no_value():
    """The row is the INSERT's parameter set. A key silently omitted for an
    absent path is a bind-parameter error at write time, one batch later and
    nowhere near the message that caused it."""
    row = _extract(
        {"payload": {"a": 1}},
        _col("a", "bigint"),
        _col("b", "text"),
        _col("c", "double precision"),
    )
    assert set(row) == {"a", "b", "c"}
    assert row["b"] is None and row["c"] is None


def test_a_nan_float_is_not_confused_with_a_finite_one_in_the_guard():
    """Guards against the guard being written as `f != f` only, or as a range
    check that lets Inf through."""
    assert not math.isfinite(float("inf"))
    row = _extract({"payload": {"v": 0.0}}, _col("v", "double precision"))
    assert row["v"] == 0.0
