"""Constants and datetime helpers shared by the AuthService mixins.

Defined once so the mixins cannot drift. `_aware` exists because SQLite returns
naive datetimes and Postgres aware ones, so a drifted copy would fail only in
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
