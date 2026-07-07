"""Shared workflow constants, enums, and the trigger-condition matcher.

Single source of truth for the literal types + the condition-evaluation logic used
by both the CRUD services and the correlation engine. The matcher is ported
verbatim from neubit_v2's ``module/correlation/matcher.py`` — the operator set is
part of the trigger contract and must not drift.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Iterable


def uuid_str() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ── Enums (kept faithful to neubit_v2) ─────────────────────────────────


class InstancePriority(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


# neubit_v2 uses PENDING/ACTIVE/PAUSED/COMPLETED/CANCELLED. The v3 task spec calls
# for pending|active|paused|resolved|cancelled — RESOLVED replaces COMPLETED.
class InstanceStatus(str, Enum):
    PENDING = "pending"
    ACTIVE = "active"
    PAUSED = "paused"
    RESOLVED = "resolved"
    CANCELLED = "cancelled"


# The terminal / closed statuses (no further mutation allowed).
CLOSED_STATUSES = {InstanceStatus.RESOLVED, InstanceStatus.CANCELLED}


class ThreatLevelValue(str, Enum):
    NORMAL = "normal"
    ELEVATED = "elevated"
    HIGH = "high"
    CRITICAL = "critical"
    LOCKDOWN = "lockdown"


class FieldType(str, Enum):
    TEXT = "text"
    TEXTAREA = "textarea"
    NUMBER = "number"
    EMAIL = "email"
    PHONE = "phone"
    DATE = "date"
    DATETIME = "datetime"
    SELECT = "select"
    RADIO = "radio"
    CHECKBOX = "checkbox"
    BOOLEAN = "boolean"
    FILE = "file"
    RATING = "rating"


# Priority ordering for escalation bumps (low → critical).
PRIORITY_ORDER = [
    InstancePriority.LOW,
    InstancePriority.MEDIUM,
    InstancePriority.HIGH,
    InstancePriority.CRITICAL,
]


def bump_priority(current: InstancePriority, target: InstancePriority) -> InstancePriority:
    """Return the higher of two priorities (never de-escalates)."""
    if PRIORITY_ORDER.index(target) > PRIORITY_ORDER.index(current):
        return target
    return current


# ── Trigger-condition matcher (ported from v2 matcher.py) ──────────────


def walk(obj: dict[str, Any], path: str) -> Any:
    """Dotted-path lookup into a (possibly nested) dict. Missing → None."""
    cur: Any = obj
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
        if cur is None:
            return None
    return cur


def _match_one(actual: Any, op: str, expected: Any) -> bool:
    try:
        if op == "eq":
            return actual == expected
        if op == "ne":
            return actual != expected
        if op == "gt":
            return actual is not None and actual > expected
        if op == "gte":
            return actual is not None and actual >= expected
        if op == "lt":
            return actual is not None and actual < expected
        if op == "lte":
            return actual is not None and actual <= expected
        if op == "in":
            return isinstance(expected, (list, tuple, set)) and actual in expected
        if op == "not_in":
            return isinstance(expected, (list, tuple, set)) and actual not in expected
        if op == "contains":
            if isinstance(actual, str):
                return isinstance(expected, str) and expected in actual
            if isinstance(actual, (list, tuple, set)):
                return expected in actual
            return False
        if op == "starts_with":
            return isinstance(actual, str) and isinstance(expected, str) and actual.startswith(expected)
        if op == "ends_with":
            return isinstance(actual, str) and isinstance(expected, str) and actual.endswith(expected)
        if op == "regex":
            try:
                return isinstance(actual, str) and re.search(str(expected), actual) is not None
            except re.error:
                return False
        if op == "exists":
            return (actual is not None) == bool(expected)
    except TypeError:
        return False
    return False


def matches_conditions(envelope: dict[str, Any], conditions: Iterable[dict[str, Any]]) -> bool:
    """A trigger matches an event iff **every** condition is satisfied.

    Each condition is a ``{"field", "operator", "value"}`` dict; ``field`` uses a
    dotted path into the event envelope (e.g. ``payload.camera_id``). An empty
    condition list matches everything.
    """
    for cond in conditions or []:
        field = cond.get("field")
        op = cond.get("operator", "eq")
        expected = cond.get("value")
        if not field:
            continue
        if not _match_one(walk(envelope, field), op, expected):
            return False
    return True
