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


# --- Error sentences the mixins raise -----------------------------------------
# These are answered to the CALLER, so each must read identically everywhere it is
# raised. "user not found" in particular is also the `assert_owned` message: a row
# belonging to another tenant has to be indistinguishable from a row that does not
# exist, or the 404-vs-403 difference becomes a cross-tenant existence oracle. The
# same reasoning makes the credential failures deliberately vague — which half of a
# key or code was wrong is not the caller's business.
USER_NOT_FOUND = "user not found"
ROLE_NOT_FOUND = "role not found"
EMAIL_TAKEN = "email already registered"
INVALID_API_KEY = "invalid API key"
INVALID_TOTP_OR_RECOVERY = "invalid authentication or recovery code"
