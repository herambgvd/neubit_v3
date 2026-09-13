"""Trigger-condition evaluation — the matcher, and the context it matches against.

The operator set is part of the stored trigger contract: changing or renaming one
silently changes which incidents fire. The frontend mirrors it in
``frontend/src/features/workflow/lib/matcher.ts``; the two must agree.

Two callers: the correlation engine matches trigger conditions against an event
envelope, and the instance service matches transition conditions against a running
incident via ``build_instance_context``.
"""

from __future__ import annotations

import re
from typing import Any, Iterable


# ── Trigger-condition matcher ─────────────────────────────────────────


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


def _contains(actual: Any, expected: Any) -> bool:
    """Substring for a string, membership for a collection, False for anything else."""
    if isinstance(actual, str):
        return isinstance(expected, str) and expected in actual
    if isinstance(actual, (list, tuple, set)):
        return expected in actual
    return False


def _regex(actual: Any, expected: Any) -> bool:
    """A pattern an operator typed is data, not code: a bad one never matches."""
    try:
        return isinstance(actual, str) and re.search(str(expected), actual) is not None
    except re.error:
        return False


# The operators a condition may use. A table rather than a chain so the set a
# trigger can be written against is one readable list.
_OPERATORS = {
    "eq": lambda a, e: a == e,
    "ne": lambda a, e: a != e,
    "gt": lambda a, e: a is not None and a > e,
    "gte": lambda a, e: a is not None and a >= e,
    "lt": lambda a, e: a is not None and a < e,
    "lte": lambda a, e: a is not None and a <= e,
    "in": lambda a, e: isinstance(e, (list, tuple, set)) and a in e,
    "not_in": lambda a, e: isinstance(e, (list, tuple, set)) and a not in e,
    "contains": _contains,
    "starts_with": lambda a, e: isinstance(a, str) and isinstance(e, str) and a.startswith(e),
    "ends_with": lambda a, e: isinstance(a, str) and isinstance(e, str) and a.endswith(e),
    "regex": _regex,
    "exists": lambda a, e: (a is not None) == bool(e),
}


def _match_one(actual: Any, op: str, expected: Any) -> bool:
    """One condition. An operator nobody implements matches nothing, and two
    values that cannot be compared do not match either — neither is an error a
    trigger should raise at event time."""
    fn = _OPERATORS.get(op)
    if fn is None:
        return False
    try:
        return fn(actual, expected)
    except TypeError:
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
        # Alias: some conditions use "envelope" as the root.
        "envelope": trigger_data,
        "metadata": extra,
    }

