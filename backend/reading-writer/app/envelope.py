"""Decode one bus message into a row for `readings` (+ its `points` dimension).

The wire format is the pipeline contract §3 body:

    {"tenant_id", "domain": "iot", "event": "reading",
     "payload": {conn_id, device_id, device_tag, point_id, point_tag,
                 env: {src, v, raw, u, ts, q, kind, s}}}

Three properties of `env` are load-bearing and this module exists to preserve
them exactly:

* **A text reading has no ``v``.** ``Envelope.MarshalJSON`` on the gateway omits
  ``v`` and ``raw`` when ``kind == "text"`` and sends ``s`` instead, because
  publishing ``"v": 0`` for a status is a number nobody measured. So a text
  reading becomes ``num=NULL, txt=<s>``. Never ``num=0``.
* **``ts`` is the measurement time**, not arrival time. Outbox replay delivers
  readings minutes late and the row must carry when it was *measured*.
* **``point_id`` is the identity.** It is the leading half of
  ``PRIMARY KEY (point_id, ts)``, so a message without a usable one has no row
  it could occupy. Those are counted and dropped, never guessed at.

TIMESTAMP UNITS. The gateway's ``Envelope.Ts`` is documented and observed as
**epoch seconds** (contract §3's example shows a millisecond value — that example
is wrong; see the note added to §9). Rather than trust either, the magnitude
decides: a value that could only be milliseconds or microseconds is scaled. A
plain seconds timestamp is unambiguous until the year 5138, which is long enough.
"""

from __future__ import annotations

import datetime as dt
import json
import uuid
from dataclasses import dataclass
from typing import Any

# Boundaries between epoch-second / -millisecond / -microsecond magnitudes.
_MS_FLOOR = 1e11  # ~1973 in ms; no plausible seconds value reaches this
_US_FLOOR = 1e14  # ~1973 in us

# Anything outside this is not a measurement time, it is a bug. Rejecting is
# better than writing a row into a chunk 200 years from now, which would also
# defeat retention (drop_chunks never reaches it).
_MIN_TS = dt.datetime(2000, 1, 1, tzinfo=dt.timezone.utc)
_MAX_TS = dt.datetime(2100, 1, 1, tzinfo=dt.timezone.utc)


class Malformed(ValueError):
    """The message cannot become a row. Carries a short, groupable reason."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class ParsedReading:
    ts: dt.datetime
    tenant_id: uuid.UUID
    point_id: uuid.UUID
    num: float | None
    txt: str | None
    quality: int
    # Dimension fields — everything that is NOT a measurement (contract §5).
    conn_id: uuid.UUID | None
    device_id: uuid.UUID | None
    device_tag: str | None
    point_tag: str | None
    unit: str | None
    category: str | None
    type: str | None
    meta: dict | None


def _as_uuid(value: Any) -> uuid.UUID | None:
    if not value:
        return None
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def _to_ts(raw: Any) -> dt.datetime:
    if isinstance(raw, bool) or raw is None:
        raise Malformed("ts_missing")
    try:
        val = float(raw)
    except (TypeError, ValueError):
        raise Malformed("ts_not_numeric") from None
    if val <= 0:
        raise Malformed("ts_not_positive")

    mag = abs(val)
    if mag >= _US_FLOOR:
        seconds = val / 1_000_000.0
    elif mag >= _MS_FLOOR:
        seconds = val / 1_000.0
    else:
        seconds = val

    try:
        ts = dt.datetime.fromtimestamp(seconds, tz=dt.timezone.utc)
    except (OverflowError, OSError, ValueError):
        raise Malformed("ts_out_of_range") from None
    if not (_MIN_TS <= ts <= _MAX_TS):
        raise Malformed("ts_out_of_range")
    return ts


def _clean(value: Any, limit: int) -> str | None:
    """Trim a free-text dimension field to what its column can hold."""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    return s[:limit]


def parse(data: bytes, resolve_tenant) -> ParsedReading:
    """Decode a message body. Raises :class:`Malformed` if it cannot become a row."""
    try:
        body = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        raise Malformed("not_json") from None
    if not isinstance(body, dict):
        raise Malformed("not_an_object")

    # Guard against a subject filter change accidentally feeding us alerts: an
    # alert is an event, not a measurement, and has no row here.
    if body.get("event") not in (None, "reading"):
        raise Malformed(f"not_a_reading:{body.get('event')}")

    payload = body.get("payload")
    if not isinstance(payload, dict):
        raise Malformed("no_payload")
    env = payload.get("env")
    if not isinstance(env, dict):
        raise Malformed("no_env")

    point_id = _as_uuid(payload.get("point_id"))
    if point_id is None:
        # No point_id → no primary key → no row. Counted, logged, and acked:
        # redelivering a message that can never be stored just blocks the stream.
        raise Malformed("point_id_missing")

    ts = _to_ts(env.get("ts"))
    tenant_id = resolve_tenant(body.get("tenant_id"))

    # ── the num/txt split (contract §3/§5) ────────────────────────────────────
    # `kind == "text"` is authoritative; `v` is ABSENT on those, so a missing `v`
    # with an `s` present is treated as text too (belt and braces — the gateway's
    # marshaller guarantees the first, and this survives it changing).
    kind = (env.get("kind") or "").strip().lower()
    num: float | None = None
    txt: str | None = None
    if kind == "text" or ("v" not in env and env.get("s") is not None):
        txt = env.get("s")
        txt = None if txt is None else str(txt)
        if txt is None:
            raise Malformed("text_reading_without_s")
    else:
        v = env.get("v")
        if v is None:
            raise Malformed("no_value")
        try:
            num = float(v)
        except (TypeError, ValueError):
            raise Malformed("v_not_numeric") from None
        if num != num or num in (float("inf"), float("-inf")):  # NaN / Inf
            raise Malformed("v_not_finite")

    try:
        quality = int(env.get("q") or 0)
    except (TypeError, ValueError):
        quality = 0
    quality = max(-32768, min(32767, quality))

    src = env.get("src") if isinstance(env.get("src"), dict) else {}
    meta = env.get("meta") if isinstance(env.get("meta"), dict) else None
    # Keep the gateway's protocol/connection/address on the DIMENSION row, not on
    # every reading — that is the whole point of the points table.
    dim_meta: dict[str, Any] = {}
    if src:
        dim_meta["src"] = src
    if meta:
        dim_meta["meta"] = meta

    return ParsedReading(
        ts=ts,
        tenant_id=tenant_id,
        point_id=point_id,
        num=num,
        txt=txt,
        quality=quality,
        conn_id=_as_uuid(payload.get("conn_id")),
        device_id=_as_uuid(payload.get("device_id")),
        device_tag=_clean(payload.get("device_tag"), 255),
        point_tag=_clean(payload.get("point_tag"), 255),
        unit=_clean(env.get("u"), 64),
        # The gateway sends no operator-facing category today; take one from
        # `meta` if it ever does rather than inventing one from the protocol.
        category=_clean((meta or {}).get("category"), 128),
        type="text" if txt is not None else "num",
        meta=dim_meta or None,
    )
