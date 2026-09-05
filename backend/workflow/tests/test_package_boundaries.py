"""The import direction the package docstrings assert, checked against the graph.

``core/__init__.py`` says it "is the LEAF of the internal dependency graph … imports
nothing from a feature package and nothing from ``app.db``". ``runtime/__init__.py``
says it holds nothing that "knows a table, a schema or a route".
``app/workflow/__init__.py`` says "``core`` ← features ← ``instances`` ←
``correlation``. Nothing in ``sops``, ``forms`` or ``notifications`` may import
``instances``."

All three were true when they were written and nothing checked them. A documented
rule with no guard is a rule that gets broken by a one-line import in a hurry, and
nobody finds out until the cycle bites — a "shared" bucket growing back into the
flat module the feature split replaced is exactly the shape this repo has been
bitten by. This is the guard.

WHY THE AST AND NOT ``importlib``. Importing the packages to inspect
``sys.modules`` would need a live ``app.db`` (which needs a database URL), would
miss deferred imports entirely, and would report the transitive closure rather
than the edge that was actually written. Parsing the source names the offending
FILE and the offending LINE, which is what the person who has to fix it needs.

WHY DEFERRED IMPORTS ARE STILL EDGES. A function-local import breaks an import
CYCLE but it does not undo a dependency: the module still cannot work without the
one it reaches into. So they are checked the same way, with one difference — a
back-edge that is deliberately deferred may be listed in
:data:`DEFERRED_BACK_EDGES` with the reason, and :func:`test_deferred_back_edges_
are_real` fails if a listed one stops existing or stops being deferred. A lazy
import is therefore never a way around this file; it is a way to write down why.

TO ADD A FEATURE PACKAGE: one line in :data:`MAY_IMPORT` and, if it owns tables,
one entry in :data:`MAY_IMPORT_APP_DB`. There is no test logic to edit.
"""

from __future__ import annotations

import ast
import pathlib

WORKFLOW = pathlib.Path(__file__).resolve().parents[1] / "app" / "workflow"

# The three modules that sit at ``app/workflow/`` itself rather than in a package.
# They exist to be the one place something is listed (``router.py`` the mount
# order, ``tables.py`` the model modules), so assembling every feature is their
# job and they are outside the direction rule by definition.
ASSEMBLY = "<assembly>"

# ── the direction, as data ───────────────────────────────────────────────────
#
# Read as "this package's modules may import from these packages, and nothing
# else". A package may always import its own modules; that is not listed.
#
# ``runtime`` appears on every feature because that is what it is FOR — the event
# bus and the per-run task session are declared shared plumbing, and a feature
# reaching for either is the intended use, not drift. ``core`` likewise.
#
# The interesting entries are the ones that are NOT symmetric:
#   * ``triggers`` may read ``sops`` (a trigger names the SOP it starts) but
#     ``sops`` may not read ``triggers``.
#   * ``instances`` may read ``sops``/``forms``/``notifications``; none of those
#     three may read it. That is the line ``app/workflow/__init__.py`` names.
#   * ``correlation`` may read everything below it and NOTHING may read it: it is
#     an entry point, not a dependency.
MAY_IMPORT: dict[str, set[str]] = {
    "core": set(),                                    # the leaf. Nothing internal at all.
    "runtime": set(),                                 # plumbing. Knows no feature.
    "forms": {"core", "runtime"},
    "sops": {"core", "runtime"},
    "threat_levels": {"core", "runtime"},
    "notifications": {"core", "runtime"},
    "triggers": {"core", "runtime", "sops"},
    "instances": {"core", "runtime", "sops", "forms", "notifications"},
    "correlation": {"core", "runtime", "sops", "triggers", "instances"},
    ASSEMBLY: set(),                                  # filled in below
}
# The assembly layer may reach everything; spelled as the union rather than a
# repeated list so adding a feature above does not need a second edit here.
MAY_IMPORT[ASSEMBLY] = {p for p in MAY_IMPORT if p != ASSEMBLY}

# Who may import ``app.db``. ``core`` and ``runtime`` may not, and that is the
# second half of the leaf claim: a module that can reach ``Base`` can declare a
# table, and a "shared" package that declares tables is a feature wearing a
# disguise. ``runtime.session`` builds its OWN engine from the settings for
# exactly this reason.
MAY_IMPORT_APP_DB: set[str] = {
    "forms", "sops", "threat_levels", "notifications", "triggers", "instances",
    "correlation", ASSEMBLY,
}

