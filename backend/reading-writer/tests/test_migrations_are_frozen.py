"""That a migration describes a FIXED step, not whatever the code says today.

THE BUG THIS CATCHES
--------------------
`0001_reporting_baseline` used to build its tables by calling
``Point.__table__.create(bind, checkfirst=True)`` — off the LIVE
``Base.metadata``. The comment above it said this meant the baseline "can never
drift from `reporting.models`", which is true and is the problem: it cannot drift
from the models, so it drifts from ITSELF. Every column added to `Point` after
0001 was created BY 0001, and the later revision whose whole job was to add that
column then died on a fresh database:

    alembic upgrade head
    -> column "device_type" of relation "points" already exists

Three revisions (0003, 0008, 0022) were sitting behind that, and nobody saw it,
because the only database that can hit it is one that has never been migrated —
every existing deployment's `points` predates the model change.

The same defect had a second instance in SEED data. 0018/0019/0020 each looped
over `reporting.ccei_spec.definitions()`, a live module that GROWS: on a fresh
database 0018 seeded the leaf 0019 introduces, and `alembic upgrade head` died
at 0018 on `ck_metric_defs_kind` — the constraint 0019 widens to permit it.

Both are the same mistake and neither is visible in review, so they are asserted
here instead. Offline, from the source: the condition is decidable without a
database, which is what lets it run on every change rather than at deploy.
"""

from __future__ import annotations

import ast
import pathlib

import reporting.models
from reporting.ccei_spec import definitions

VERSIONS = (
    pathlib.Path(reporting.models.__file__).resolve().parent.parent
    / "migrations"
    / "versions"
)

# Revisions that seed the CCEI pack, and the attribute holding the (key, version)
# pairs each one owns. Named rather than discovered: a new seeding revision must
# be added here deliberately, which is the whole point.
CCEI_SEEDERS = ("0018_ccei_v2_spec", "0019_ccei_delta_t_occupancy", "0020_ccei_carbon_intensity")


def _module(stem: str) -> ast.Module:
    (path,) = VERSIONS.glob(f"{stem}*.py")
    return ast.parse(path.read_text())


def _literal(tree: ast.Module, name: str):
    """The value of a module-level literal assignment."""
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == name for t in node.targets
        ):
            return ast.literal_eval(node.value)
    raise AssertionError(f"{name} not found")


def _upgrade(tree: ast.Module) -> ast.FunctionDef:
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "upgrade":
            return node
    raise AssertionError("no upgrade()")


def _calls(scope: ast.AST, attr: str):
    for call in ast.walk(scope):
        if (
            isinstance(call, ast.Call)
            and isinstance(call.func, ast.Attribute)
            and call.func.attr == attr
        ):
            yield call


def _created_columns(scope: ast.AST) -> dict[str, set[str]]:
    """{table: {column, ...}} for every `op.create_table` in `scope`."""
    out: dict[str, set[str]] = {}
    for call in _calls(scope, "create_table"):
        if not call.args or not isinstance(call.args[0], ast.Constant):
            continue
        cols = {
            arg.args[0].value
            for arg in call.args[1:]
            if isinstance(arg, ast.Call)
            and isinstance(arg.func, ast.Attribute)
            and arg.func.attr == "Column"
            and arg.args
            and isinstance(arg.args[0], ast.Constant)
        }
        out.setdefault(call.args[0].value, set()).update(cols)
    return out


def _added_columns(scope: ast.AST) -> set[tuple[str, str]]:
    """{(table, column), ...} for every `op.add_column` in `scope`."""
    out: set[tuple[str, str]] = set()
    for call in _calls(scope, "add_column"):
        if len(call.args) < 2 or not isinstance(call.args[0], ast.Constant):
            continue
        col = call.args[1]
        if (
            isinstance(col, ast.Call)
            and isinstance(col.func, ast.Attribute)
            and col.func.attr == "Column"
            and col.args
            and isinstance(col.args[0], ast.Constant)
        ):
            out.add((call.args[0].value, col.args[0].value))
    return out


def test_versions_directory_was_found():
    """A wrong path would make every assertion below pass over an empty set."""
    assert VERSIONS.is_dir(), VERSIONS
    assert len(list(VERSIONS.glob("[0-9]*.py"))) >= 20


