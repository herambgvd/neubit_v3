"""Unit tests for the pure workflow helpers in ``app.workflow.shared``.

These cover the form-data validator, the status-machine guard, and the
transition-condition context builder — all pure/synchronous so they need no DB.
"""

from __future__ import annotations

from app.workflow.shared import (
    InstanceStatus,
    build_instance_context,
    is_legal_status_change,
    matches_conditions,
    validate_form_data,
)


# ── validate_form_data ─────────────────────────────────────────────────

FIELDS = [
    {"id": "name", "label": "Name", "type": "text", "required": True,
     "validation": {"pattern": "^[A-Z]", "max_length": 20}},
    {"id": "count", "label": "Count", "type": "number", "validation": {"min": 1, "max": 10}},
    {"id": "choice", "label": "Choice", "type": "select",
     "options": [{"value": "x"}, {"value": "y"}]},
    {"id": "when", "label": "When", "type": "date"},
    {"id": "flag", "label": "Flag", "type": "boolean"},
]


def test_valid_form_passes():
    assert validate_form_data(FIELDS, {"name": "Alice"}) == []


def test_required_missing():
    assert validate_form_data(FIELDS, {}) == ["Name: required"]


def test_regex_pattern():
    errs = validate_form_data(FIELDS, {"name": "alice"})
    assert errs == ["Name: does not match required format"]


def test_number_type_and_range():
    assert "Count: must be a number" in validate_form_data(FIELDS, {"name": "A", "count": "x"})
    assert "Count: must be <= 10" in validate_form_data(FIELDS, {"name": "A", "count": 99})
    assert validate_form_data(FIELDS, {"name": "A", "count": 5}) == []


def test_select_option():
    errs = validate_form_data(FIELDS, {"name": "A", "choice": "z"})
    assert errs == ["Choice: 'z' is not a valid option"]
    assert validate_form_data(FIELDS, {"name": "A", "choice": "x"}) == []


def test_date_type():
    assert validate_form_data(FIELDS, {"name": "A", "when": "nope"}) == ["When: must be a valid date"]
    assert validate_form_data(FIELDS, {"name": "A", "when": "2026-07-08"}) == []


def test_boolean_accepts_stringy():
    assert validate_form_data(FIELDS, {"name": "A", "flag": "true"}) == []
    assert validate_form_data(FIELDS, {"name": "A", "flag": False}) == []


def test_empty_fields_or_data():
    assert validate_form_data(None, None) == []
    assert validate_form_data([], {"anything": 1}) == []


# ── status machine ─────────────────────────────────────────────────────

S = InstanceStatus


def test_legal_status_edges():
    assert is_legal_status_change(S.PENDING, S.ACTIVE)
    assert is_legal_status_change(S.ACTIVE, S.PAUSED)
    assert is_legal_status_change(S.PAUSED, S.ACTIVE)
    assert is_legal_status_change(S.ACTIVE, S.RESOLVED)
    assert is_legal_status_change(S.ACTIVE, S.CANCELLED)


def test_illegal_status_edges():
    assert not is_legal_status_change(S.RESOLVED, S.ACTIVE)
    assert not is_legal_status_change(S.CANCELLED, S.ACTIVE)
    assert not is_legal_status_change(S.PENDING, S.PAUSED)
    assert not is_legal_status_change(S.PENDING, S.RESOLVED)


def test_status_noop_always_legal():
    for s in S:
        assert is_legal_status_change(s, s)


# ── condition context ──────────────────────────────────────────────────


class _Inst:
    instance_id = "i1"
    sop_id = "s1"
    priority = "high"
    status = "active"
    site_id = "site1"
    current_state = "st"
    current_state_name = "Open"
    event_type = "fire.alarm"
    event_id = "e1"
    assigned_to = None
    tags = ["vip"]
    trigger_data = {"payload": {"zone": 3}}
    extra = {}


def test_condition_context_and_matching():
    ctx = build_instance_context(_Inst())
    assert matches_conditions(ctx, [{"field": "priority", "operator": "eq", "value": "high"}])
    assert matches_conditions(
        ctx, [{"field": "trigger_data.payload.zone", "operator": "gte", "value": 2}]
    )
    assert matches_conditions(
        ctx, [{"field": "envelope.payload.zone", "operator": "eq", "value": 3}]
    )
    assert not matches_conditions(ctx, [{"field": "priority", "operator": "eq", "value": "low"}])
    assert matches_conditions(ctx, [])  # empty always matches
