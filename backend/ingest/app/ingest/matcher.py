"""Rule evaluation for the ingest pipeline.

Pure functions: given a payload and a list of rules, decide which one matches.
No DB, no IO.

A rule matches when **all** of its ``match_conditions`` hold. Each condition is
``{path, op, value}``; ``path`` is a JMESPath expression (typically a simple
dotted/indexed path). Supported ops (operator-friendly, no JMESPath authoring):

  - ``exists``      : path resolves to a non-null, non-empty value
  - ``not_exists``  : path resolves to null/missing/empty
  - ``equals``      : resolved value == condition.value
  - ``not_equals``  : resolved value != condition.value
  - ``contains``    : substring (for strings) or membership (for lists)

"Empty" for the exists/not_exists check means ``None``, ``""``, ``[]``, or
``{}`` — the operator's mental model of "is this filled in?".
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import jmespath
from jmespath.exceptions import JMESPathError

logger = logging.getLogger(__name__)


def _path_value(payload: Any, path: str) -> Any:
    try:
        return jmespath.search(path, payload)
    except JMESPathError:
        return None


def _is_empty(v: Any) -> bool:
    if v is None:
        return True
    if isinstance(v, (str, list, dict, tuple, set)) and len(v) == 0:
        return True
    return False


def _evaluate_condition(payload: Any, cond: dict[str, Any]) -> dict[str, Any]:
    """Return ``{ok, op, path, actual, expected}`` for one condition. The rule-test
    endpoint renders this, so the operator sees why a rule did or didn't match."""
    op = cond.get("op", "exists")
    path = cond.get("path", "")
    expected = cond.get("value")
    actual = _path_value(payload, path) if path else None

    if op == "exists":
        ok = not _is_empty(actual)
    elif op == "not_exists":
        ok = _is_empty(actual)
    elif op == "equals":
        ok = actual == expected
    elif op == "not_equals":
        ok = actual != expected
    elif op == "contains":
        if isinstance(actual, str) and isinstance(expected, str):
            ok = expected in actual
        elif isinstance(actual, (list, tuple, set)):
            ok = expected in actual
        else:
            ok = False
    else:
        ok = False

    return {
        "ok": ok,
        "op": op,
        "path": path,
        "actual": actual,
        "expected": expected,
    }


def evaluate_rule(
    payload: Any,
    conditions: list[dict[str, Any]],
) -> tuple[bool, list[dict[str, Any]]]:
    """Evaluate a single rule's conditions → ``(matched, results)``.

    ``results`` always has one entry per condition, because evaluation does not
    short-circuit — the operator sees every outcome at once. A rule with no
    conditions matches everything, which makes a useful low-priority catch-all.
    """
    if not conditions:
        return True, []
    results = [_evaluate_condition(payload, c) for c in conditions]
    matched = all(r["ok"] for r in results)
    return matched, results


def match_first(
    payload: Any,
    rules: list[Any],
) -> tuple[Optional[Any], list[dict[str, Any]]]:
    """Walk rules in order, return the first match as
    ``(rule_or_None, results_for_matched_rule_or_empty)``.

    The caller orders them (priority ASC, created_at ASC); this does not re-sort.
    Disabled rules are skipped.
    """
    for rule in rules:
        if not getattr(rule, "enabled", True):
            continue
        matched, results = evaluate_rule(payload, getattr(rule, "match_conditions", None) or [])
        if matched:
            return rule, results
    return None, []
