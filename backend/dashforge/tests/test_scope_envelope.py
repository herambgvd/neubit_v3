"""The registration envelope: what NeuBit checks about a locked scope, and what
it deliberately refuses to have an opinion about.

The line these tests hold: NeuBit validates SHAPE and never MEANING. Whether
`site_id` is lockable on DashForge dashboard 41 is a question only DashForge can
answer (it depends on that dashboard's global-filter control variables), and a
NeuBit-side guess that says "fine" where DashForge says "no" would be worse than
no check at all — it would ship a token the operator believes is per-tenant.
"""

import pytest
from pydantic import ValidationError as PydanticError

from app.embeds.schemas import (
    MAX_SCOPE_BINDINGS,
    MAX_SCOPE_VALUE_LEN,
    EmbedCreate,
    EmbedUpdate,
)


def _create(**over):
    body = {"name": "n", "workspace_ref": "1", "dashboard_ref": "2"}
    body.update(over)
    return EmbedCreate(**body)


def test_scope_defaults_to_empty_not_none():
    # An unscoped registration must be an empty MAP, not None: the service
    # passes `scope or None` to the mint call, and a None here would work by
    # accident rather than by intent.
    assert _create().scope == {}


def test_scope_values_are_coerced_to_strings():
    # DashForge's scope is map[string]string. A number typed into the form must
    # not reach the wire as a JSON number and be rejected there.
    assert _create(scope={"site": "42"}).scope == {"site": "42"}


def test_scope_name_is_trimmed():
    assert _create(scope={"  site  ": "x"}).scope == {"site": "x"}


def test_empty_scope_name_is_refused():
    # A binding with no name cannot lock anything, and accepting it would mean a
    # registration that LOOKS scoped and is not.
    with pytest.raises(PydanticError):
        _create(scope={"   ": "x"})


def test_too_many_bindings_are_refused_at_registration():
    # Mirrors DashForge's own maxScopeBindings so the refusal happens where a
    # person is looking at a form, not later as a dashboard that will not open.
    with pytest.raises(PydanticError):
        _create(scope={f"k{i}": "v" for i in range(MAX_SCOPE_BINDINGS + 1)})


def test_overlong_value_is_refused():
    with pytest.raises(PydanticError):
        _create(scope={"site": "x" * (MAX_SCOPE_VALUE_LEN + 1)})


def test_unknown_filter_names_are_NOT_refused_here():
    # The point of the whole file. NeuBit has no view of a DashForge dashboard's
    # variables, so it accepts any well-shaped name and lets DashForge refuse an
    # unlockable one at mint with a message naming it.
    assert _create(scope={"anything_at_all": "v"}).scope == {"anything_at_all": "v"}


def test_absent_scope_and_empty_scope_are_distinguishable_on_update():
    # `scope: {}` REMOVES the lock and is a real edit; an absent key means
    # "leave it alone". Conflating them would silently unscope a token on any
    # rename, which is the cross-tenant leak the lock exists to prevent.
    assert "scope" not in EmbedUpdate(name="x").model_fields_set
    cleared = EmbedUpdate(scope={})
    assert "scope" in cleared.model_fields_set
    assert cleared.scope == {}
