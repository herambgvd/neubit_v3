"""Applying a PATCH body to a row, without letting it write a NULL into a NOT NULL.

`model_dump(exclude_unset=True)` keeps an explicit `null`, so a frontend that
PATCHes its whole form with nulls for untouched fields used to reach a NOT NULL
column and 500 on IntegrityError.

Skipping every None would be wrong: some columns (broadcasts.starts_at/ends_at)
are nullable and clearing them is legitimate. So the row's own columns decide — a
None aimed at a NOT NULL column is a 422, and a column that becomes nullable later
starts accepting a clear with no code change.

Not the same as `app/sites/mutation.py`, which refuses keys that would move a row
between tenants or parents: that is about which fields are writable, this is about
which values are.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import inspect as sa_inspect

from .errors import ValidationError


def apply_patch(row: Any, fields: dict[str, Any]) -> None:
    """Write `fields` onto `row`, refusing a NULL the column cannot hold."""
    columns = sa_inspect(type(row)).columns
    rejected = [
        name
        for name, value in fields.items()
        if value is None and name in columns and not columns[name].nullable
    ]
    if rejected:
        raise ValidationError(
            "these fields cannot be set to null: " + ", ".join(sorted(rejected)),
            code="NULL_NOT_ALLOWED",
        )
    for name, value in fields.items():
        setattr(row, name, value)
