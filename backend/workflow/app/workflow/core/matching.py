"""Trigger-condition evaluation — the matcher, and the context it matches against.

PORTED VERBATIM from neubit_v2's ``module/correlation/matcher.py``. The operator
set below is part of the trigger contract: a trigger row stored last year carries
``{"field": ..., "operator": ..., "value": ...}`` and expects exactly these
semantics, so adding, renaming or "improving" an operator silently changes which
incidents fire. The frontend keeps its own mirror of this operator set
(``frontend/src/features/workflow/lib/matcher.ts``); the two must agree.

Two callers, one implementation:
  * the correlation engine matches a trigger's conditions against an incoming
    event ENVELOPE;
  * the instance service matches a transition's conditions against a running
    incident, via ``build_instance_context``.
"""

from __future__ import annotations

import re
from typing import Any, Iterable


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

