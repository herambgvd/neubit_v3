"""Constants and datetime helpers shared by the AuthService mixins.

One definition, not five. The split copied the module header into every mixin,
which duplicated `RESET_TTL`, `ADMIN_ROLE_NAME` and the two datetime coercions —
and a constant defined five times is a constant that will eventually differ in one
of them, silently. `_aware` in particular exists because SQLite returns naive
datetimes and Postgres returns aware ones, so a copy that drifts would fail only in
tests or only in production.
"""

from __future__ import annotations

import datetime as dt

RESET_TTL = dt.timedelta(hours=1)

ADMIN_ROLE_NAME = "Administrator"


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _aware(value: dt.datetime) -> dt.datetime:
    """Coerce a DB datetime to UTC-aware (SQLite returns naive; Postgres aware)."""
    return value if value.tzinfo is not None else value.replace(tzinfo=dt.timezone.utc)
