"""Payload validation + raw→normalized transform (pure functions, no DB / no IO).

The service layer orchestrates the DB lookup and the NATS publish; this module
owns only the data-shape transform:

* ``validate_payload``      — gate the raw body against an (optional) JSON Schema.
* ``apply_transform``       — map ``{target_field: "jmespath_expr"}`` over the payload.
* ``evaluate_lookup_expr``  — pull the device-identifying value out of the payload.

All collect errors instead of raising, so a misconfigured webhook surfaces a
clean 422 rather than a 500.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

import jmespath
from jmespath.exceptions import JMESPathError
from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError

logger = logging.getLogger(__name__)

_TARGET_PATH_RE = re.compile(r"([^.[\]]+)|\[(\d+)\]")


@dataclass
class ValidationResult:
    ok: bool
    errors: list[str] = field(default_factory=list)


#: `$ref` values that would send the validator out to the network. jsonschema 4.x
#: resolves these through `referencing`, which WILL fetch on a host with egress —
#: so a tenant who can save a webhook schema could make this service issue
#: requests of their choosing, from inside the network. It has been safe here only
#: because the test sandbox has no network, which is not a control.
_REMOTE_REF_PREFIXES = ("http://", "https://", "//", "file:", "ftp:")


def _remote_refs(node: Any, found: list[str] | None = None) -> list[str]:
    """Every `$ref` in the schema that names somewhere other than this document."""
    found = [] if found is None else found
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.lower().startswith(_REMOTE_REF_PREFIXES):
            found.append(ref)
        for value in node.values():
            _remote_refs(value, found)
    elif isinstance(node, list):
        for value in node:
            _remote_refs(value, found)
    return found


def validate_payload(payload: Any, schema: dict[str, Any] | None) -> ValidationResult:
    """Validate ``payload`` against an optional JSON Schema. An empty schema
    accepts anything; an invalid one is a webhook misconfiguration, surfaced as an
    error rather than crashing the handler.

    THE SCHEMA IS TENANT-SUPPLIED and this receiver is unauthenticated and
    internet-facing, so "surfaced rather than crashing" has to hold for every
    malformed schema, not just the one shape that was handled. It did not. The
    `except SchemaError` below used to sit on the CONSTRUCTOR, which does not
    check the schema at all — measured against jsonschema 4.26, four kinds of
    saved schema escaped this function and became a 500 with no log line:

        {"type": 123}                       TypeError at iter_errors
        {"$ref": "#/definitions/nope"}      _WrappedReferencingError
        {"$ref": "https://..."}             _WrappedReferencingError, or a FETCH
                                            on any host with egress
        {"$ref": "#"}                       RecursionError — stack blown on EVERY
                                            delivery, for as long as the webhook
                                            exists

    So: check the schema against its metaschema (which is what actually raises
    SchemaError), refuse a `$ref` that leaves the document, and treat anything
    still escaping the validation run as a bad schema rather than letting it reach
    the handler. Each one is logged, because a webhook that rejects every delivery
    with no explanation anywhere is the failure this whole path is for.
    """
    if not schema:
        return ValidationResult(True, [])

    remote = _remote_refs(schema)
    if remote:
        logger.warning("webhook schema refused: remote $ref %s", remote[:3])
        return ValidationResult(
            False,
            [f"invalid schema: $ref must stay within the document ({remote[0]!r})"],
        )

    try:
        Draft202012Validator.check_schema(schema)
        validator = Draft202012Validator(schema)
    except SchemaError as exc:
        return ValidationResult(False, [f"invalid schema: {exc.message}"])

    try:
        errors = [
            f"{'.'.join(str(p) for p in err.absolute_path) or '<root>'}: {err.message}"
            for err in sorted(validator.iter_errors(payload), key=lambda e: list(e.path))
        ]
    except RecursionError:
        # A self-referential `$ref` blows the stack. Caught by name as well as by
        # the branch below, because it is the one that is a denial of service
        # rather than a broken webhook: it costs the whole worker, every delivery.
        logger.warning("webhook schema refused: $ref recursion")
        return ValidationResult(False, ["invalid schema: $ref recursion"])
    except Exception as exc:  # noqa: BLE001 — a saved schema must not reach the handler
        logger.warning("webhook schema refused: %s: %s", type(exc).__name__, exc)
        return ValidationResult(False, [f"invalid schema: {type(exc).__name__}"])

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

    An empty map passes the raw payload through. Per-field JMESPath failures are
    collected rather than raised, so a partial transform still produces a value.
    ``cap.``-prefixed keys materialize nested objects/arrays; every other key,
    dotted or not, stays a flat literal — see ``_assign_target``.
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
    """``cap.``-prefixed key → nested object/array path; anything else → flat literal.

    Only the cap namespace is a path. Vendor payloads routinely want a flat output
    key containing a dot (``data.mac``), so treating every dotted key as nested
    would silently reshape those maps.
    """
    if not target.startswith("cap."):
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


def evaluate_lookup_expr(payload: Any, expr: str | None) -> str | None:
    """Pull the device-identifying value (e.g. a MAC) out of the raw payload.

    A bad expression is a webhook misconfiguration, not a client error, so it
    returns None and the caller carries on without device context rather than
    rejecting a delivery the vendor cannot fix.
    """
    if not expr:
        return None
    try:
        val = jmespath.search(expr, payload)
    except JMESPathError as exc:
        logger.warning("device_lookup_expr failed: %s", exc)
        return None
    if val is None:
        return None
    return str(val)
