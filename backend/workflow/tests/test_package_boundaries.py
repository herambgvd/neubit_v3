"""The import direction the package docstrings assert, checked against the graph.

``core`` is the leaf (imports no feature and not ``app.db``), ``runtime`` knows no
table, schema or route, and the direction is ``core`` ← features ← ``instances`` ←
``correlation``. This is the guard on all three.

It parses the AST rather than importing: no live ``app.db`` is needed, deferred
imports are still seen, and a failure names the offending file and line.

A function-local import is still an edge — it breaks a cycle but not a dependency.
A deliberate back-edge goes in :data:`DEFERRED_BACK_EDGES` with its reason, and
:func:`test_deferred_back_edges_are_real` fails if it stops existing or stops being
deferred.

To add a feature package: one line in :data:`MAY_IMPORT`, plus one entry in
:data:`MAY_IMPORT_APP_DB` if it owns tables. There is no test logic to edit.
"""

from __future__ import annotations

import ast
import pathlib

WORKFLOW = pathlib.Path(__file__).resolve().parents[1] / "app" / "workflow"

# The modules that sit at ``app/workflow/`` itself rather than in a package. Their
# job is to assemble every feature, so they are outside the direction rule.
ASSEMBLY = "<assembly>"

# ── the direction, as data ───────────────────────────────────────────────────
#
# Read as "this package's modules may import from these packages, and nothing
# else". A package may always import its own modules; that is not listed.
#
# ``runtime`` and ``core`` appear on every feature because that is what they are
# for. The interesting entries are the asymmetric ones:
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
# The assembly layer may reach everything. Spelled as a union so adding a feature
# above needs no second edit here.
MAY_IMPORT[ASSEMBLY] = {p for p in MAY_IMPORT if p != ASSEMBLY}

# Who may import ``app.db``. ``core`` and ``runtime`` may not: a module that can
# reach ``Base`` can declare a table. ``runtime.session`` builds its own engine
# from the settings for that reason.
MAY_IMPORT_APP_DB: set[str] = {
    "forms", "sops", "threat_levels", "notifications", "triggers", "instances",
    "correlation", ASSEMBLY,
}

# Deliberate back-edges kept deferred (inside a function) so they never appear in
# the module-import graph. Keyed by module → (target package, why). Each is checked
# to still be real.
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

    Handles both relative and absolute spellings, so switching style cannot switch
    the guard off.
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
        # Deferred == not at module level, i.e. a function or class sits between
        # it and the module body.
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
    """The table itself must be a DAG before it is used to judge anything.

    The graph walk cannot catch this: granting ``sops`` → ``instances`` while
    ``instances`` → ``sops`` stands would make every real import legal.
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

    Its own test, not folded into the general walk, so a failure reads in the same
    words as the docstring it contradicts.
    """
    offenders = [
        f"{mod} (line {line}) imports `{to}`" + (" — deferred, still an edge" if lazy else "")
        for mod, pkg, to, line, lazy in _edges()
        # `to == pkg` is a package's own modules, not an outward edge.
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

    Otherwise removing the simulator's lazy import would leave a standing licence
    for anything in ``triggers`` to reach into ``correlation``.
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