def test_no_migration_builds_ddl_from_the_live_orm():
    """`Base.metadata` and `Model.__table__` are TODAY's schema, not a revision's.

    Importing `reporting.models` inside a migration is the tell; so is any
    `.__table__` or `.metadata.create_all`. A revision needs `op.create_table`
    with the columns written out, or it is not a fixed step.
    """
    offenders: list[str] = []
    for path in sorted(VERSIONS.glob("[0-9]*.py")):
        src = path.read_text()
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == "reporting.models":
                offenders.append(f"{path.name}: imports reporting.models")
            if isinstance(node, ast.Attribute) and node.attr in {"__table__", "create_all"}:
                offenders.append(f"{path.name}: reads .{node.attr}")
    assert not offenders, (
        "migration(s) build DDL from the live ORM instead of a frozen snapshot: "
        f"{offenders}. A fresh database then gets today's columns from an old "
        f"revision and the revision that was supposed to add them fails."
    )


def test_baseline_does_not_create_a_later_revisions_column():
    """The exact failure that was shipped: 0001 creating 0003's `device_type`.

    Every column any later revision adds must be ABSENT from the baseline's
    `create_table`, or that revision's `add_column` raises DuplicateColumn on the
    only database that ever runs 0001 — a brand new one.
    """
    baseline = _created_columns(_upgrade(_module("0001")))
    assert set(baseline) == {"points", "readings"}, sorted(baseline)

    later: set[tuple[str, str]] = set()
    for path in sorted(VERSIONS.glob("[0-9]*.py")):
        if path.name.startswith("0001"):
            continue
        later |= _added_columns(_upgrade(ast.parse(path.read_text())))

    clash = sorted(
        f"{table}.{col}" for table, col in later if col in baseline.get(table, ())
    )
    assert not clash, (
        f"0001_reporting_baseline creates {clash}, which a later revision also "
        f"adds. `alembic upgrade head` on an empty database dies there."
    )


def test_baseline_covers_every_column_no_revision_adds():
    """The other direction: a column in the model that NOTHING creates.

    Subtracting the later revisions has to leave the baseline, exactly. A column
    that is neither in 0001 nor added by a later revision exists in
    `reporting.models` and in no database, and every query naming it fails.
    """
    baseline = _created_columns(_upgrade(_module("0001")))
    added: set[tuple[str, str]] = set()
    for path in sorted(VERSIONS.glob("[0-9]*.py")):
        if path.name.startswith("0001"):
            continue
        src = path.read_text()
        added |= _added_columns(_upgrade(ast.parse(src)))
        # 0024 adds its two with raw `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
        # (see the note in that file), which no `op.add_column` walk can see.
        for node in ast.walk(ast.parse(src)):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                text = node.value.upper()
                if "ADD COLUMN IF NOT EXISTS" in text:
                    tail = node.value.split()
                    added.add((tail[2], tail[tail.index("EXISTS") + 1]))

    for table in ("points", "readings"):
        modelled = set(reporting.models.Base.metadata.tables[table].columns.keys())
        accounted = baseline.get(table, set()) | {c for t, c in added if t == table}
        missing = sorted(modelled - accounted)
        assert not missing, (
            f"`{table}`.{missing} is modelled but no migration creates it. "
            f"It existed only because 0001 read the live metadata."
        )


def test_every_ccei_spec_row_is_owned_by_exactly_one_revision():
    """The seed-data half of the same bug.

    `reporting.ccei_spec.definitions()` grows as leaves become measurable. Each
    seeding revision must name the (key, version) pairs IT introduced, or it
    starts seeding a later revision's rows the next time somebody extends the
    module — which is how 0018 came to insert an `occupancy` row before 0019
    widened `ck_metric_defs_kind` to allow one.
    """
    owned: dict[tuple[str, int], str] = {}
    for stem in CCEI_SEEDERS:
        for pair in _literal(_module(stem), "_SEEDS"):
            key = (pair[0], pair[1])
            assert key not in owned, (
                f"{key} is seeded by both {owned[key]} and {stem}. Two revisions "
                f"claiming one row means one of their downgrades deletes the "
                f"other's data."
            )
            owned[key] = stem

    spec = {(d["key"], d["version"]) for d in definitions()}
    assert owned.keys() == spec, (
        f"unowned by any revision: {sorted(spec - owned.keys())}; "
        f"claimed but not in ccei_spec: {sorted(owned.keys() - spec)}. "
        f"An unowned row is one a fresh database never seeds."
    )
