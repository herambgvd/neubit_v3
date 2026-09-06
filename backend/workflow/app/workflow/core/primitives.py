"""The two column-default callables every workflow table uses.

Both are functions, not values: SQLAlchemy calls a default per INSERT, and a
module-level ``datetime.now()`` would freeze at import time.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone


def uuid_str() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
