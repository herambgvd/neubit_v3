"""An explicit `null` in a PATCH body must not become a 500.

`model_dump(exclude_unset=True)` drops what the client did not send, but an explicit
`null` is sent, so it survives the filter and reaches a NOT NULL column as an
unhandled IntegrityError. This is what a frontend does when it PATCHes its whole
form with nulls for the fields nobody touched, so `apply_patch` refuses per column
instead. Routers that guard each field with `if x is not None` are already safe.
"""

from __future__ import annotations

import pytest

from app.core.errors import ValidationError
from app.core.patching import apply_patch

pytestmark = pytest.mark.asyncio


def test_a_null_is_refused_for_a_not_null_column():
    from app.billing.models import Plan

    plan = Plan(key="pro", name="Pro", price_cents=100, currency="usd", interval="month")
    with pytest.raises(ValidationError) as caught:
        apply_patch(plan, {"name": None})
    assert "name" in str(caught.value)
    assert plan.name == "Pro", "the row was mutated before the refusal"


def test_a_null_is_ALLOWED_for_a_nullable_column():
    """Why this is a helper and not "skip every None": `starts_at` and `ends_at` are
    nullable, and clearing a broadcast's schedule window is legitimate. A blanket
    skip would silently make it impossible."""
    from app.broadcasts.models import Broadcast

    b = Broadcast(title="t", body="b", severity="info", target_type="all")
    b.starts_at = "not-none"
    apply_patch(b, {"starts_at": None})
    assert b.starts_at is None


def test_the_refusal_names_every_offending_field_at_once():
    """One round trip names everything wrong, not one 422 per field."""
    from app.billing.models import Plan

    plan = Plan(key="pro", name="Pro", price_cents=100, currency="usd", interval="month")
    with pytest.raises(ValidationError) as caught:
        apply_patch(plan, {"name": None, "currency": None})
    message = str(caught.value)
    assert "name" in message and "currency" in message


def test_ordinary_values_still_land():
    from app.billing.models import Plan

    plan = Plan(key="pro", name="Pro", price_cents=100, currency="usd", interval="month")
    apply_patch(plan, {"name": "Pro Plus", "price_cents": 250})
    assert plan.name == "Pro Plus"
    assert plan.price_cents == 250


def test_an_unknown_key_is_written_like_any_other():
    """The helper is about nullability, not about which fields are writable — that
    is app/sites/mutation.py's job. Do not merge the two."""
    from app.billing.models import Plan

    plan = Plan(key="pro", name="Pro", price_cents=100, currency="usd", interval="month")
    apply_patch(plan, {"sort_order": 5})
    assert plan.sort_order == 5


def test_both_routers_go_through_the_helper():
    """Both routers had the same three lines, so both have to keep using the helper."""
    import pathlib

    app_dir = pathlib.Path(__file__).resolve().parents[1] / "app"
    for name in ("billing/router.py", "broadcasts/router.py"):
        src = (app_dir / name).read_text()
        assert "apply_patch(" in src, name
        # And neither still runs the raw setattr loop. (Comments are exempt: they
        # quote the old code to explain it.)
        code = [ln for ln in src.splitlines() if not ln.lstrip().startswith("#")]
        assert not any("setattr(" in ln for ln in code), name