# Back-edges that exist, are deliberate, and are kept DEFERRED (inside a function)
# so they never appear in the module-import graph. Keyed by the module that does
# it, valued by (target package, why). Each one is checked to still be real.
DEFERRED_BACK_EDGES: dict[str, tuple[str, str]] = {
    "triggers.service": (
        "correlation",
        "The trigger simulator answers 'what would this event have done', and the "
        "answer must come from the live match-and-create helpers rather than a "
        "second copy of them that can drift. Deferred so `correlation` stays an "
        "entry point in the module graph: importing triggers must not drag the "
        "engine, its models and its session in with it.",
    ),
}


# ── graph extraction ─────────────────────────────────────────────────────────


def _own_package(path: pathlib.Path) -> str:
    parts = path.relative_to(WORKFLOW).parts
    return parts[0] if len(parts) > 1 else ASSEMBLY


def _module_name(path: pathlib.Path) -> str:
    """``triggers/service.py`` → ``triggers.service``; ``router.py`` → ``router``."""
    rel = path.relative_to(WORKFLOW).with_suffix("")
    parts = [p for p in rel.parts if p != "__init__"]
    return ".".join(parts) or "__init__"


def _target_package(path: pathlib.Path, node: ast.ImportFrom | ast.Import) -> list[str]:
    """The internal packages one import statement reaches, if any.

    Handles both spellings: relative (``from ..sops.models import SOP`` — what this
    codebase uses, and what makes the import line say which feature a name came
    from) and absolute (``from app.workflow.sops.models import SOP``), so switching
    style cannot switch the guard off.
    """
    if isinstance(node, ast.Import):
        names = [a.name for a in node.names]
    elif node.level:
        base = path.parent
        for _ in range(node.level - 1):
            base = base.parent
        try:
            rel = base.relative_to(WORKFLOW)
        except ValueError:
            return []  # escaped app/workflow entirely — app.db etc., handled apart
        prefix = ".".join(rel.parts)
        tail = node.module or ""
        names = [".".join(x for x in (prefix, tail) if x)]
    else:
        names = [node.module or ""]

    out: list[str] = []
    for name in names:
        if name.startswith("app.workflow."):
            name = name[len("app.workflow."):]
        elif name.startswith("app.") or not name:
            continue
        head = name.split(".")[0]
        if head in MAY_IMPORT and head != ASSEMBLY:
            out.append(head)
    return out


def _imports_app_db(node: ast.ImportFrom | ast.Import) -> bool:
    if isinstance(node, ast.Import):
        return any(a.name == "app.db" or a.name.startswith("app.db.") for a in node.names)
    return not node.level and (node.module or "") == "app.db"


def _edges() -> list[tuple[str, str, str, int, bool]]:
    """Every internal import in the tree: (from_module, from_pkg, to_pkg, line, deferred)."""
    found: list[tuple[str, str, str, int, bool]] = []
    for path in sorted(WORKFLOW.rglob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        # A node is DEFERRED when it is not at module level, i.e. it has a
        # function or class between it and the module body.
        deferred: set[int] = set()
        for parent in ast.walk(tree):
            if isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                for child in ast.walk(parent):
                    if isinstance(child, (ast.Import, ast.ImportFrom)):
                        deferred.add(id(child))
        for node in ast.walk(tree):
            if not isinstance(node, (ast.Import, ast.ImportFrom)):
                continue
            for target in _target_package(path, node):
                found.append((
                    _module_name(path), _own_package(path), target,
                    node.lineno, id(node) in deferred,
                ))
    return found


def _app_db_importers() -> list[tuple[str, str, int]]:
    out: list[tuple[str, str, int]] = []
    for path in sorted(WORKFLOW.rglob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)) and _imports_app_db(node):
                out.append((_module_name(path), _own_package(path), node.lineno))
    return out


# ── the checks ───────────────────────────────────────────────────────────────


def test_declared_direction_is_acyclic():
    """The TABLE itself must be a DAG, before it is used to judge anything.

    Checked separately because the graph walk below cannot catch this: an edit
    that grants ``sops`` → ``instances`` while ``instances`` → ``sops`` stands
    would make every real import legal and the direction meaningless. The table is
    the claim; this is the claim being self-consistent.
    """
    colour: dict[str, int] = {}

    def visit(pkg: str, stack: list[str]) -> None:
        if colour.get(pkg) == 2:
            return
        if colour.get(pkg) == 1:
            cycle = " -> ".join(stack[stack.index(pkg):] + [pkg])
            raise AssertionError(f"MAY_IMPORT declares a cycle: {cycle}")
        colour[pkg] = 1
        for nxt in sorted(MAY_IMPORT[pkg]):
            visit(nxt, stack + [pkg])
        colour[pkg] = 2

    for pkg in sorted(MAY_IMPORT):
        visit(pkg, [])


