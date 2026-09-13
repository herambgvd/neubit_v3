"""Dynamic-form data validation — pure, no session, no request.

Lives with the form definition rather than in ``core``: these rules are the meaning
of a ``workflow_forms.fields`` row. ``instances.service`` imports it, an edge that
already exists for the ``Form`` model.
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


def _number_type_errors(label: str, value: Any, validation: dict) -> dict:
    """A number, and the bounds the field definition puts on it."""
    if not _is_number(value):
        return {"errors": [f"{label}: must be a number"], "well_typed": False}
    num = float(value)
    errors: list[str] = []
    if "min" in validation and num < validation["min"]:
        errors.append(f"{label}: must be >= {validation['min']}")
    if "max" in validation and num > validation["max"]:
        errors.append(f"{label}: must be <= {validation['max']}")
    return {"errors": errors, "well_typed": True}


def _boolean_type_errors(label: str, value: Any) -> dict:
    """A value a checkbox can mean, in any of the JSON shapes clients send."""
    if value in _TRUE_VALUES or value in _FALSE_VALUES:
        return {"errors": [], "well_typed": True}
    return {"errors": [f"{label}: must be a boolean"], "well_typed": True}


def _date_type_errors(label: str, value: Any) -> dict:
    """A date the form can read back."""
    if _is_date(value):
        return {"errors": [], "well_typed": True}
    return {"errors": [f"{label}: must be a valid date"], "well_typed": True}


def _choice_type_errors(label: str, value: Any, options: Any) -> dict:
    """A single-choice value against the options the field offers.

    A field with no options constrains nothing — it is a free choice, not a
    closed one, and rejecting every value there would be the wrong reading.
    """
    opts = _option_values(options)
    if opts and value not in opts:
        return {"errors": [f"{label}: '{value}' is not a valid option"],
                "well_typed": True}
    return {"errors": [], "well_typed": True}


def _multiselect_type_errors(label: str, value: Any, options: Any) -> dict:
    """Every chosen value against the options the field offers, naming the strays."""
    if not isinstance(value, (list, tuple)):
        return {"errors": [f"{label}: must be a list of options"],
                "well_typed": False}
    opts = _option_values(options)
    bad = [v for v in value if v not in opts] if opts else []
    if bad:
        return {"errors": [f"{label}: {bad} not valid option(s)"], "well_typed": True}
    return {"errors": [], "well_typed": True}


def _field_type_errors(
    label: str, ftype: str, value: Any, validation: dict, options: Any
) -> dict:
    """What the field's declared type says about the value.

    Carries ``well_typed`` as well as the errors: a value that is not even the
    shape its type declares gets one error, not two, so the string checks that
    follow do not pile "must be at least 3 characters" onto "must be a number".
    """
    if ftype in ("number", "rating"):
        return _number_type_errors(label, value, validation)
    if ftype in ("boolean", "checkbox"):
        return _boolean_type_errors(label, value)
    if ftype in ("select", "radio"):
        return _choice_type_errors(label, value, options)
    if ftype == "multiselect":
        return _multiselect_type_errors(label, value, options)
    if ftype in ("date", "datetime"):
        return _date_type_errors(label, value)
    # text/textarea/email/phone/file — must be a string.
    if not isinstance(value, str):
        return {"errors": [f"{label}: must be text"], "well_typed": False}
    return {"errors": [], "well_typed": True}


def _string_errors(label: str, value: str, validation: dict) -> list[str]:
    """Length and regex — the checks that are only meaningful on a string."""
    errors: list[str] = []
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
            # A broken pattern in the form definition must not 500.
            pass
    return errors


def _field_errors(field: dict[str, Any], data: dict[str, Any]) -> list[str]:
    """What is wrong with this field's submitted value, in the field's own words."""
    fid = field.get("id") or field.get("label")
    if fid is None:
        return []
    fid = str(fid)
    label = field.get("label") or fid
    ftype = str(field.get("type") or "text").lower()
    validation = field.get("validation") or {}
    required = bool(field.get("required")) or bool(validation.get("required"))

    present = fid in data and data[fid] not in (None, "", [])
    if not present:
        return [f"{label}: required"] if required else []

    value = data[fid]
    typed = _field_type_errors(label, ftype, value, validation, field.get("options"))
    errors = list(typed["errors"])
    if typed["well_typed"] and isinstance(value, str):
        errors.extend(_string_errors(label, value, validation))
    return errors


def validate_form_data(
    fields: Iterable[dict[str, Any]] | None, data: dict[str, Any] | None
) -> list[str]:
    """Validate submitted ``data`` against a form's ``fields`` definition.

    Returns per-field error strings; empty means valid. ``fields`` entries are
    ``{id, label, type, required, options, validation}``, where ``validation`` may
    carry ``pattern`` (regex), ``min``/``max`` (numbers) or ``min_length`` /
    ``max_length`` (strings). Unknown field types are treated as free text.
    """
    data = data or {}
    errors: list[str] = []
    for field in fields or []:
        errors.extend(_field_errors(field, data))
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
