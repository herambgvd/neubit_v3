"""Applying a PATCH body to a row, without letting it write a NULL into a NOT NULL.

Several routers do the same three lines — `model_dump(exclude_unset=True)`, then a
loop of `setattr` — and two of them turned an ordinary request into a 500:

    PATCH /admin/billing/plans/pro   {"name": null}
    PATCH /admin/broadcasts/{id}     {"title": null}

`exclude_unset` drops fields the client did not send; an explicit `null` IS sent, so
it survived and reached a NOT NULL column. `IntegrityError` escaped the handler as an
unhandled 500 and left the session in a failed state with no rollback. That is not an
exotic payload: it is what a frontend does when it PATCHes its whole form with nulls
for the fields nobody touched.

The naive fix — skip every None — is wrong here, and this is the reason this is a
helper rather than a one-line guard copied twice. `broadcasts.starts_at` and
`ends_at` ARE nullable, and clearing a schedule window is a thing an operator
legitimately does. "None means unchanged" would silently make that impossible.

So the row's own columns decide. The database already knows which fields may be
NULL, it cannot drift from itself, and a column that becomes nullable later starts
accepting a clear with no code change. A None aimed at a NOT NULL column is refused
as a 422 — the request asked for something the schema does not allow, which is the
caller's error and should read as one.

Related but not the same: `app/sites/mutation.py` refuses keys that would MOVE a row
between tenants or parents. That is about which fields are writable at all; this is
about which values are. Kept apart deliberately — merging them would produce one
helper whose name could not describe what it does.
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
