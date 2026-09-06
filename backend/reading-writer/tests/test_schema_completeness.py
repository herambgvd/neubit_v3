"""That every table Alembic creates in `neubit_reporting` has an ORM model.

THE BUG THIS CATCHES
--------------------
`Base.metadata` is not documentation here. Two things read it and both are silent
when it is wrong:

  * `alembic revision --autogenerate` diffs the database against it, so a table
    with no model is a table autogenerate proposes to DROP. Eight of them had
    accumulated — including two hypertables of live telemetry — and the next
    person to autogenerate a revision would have got a `DROP TABLE` per orphan in
    a file that looks routine.
  * `kernel.lifecycle.erase_tenant_data` walks it, so a table with no model is a
    table a DPDP right-to-erase never touches. Three of the eight carried
    `tenant_id`.

Neither failure raises anything. Both look like success.

WHY IT READS THE MIGRATIONS RATHER THAN THE DATABASE
-----------------------------------------------------
So it can run with no database, in the offline suite, on every change — the
condition that matters is "a migration creates a table nothing models", and that
is decidable from the source. `alembic check` against a live database is the
stronger test and stays the one that runs at deploy; this is the one that fails
in review, before the revision is merged.

The projection relations are deliberately absent from both sides: no migration
creates them and no model declares them, so they never enter this comparison.
"""

from __future__ import annotations

import ast
import pathlib
import re

import reporting.models  # noqa: F401 — registers every model on Base.metadata
from reporting.db import Base

VERSIONS = pathlib.Path(reporting.models.__file__).resolve().parent.parent / "migrations" / "versions"


def _upgrade_table_ops(tree: ast.AST) -> tuple[set[str], set[str]]:
    """(tables created, tables dropped) inside the module's `upgrade()`.

    Scoped to `upgrade` on purpose: every `downgrade` drops what its own upgrade
    made, and counting those would cancel out every table in the store.
    """
    created: set[str] = set()
    dropped: set[str] = set()
    for node in ast.walk(tree):
        if not (isinstance(node, ast.FunctionDef) and node.name == "upgrade"):
            continue
        for call in ast.walk(node):
            if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Attribute):
                continue
            if not call.args or not isinstance(call.args[0], ast.Constant):
                continue
            name = call.args[0].value
            if not isinstance(name, str):
                continue
            if call.func.attr == "create_table":
                created.add(name)
            elif call.func.attr == "drop_table":
                dropped.add(name)
    return created, dropped


def _migrated_tables() -> set[str]:
    created: set[str] = set()
    dropped: set[str] = set()
    for path in sorted(VERSIONS.glob("[0-9]*.py")):
        made, gone = _upgrade_table_ops(ast.parse(path.read_text()))
        created |= made
        dropped |= gone
    return created - dropped


def test_migrations_directory_was_found():
    """A wrong path would make every assertion below pass over an empty set."""
    assert VERSIONS.is_dir(), VERSIONS
    assert len(list(VERSIONS.glob("[0-9]*.py"))) >= 20


def test_every_migrated_table_has_a_model():
    missing = sorted(_migrated_tables() - set(Base.metadata.tables))
    assert not missing, (
        f"{len(missing)} table(s) are created by a migration and modelled nowhere: "
        f"{missing}. autogenerate will propose DROP TABLE for each, and a tenant "
        f"offboard will not erase any of them. Add a model in reporting/models.py."
    )


def _words_in_migration_strings() -> set[str]:
    """Every identifier-shaped word appearing in any string literal in any migration.

    Coarse on purpose. `points` and `readings` are created by 0001 through
    ``Table.create(bind)`` off the live model metadata, and the rest through raw
    ``CREATE ... create_hypertable('readings', ...)`` SQL, so there is no single
    call shape to match on. The question this answers is only "does any migration
    mention this table at all", which is enough to catch the bug it is for: a
    model added with no migration behind it.
    """
    words: set[str] = set()
    for path in sorted(VERSIONS.glob("[0-9]*.py")):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                words |= set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", node.value))
    return words


def test_every_model_is_actually_migrated():
    """The other direction: a model for a table no migration creates is a model
    for a table that does not exist, and every query against it fails at runtime.

    `alembic check` against a live database is the exact form of this and runs at
    deploy; this one runs with no database and names the table in review.
    """
    mentioned = _words_in_migration_strings()
    extra = sorted(t for t in Base.metadata.tables if t not in mentioned)
    assert not extra, (
        f"modelled but named by no migration: {extra}. Nothing will create these, "
        f"so every query against them fails at runtime."
    )
