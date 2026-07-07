"""Payload validation + raw→normalized transform (pure functions, no DB / no IO).

Ported from neubit_v2's ingest ``transformer``. The service layer orchestrates the
DB lookup and the NATS publish; this module only owns the data-shape transform:

* ``validate_payload`` — gate the raw body against an (optional) JSON Schema.
* ``apply_transform``  — map ``{target_field: "jmespath_expr"}`` over the payload.

Both collect errors instead of raising, so a misconfigured webhook surfaces a
clean 422 rather than a 500.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import jmespath
from jmespath.exceptions import JMESPathError
from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError

_TARGET_PATH_RE = re.compile(r"([^.[\]]+)|\[(\d+)\]")


@dataclass
class ValidationResult:
    ok: bool
    errors: list[str] = field(default_factory=list)


def validate_payload(payload: Any, schema: dict[str, Any] | None) -> ValidationResult:
    """Validate ``payload`` against an optional JSON Schema.

    Empty/absent schema ({}) accepts anything. An invalid schema is treated as a
    webhook misconfiguration — surfaced as an error, never crashes the handler.
    """
    if not schema:
        return ValidationResult(True, [])
    try:
        validator = Draft202012Validator(schema)
    except SchemaError as exc:
        return ValidationResult(False, [f"invalid schema: {exc.message}"])

    errors = [
        f"{'.'.join(str(p) for p in err.absolute_path) or '<root>'}: {err.message}"
        for err in sorted(validator.iter_errors(payload), key=lambda e: list(e.path))
    ]
    return ValidationResult(not errors, errors)


@dataclass
class TransformResult:
    ok: bool
    value: dict[str, Any] | None = None
    errors: list[str] = field(default_factory=list)


def apply_transform(
    payload: Any, transform_map: dict[str, str] | None
) -> TransformResult:
    """Apply ``{target_field: "jmespath_expr"}`` against ``payload``.

    Empty map → return the raw payload as-is (passthrough). Per-field JMESPath
    failures are collected, not raised — a partial transform still produces a
    value. Dotted target keys (e.g. ``event.description``) materialize nested
    objects so the output shape is configurable directly.
    """
    if not transform_map:
        if not isinstance(payload, dict):
            return TransformResult(
                False, None, ["empty transform but payload is not an object"]
            )
        return TransformResult(True, dict(payload), [])

    out: dict[str, Any] = {}
    errors: list[str] = []
    for target_field, expr in transform_map.items():
        try:
            value = jmespath.search(expr, payload)
            _assign_target(out, target_field, value)
        except JMESPathError as exc:
            errors.append(f"{target_field}: {exc}")
            _assign_target(out, target_field, None)
        except ValueError as exc:
            errors.append(f"{target_field}: {exc}")
            out[target_field] = None
    return TransformResult(not errors, out, errors)


def _assign_target(out: dict[str, Any], target: str, value: Any) -> None:
    """Flat key → literal; dotted key → nested object/array path."""
    if "." not in target and "[" not in target:
        out[target] = value
        return
    _assign_nested(out, target, value)


def _assign_nested(root: dict[str, Any], path: str, value: Any) -> None:
    tokens: list[str | int] = []
    for key, idx in _TARGET_PATH_RE.findall(path):
        tokens.append(key if key else int(idx))
    if not tokens:
        raise ValueError("invalid target path")

    cur: Any = root
    for i, token in enumerate(tokens):
        is_last = i == len(tokens) - 1
        next_token = None if is_last else tokens[i + 1]

        if isinstance(token, int):
            if not isinstance(cur, list):
                raise ValueError("array index used on non-array container")
            while len(cur) <= token:
                cur.append(None)
            if is_last:
                cur[token] = value
                return
            want_list = isinstance(next_token, int)
            if not isinstance(cur[token], list if want_list else dict):
                cur[token] = [] if want_list else {}
            cur = cur[token]
            continue

        if not isinstance(cur, dict):
            raise ValueError("object key used on non-object container")
        if is_last:
            cur[token] = value
            return
        want_list = isinstance(next_token, int)
        existing = cur.get(token)
        if not isinstance(existing, list if want_list else dict):
            cur[token] = [] if want_list else {}
        cur = cur[token]
