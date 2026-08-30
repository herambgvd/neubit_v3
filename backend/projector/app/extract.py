"""Envelope → row. The one place a published event becomes column values.

The body of every platform event is ``kernel.events.envelope``::

    {event_id, tenant_id, type, occurred_at, source, payload}

A projection's columns name a DOTTED PATH into that dict, so ``payload.result``
is the domain's own field and ``tenant_id`` is the envelope's. The path is walked
with plain dictionary lookups; nothing about it is ever interpolated into a
statement.

TWO THINGS THIS FILE REFUSES TO DO
----------------------------------
**It never invents a value.** A path that is absent yields NULL unless the column
declares a literal ``default``, and a NULL renders as absence downstream (builder
contract §4). A missing number does not become 0 — that is exactly the "fake
zero" the reading pipeline's num/txt split exists to prevent, and the reasoning
does not change because the domain did.

**It never guesses a timestamp.** ``occurred_at`` is when the thing HAPPENED, as
the publisher reported it. If a projection's time column cannot be parsed the
message is malformed and is counted as such; it is not silently stamped with
now(), because a row that lies about when it happened is worse than a row that is
missing and counted.

A message that cannot become a row raises ``Malformed``. The caller acks it (an
un-ackable poison message is redelivered forever and blocks the batch behind it)
and counts it with its reason.
"""

from __future__ import annotations

import datetime as dt
import json
import uuid
from typing import Any

from .spec import Column, Projection


class Malformed(Exception):
    """This message can never become a row. Reason is a low-cardinality label."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _walk(body: dict, path: str) -> Any:
    cur: Any = body
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
        if cur is None:
            return None
    return cur


def _as_time(value: Any, col: str) -> dt.datetime:
    """Parse an event time. ISO-8601 (what `kernel.events.envelope` writes) or an
    epoch number, decided by magnitude the way the reading parser does."""
    if isinstance(value, dt.datetime):
        out = value
    elif isinstance(value, (int, float)):
        v = float(value)
        # Seconds / milliseconds / microseconds, by magnitude. A unit change on a
        # publisher must not quietly write rows into the year 58000.
        if v > 1e14:
            v /= 1_000_000.0
        elif v > 1e11:
            v /= 1000.0
        try:
            out = dt.datetime.fromtimestamp(v, dt.timezone.utc)
        except (OverflowError, OSError, ValueError) as exc:
            raise Malformed(f"bad_time:{col}") from exc
    elif isinstance(value, str):
        try:
            out = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise Malformed(f"bad_time:{col}") from exc
    else:
        raise Malformed(f"bad_time:{col}")
    if out.tzinfo is None:
        out = out.replace(tzinfo=dt.timezone.utc)
    return out.astimezone(dt.timezone.utc)


def _coerce(col: Column, value: Any) -> Any:
    t = col.type
    if t == "timestamptz":
        return _as_time(value, col.name)
    if t == "uuid":
        if isinstance(value, uuid.UUID):
            return value
        try:
            return uuid.UUID(str(value))
        except (ValueError, AttributeError, TypeError) as exc:
            raise Malformed(f"bad_uuid:{col.name}") from exc
    if t == "text":
        if isinstance(value, (dict, list)):
            return json.dumps(value, separators=(",", ":"))
        return str(value)
    if t == "bigint":
        try:
            return int(value)
        except (TypeError, ValueError) as exc:
            raise Malformed(f"bad_int:{col.name}") from exc
    if t == "double precision":
        try:
            f = float(value)
        except (TypeError, ValueError) as exc:
            raise Malformed(f"bad_number:{col.name}") from exc
        # NaN/Inf are not storable in a way anything downstream can chart, and
        # writing them as NULL would claim the publisher sent nothing.
        if f != f or f in (float("inf"), float("-inf")):
            raise Malformed(f"bad_number:{col.name}")
        return f
    if t == "boolean":
        if isinstance(value, bool):
            return value
        s = str(value).strip().lower()
        if s in ("true", "1", "yes", "y", "on"):
            return True
        if s in ("false", "0", "no", "n", "off"):
            return False
        raise Malformed(f"bad_bool:{col.name}")
    if t == "jsonb":
        return json.dumps(value, separators=(",", ":"), default=str)
    raise Malformed(f"unsupported_type:{col.name}")


def extract(body: bytes | dict, proj: Projection, resolve_tenant) -> dict:
    """One message → one row dict keyed by column name. Raises `Malformed`."""
    if isinstance(body, (bytes, bytearray)):
        try:
            decoded = json.loads(body.decode())
        except (ValueError, UnicodeDecodeError) as exc:
            raise Malformed("undecodable_body") from exc
    else:
        decoded = body
    if not isinstance(decoded, dict):
        raise Malformed("body_not_an_object")

    row: dict[str, Any] = {}
    for col in proj.target.columns:
        raw = _walk(decoded, col.source)
        if raw is None:
            raw = col.default
        if col.tenant:
            # Rule 3 of `tenants.py` never returns None, so a tenant column is
            # never the reason a row is dropped.
            row[col.name] = resolve_tenant(raw)
            continue
        if raw is None:
            if col.required:
                raise Malformed(f"missing:{col.name}")
            row[col.name] = None
            continue
        row[col.name] = _coerce(col, raw)
    return row
