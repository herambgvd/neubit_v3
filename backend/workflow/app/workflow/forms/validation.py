"""Dynamic-form data validation — pure, no session, no request.

Lives with the form definition it validates against rather than in ``core``: the
rules here are the meaning of a ``workflow_forms.fields`` row, and the only reason
it is not private to this package is that the caller is elsewhere — an incident
transition captures a form, so ``instances.service`` imports it. That edge
(instances → forms) already exists for the ``Form`` model itself; this adds no new
direction.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Iterable

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
        elif ftype == "multiselect":
            if not isinstance(value, (list, tuple)):
                errors.append(f"{label}: must be a list of options")
                continue
            opts = _option_values(field.get("options"))
            if opts:
                bad = [v for v in value if v not in opts]
                if bad:
                    errors.append(f"{label}: {bad} not valid option(s)")
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
