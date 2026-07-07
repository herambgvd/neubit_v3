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


# Legal manual status-machine edges (used by InstanceService.change_status).
# PENDING → ACTIVE/CANCELLED; ACTIVE ↔ PAUSED; ACTIVE/PAUSED → RESOLVED/CANCELLED;
# terminal states (RESOLVED/CANCELLED) can't change. A no-op (X → X) is always
# allowed. transition()/escalate() drive status via their own machine and are not
# gated by this map.
LEGAL_STATUS_EDGES: dict[InstanceStatus, set[InstanceStatus]] = {
    InstanceStatus.PENDING: {InstanceStatus.ACTIVE, InstanceStatus.CANCELLED},
    InstanceStatus.ACTIVE: {
        InstanceStatus.PAUSED,
        InstanceStatus.RESOLVED,
        InstanceStatus.CANCELLED,
    },
    InstanceStatus.PAUSED: {
        InstanceStatus.ACTIVE,
        InstanceStatus.RESOLVED,
        InstanceStatus.CANCELLED,
    },
    InstanceStatus.RESOLVED: set(),
    InstanceStatus.CANCELLED: set(),
}


def is_legal_status_change(current: InstanceStatus, target: InstanceStatus) -> bool:
    """True iff moving current → target is a legal manual status change.

    A no-op (same status) is always legal; otherwise the edge must be in
    ``LEGAL_STATUS_EDGES``. Terminal states have no outgoing edges.
    """
    if current == target:
        return True
    return target in LEGAL_STATUS_EDGES.get(current, set())


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


# ── Instance context (for transition-condition evaluation) ─────────────


def build_instance_context(inst: Any) -> dict[str, Any]:
    """Assemble the context dict a transition's ``conditions`` are matched against.

    Fields are flattened so a condition can address them either at the top level
    (e.g. ``field: "priority"``) or via the originating event (``field:
    "trigger_data.payload.camera_id"``). ``inst`` is a ``WorkflowInstance`` row.
    """
    trigger_data = getattr(inst, "trigger_data", None) or {}
    extra = getattr(inst, "extra", None) or {}
    return {
        "instance_id": getattr(inst, "instance_id", None),
        "sop_id": getattr(inst, "sop_id", None),
        "priority": getattr(inst, "priority", None),
        "status": getattr(inst, "status", None),
        "site_id": getattr(inst, "site_id", None),
        "current_state": getattr(inst, "current_state", None),
        "current_state_name": getattr(inst, "current_state_name", None),
        "event_type": getattr(inst, "event_type", None),
        "event_id": getattr(inst, "event_id", None),
        "assigned_to": getattr(inst, "assigned_to", None),
        "tags": getattr(inst, "tags", None) or [],
        # The whole originating envelope, addressable via dotted paths.
        "trigger_data": trigger_data,
        # v2 alias — some triggers/conditions use "envelope" as the root.
        "envelope": trigger_data,
        "metadata": extra,
    }


# ── Dynamic-form validation (pure helper) ──────────────────────────────

# JSON-friendly booleans accepted for boolean/checkbox fields.
_TRUE_VALUES = {True, "true", "True", "1", 1, "yes", "on"}
_FALSE_VALUES = {False, "false", "False", "0", 0, "no", "off", ""}


def _is_number(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    if isinstance(v, (int, float)):
        return True
    if isinstance(v, str):
        try:
            float(v)
            return True
        except ValueError:
            return False
    return False


def _is_date(v: Any) -> bool:
    if not isinstance(v, str) or not v.strip():
        return False
    raw = v.strip().replace("Z", "+00:00")
    try:
        datetime.fromisoformat(raw)
        return True
    except ValueError:
        # Accept bare dates like "2026-07-08".
        try:
            datetime.strptime(v.strip()[:10], "%Y-%m-%d")
            return True
        except ValueError:
            return False


def validate_form_data(
    fields: Iterable[dict[str, Any]] | None, data: dict[str, Any] | None
) -> list[str]:
    """Validate submitted ``data`` against a form's ``fields`` definition.

    Returns a list of per-field error strings (empty == valid). Pure + synchronous
    so it can be unit-tested and reused. ``fields`` entries look like
    ``{id, label, type, required, options, validation}`` where ``validation`` may
    carry a ``pattern`` (regex), ``min``/``max`` (numbers), or ``min_length`` /
    ``max_length`` (strings). Unknown field types are treated as free text.
    """
    errors: list[str] = []
    data = data or {}
    for field in fields or []:
        fid = field.get("id") or field.get("label")
        if fid is None:
            continue
        fid = str(fid)
        label = field.get("label") or fid
        ftype = str(field.get("type") or "text").lower()
        required = bool(field.get("required")) or bool(
            (field.get("validation") or {}).get("required")
        )
        present = fid in data and data[fid] not in (None, "", [])
        if not present:
            if required:
                errors.append(f"{label}: required")
            continue

        value = data[fid]
        validation = field.get("validation") or {}

        # -- type checks --
        if ftype in ("number", "rating"):
            if not _is_number(value):
                errors.append(f"{label}: must be a number")
                continue
            num = float(value)
            if "min" in validation and num < validation["min"]:
                errors.append(f"{label}: must be >= {validation['min']}")
            if "max" in validation and num > validation["max"]:
                errors.append(f"{label}: must be <= {validation['max']}")
        elif ftype in ("boolean", "checkbox"):
            if value not in _TRUE_VALUES and value not in _FALSE_VALUES:
                errors.append(f"{label}: must be a boolean")
        elif ftype in ("select", "radio"):
            opts = _option_values(field.get("options"))
            if opts and value not in opts:
                errors.append(f"{label}: '{value}' is not a valid option")
        elif ftype in ("date", "datetime"):
            if not _is_date(value):
                errors.append(f"{label}: must be a valid date")
        else:
            # text/textarea/email/phone/file — must be a string.
            if not isinstance(value, str):
                errors.append(f"{label}: must be text")
                continue

        # -- string length + regex (only meaningful on strings) --
        if isinstance(value, str):
            min_len = validation.get("min_length")
            max_len = validation.get("max_length")
            if isinstance(min_len, int) and len(value) < min_len:
                errors.append(f"{label}: must be at least {min_len} characters")
            if isinstance(max_len, int) and len(value) > max_len:
                errors.append(f"{label}: must be at most {max_len} characters")
            pattern = validation.get("pattern") or validation.get("regex")
            if pattern:
                try:
                    if re.search(str(pattern), value) is None:
                        errors.append(f"{label}: does not match required format")
                except re.error:
                    # A broken pattern in the form definition shouldn't 500.
                    pass
    return errors


def _option_values(options: Any) -> list[Any]:
    """Extract the allowed values from a form field's ``options`` list.

    Options may be plain scalars or ``{value, label}`` dicts.
    """
    out: list[Any] = []
    for opt in options or []:
        if isinstance(opt, dict):
            out.append(opt.get("value", opt.get("label")))
        else:
            out.append(opt)
    return out