def test_every_package_on_disk_is_declared():
    """A package nobody listed is a package nothing checks."""
    on_disk = {
        p.name for p in WORKFLOW.iterdir()
        if p.is_dir() and (p / "__init__.py").exists()
    }
    undeclared = sorted(on_disk - set(MAY_IMPORT))
    assert not undeclared, (
        f"{undeclared} exist under app/workflow/ but are absent from MAY_IMPORT, so "
        f"nothing constrains what they import or what imports them. Add a line."
    )


def test_core_and_runtime_import_no_feature():
    """The claim in core/__init__.py and runtime/__init__.py, literally.

    Kept as its own test rather than folded into the general walk because it is
    the claim a reader of those two docstrings is checking, and a failure here
    should say so in those words.
    """
    offenders = [
        f"{mod} (line {line}) imports `{to}`" + (" — deferred, still an edge" if lazy else "")
        for mod, pkg, to, line, lazy in _edges()
        # `to == pkg` is core.mixins reaching core.primitives — a package's own
        # modules are not an outward edge and are excluded everywhere here.
        if pkg in ("core", "runtime") and to != pkg
    ]
    assert not offenders, (
        "core/ and runtime/ are declared to import NO feature package. They now do:\n  "
        + "\n  ".join(offenders)
        + "\nEither the import belongs in the feature that needs it, or the docstring "
          "is no longer true and the split has been undone."
    )


def test_core_and_runtime_do_not_import_app_db():
    """A package that can reach ``Base`` can declare a table."""
    offenders = [
        f"{mod} (line {line})"
        for mod, pkg, line in _app_db_importers()
        if pkg not in MAY_IMPORT_APP_DB
    ]
    assert not offenders, (
        "these modules import app.db but their package is not in MAY_IMPORT_APP_DB:\n  "
        + "\n  ".join(offenders)
        + "\ncore/ and runtime/ are excluded on purpose: runtime.session builds its own "
          "engine from the settings rather than borrowing the service's Base."
    )


def test_no_import_runs_against_the_declared_direction():
    """The whole graph, against the whole table. This is the guard."""
    violations: list[str] = []
    for mod, pkg, to, line, lazy in _edges():
        if to == pkg:
            continue  # a package's own modules
        if to in MAY_IMPORT[pkg]:
            continue
        allowed = DEFERRED_BACK_EDGES.get(mod)
        if lazy and allowed and allowed[0] == to:
            continue
        kind = "deferred " if lazy else ""
        violations.append(
            f"{pkg}/{mod.split('.', 1)[-1]}.py:{line} — {kind}import of `{to}`; "
            f"`{pkg}` may import {sorted(MAY_IMPORT[pkg]) or 'nothing'}"
        )
    assert not violations, (
        "imports that run against the direction stated in app/workflow/__init__.py:\n  "
        + "\n  ".join(violations)
        + "\n\nIf the new edge is right, add it to MAY_IMPORT here AND fix the docstring "
          "it contradicts. If it is a deliberate deferred back-edge, add it to "
          "DEFERRED_BACK_EDGES with the reason. Do not delete this test."
    )


def test_deferred_back_edges_are_real():
    """The allowlist may not outlive the thing it excuses.

    Without this, removing the simulator's lazy import would leave a permanent
    licence for anything in ``triggers`` to reach into ``correlation``, and the
    next person would find a rule that says the edge is fine rather than a rule
    that says why this one is.
    """
    edges = _edges()
    for mod, (target, _why) in DEFERRED_BACK_EDGES.items():
        matches = [e for e in edges if e[0] == mod and e[2] == target]
        assert matches, (
            f"DEFERRED_BACK_EDGES excuses {mod} -> {target}, which no longer exists. "
            f"Delete the entry; a stale excuse is a hole."
        )
        assert all(e[4] for e in matches), (
            f"{mod} -> {target} is excused only as a DEFERRED import, and at least one "
            f"of its imports is now at module level "
            f"(line{'s' if len(matches) > 1 else ''} "
            f"{', '.join(str(e[3]) for e in matches if not e[4])}). That puts "
            f"`correlation` back into the import graph of the package it consumes."
        )
