"""The two column-default callables every workflow table uses.

Split out of the old ``shared`` module so that importing "a string uuid" does not
also drag in the enums, the trigger matcher and the form validator. Both are
plain functions (not values) because SQLAlchemy calls a default per INSERT — a
module-level ``datetime.now()`` would freeze at import time.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone


def uuid_str() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
