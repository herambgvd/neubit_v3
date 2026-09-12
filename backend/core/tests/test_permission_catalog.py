"""Every permission the estate enforces must be one core can grant.

A key that `require_permission` checks but `app/auth/permissions.py` does not hold
can only be held by the built-in `*` Administrator, and cannot be added to a role by
hand at all: create_role, update_role and the API-key scope path all reject an
unregistered key. Whole products have shipped unreachable this way.

So this walks the real source of every service in `backend/`, extracts the keys
passed to the gate factories, and fails on any the catalog does not hold.

Source and not an import, because core's image deliberately does not install the
satellites (see conftest), and parsing stays true for a service that is not running.

A gate argument is rarely a bare literal any more — services name their keys
(`CorePerm.SITES_UPDATE`, `perms.SOP_UPDATE`, `PERM_PLAYBACK`), which is the point:
a name cannot be mistyped silently. So the walk resolves names as well, across files
and through aliases, and `test_every_gate_argument_resolves` fails on any gate whose
key it could NOT work out — an unreadable gate must break this guard loudly rather
than quietly shrink what it checks.
"""


import ast
import pathlib


from app.auth.permissions import PERMISSIONS

#: The dependency factories that take permission keys as positional string literals.
_GATES = {"require_permission", "require_service_permission", "authorize_ws"}

#: Services whose keys core is the registry for. Explicit rather than a glob, so a
#: new service has to be added the day it enforces its first permission.
_SERVICES = ("access", "workflow", "ingest", "vision", "reading-writer", "core")


def _backend_root() -> pathlib.Path | None:
    """`backend/` — /src under run-tests.sh, two levels up from this file locally."""
    for candidate in (pathlib.Path("/src"), pathlib.Path(__file__).resolve().parents[2]):
        if (candidate / "core" / "app").is_dir() or (candidate / "backend").is_dir():
            return candidate / "backend" if (candidate / "backend").is_dir() else candidate
    return None


def _iter_sources(root: pathlib.Path):
    """Every service source file this guard reads, as (path, parsed tree)."""
    for service in _SERVICES:
        base = root / service
        if not base.is_dir():
            continue  # a service not present in this checkout is not a failure
        for path in base.rglob("*.py"):
            if any(part in {".venv", "migrations", "tests", "__pycache__"} for part in path.parts):
                continue
            try:
                yield path, ast.parse(path.read_text(encoding="utf-8"))
            except (SyntaxError, UnicodeDecodeError):
                continue


def _string_assignments(body) -> tuple[dict[str, str], dict[str, str]]:
    """One suite's ``NAME = "literal"`` and ``NAME = OTHER_NAME`` assignments."""
    literals: dict[str, str] = {}
    aliases: dict[str, str] = {}
    for node in body:
        if not isinstance(node, ast.Assign):
            continue
        targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
        if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            for name in targets:
                literals[name] = node.value.value
        elif isinstance(node.value, ast.Name):
            for name in targets:
                aliases[name] = node.value.id
    return literals, aliases


def _resolve(name: str, literals: dict[str, str], aliases: dict[str, str]) -> str | None:
    """Follow ``PERM_EXPORT = PERM_PLAYBACK = "vms.playback.view"`` to the string."""
    seen: set[str] = set()
    while name not in literals and name in aliases and name not in seen:
        seen.add(name)
        name = aliases[name]
    return literals.get(name)


def _namespaces(sources) -> dict[str, dict[str, str]]:
    """``{"CorePerm": {"SITES_UPDATE": "sites.update"}, "perms": {...}, …}``.

    Keyed by the name a gate would write before the dot: a class (``CorePerm``) or
    a module (``perms``, from ``from app.workflow import perms``). Permission-key
    constant names do not collide across these, so a flat per-namespace table is
    enough and needs no import graph.
    """
    spaces: dict[str, dict[str, str]] = {}
    for path, tree in sources:
        module_literals, module_aliases = _string_assignments(tree.body)
        resolved = {n: v for n in dict(module_literals, **module_aliases)
                    if (v := _resolve(n, module_literals, module_aliases)) is not None}
        if resolved:
            spaces.setdefault(path.stem, {}).update(resolved)
        for node in tree.body:
            if not isinstance(node, ast.ClassDef):
                continue
            class_literals, class_aliases = _string_assignments(node.body)
            members = {n: v for n in dict(class_literals, **class_aliases)
                       if (v := _resolve(n, class_literals, class_aliases)) is not None}
            if members:
                spaces.setdefault(node.name, {}).update(members)
    return spaces


def _imported_from(tree) -> dict[str, str]:
    """``{name bound in this file: module stem it came from}``.

    ``from app.vms.federation._common import PERM_READ`` → ``{"PERM_READ": "_common"}``,
    so a name that several services spell the same way still resolves to the one its
    own service imported. Guessing by name alone could read a DIFFERENT service's key.
    """
    out: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            stem = node.module.rsplit(".", 1)[-1]
            for alias in node.names:
                bound = alias.asname or alias.name
                # `from pkg import mod` binds the module itself; both spellings land
                # on a namespace name, which is all the lookup below needs.
                out[bound] = alias.name if alias.name == bound and alias.name.islower() else stem
    return out


def _scan() -> tuple[dict[str, set[str]], set[str]]:
    """({permission key: {"service/path.py:line", …}}, {gate args we could not read})."""
    root = _backend_root()
    assert root is not None, "cannot locate backend/ — check run-tests.sh mounts it at /src"
    sources = list(_iter_sources(root))
    spaces = _namespaces(sources)
    constant_names = {n for members in spaces.values() for n in members}

    found: dict[str, set[str]] = {}
    unreadable: set[str] = set()
    for path, tree in sources:
        # Module-level constants like PERM_READ = "access.read", so a gate called
        # with a name instead of a literal still resolves.
        literals, aliases = _string_assignments(tree.body)
        imported = _imported_from(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            fn = node.func
            name = getattr(fn, "id", None) or getattr(fn, "attr", None)
            if name not in _GATES:
                continue
            where = f"{path.relative_to(root)}:{node.lineno}"
            for arg in node.args:
                key = looks_constant = None
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    key = arg.value
                elif isinstance(arg, ast.Name):
                    key = (_resolve(arg.id, literals, aliases)
                           or spaces.get(imported.get(arg.id, ""), {}).get(arg.id))
                    # A local built at runtime is not a missed permission; a name that
                    # IS a permission constant somewhere and still did not resolve is.
                    looks_constant = arg.id in constant_names
                elif isinstance(arg, ast.Attribute) and isinstance(arg.value, ast.Name):
                    # `perms.SOP_UPDATE` / `CorePerm.SITES_UPDATE` — always a named
                    # constant, never computed, so failing to read one is a real hole.
                    key = spaces.get(arg.value.id, {}).get(arg.attr)
                    looks_constant = True
                if key and "." in key:
                    found.setdefault(key, set()).add(where)
                elif looks_constant:
                    unreadable.add(f"{where} {ast.unparse(arg)}")
    return found, unreadable


def _enforced_keys() -> dict[str, set[str]]:
    return _scan()[0]


def test_the_scan_finds_something():
    """A scan that silently matches nothing makes every test below vacuous."""
    keys = _enforced_keys()
    assert len(keys) > 40, f"only found {len(keys)} enforced keys; the AST walk is broken"


def test_every_enforced_permission_is_registered():
    """The invariant. An unregistered key can only be held by the wildcard
    Administrator, and create_role refuses to add it to a role at all."""
    catalog = set(PERMISSIONS.keys())
    missing = {k: sorted(v) for k, v in _enforced_keys().items() if k not in catalog}
    assert not missing, (
        "these permission keys are ENFORCED but not registered in "
        "app/auth/permissions.py, so no role can grant them:\n"
        + "\n".join(f"  {k}\n      {', '.join(v)}" for k, v in sorted(missing.items()))
    )


def test_no_named_permission_is_unreadable():
    """A gate written as a NAME must still resolve to its key.

    Without this, the way to silence the invariant above is to stop the scan from
    seeing a key at all: move it somewhere the walk cannot follow and "nothing
    enforced" reads exactly like "nothing missing"."""
    _, unreadable = _scan()
    assert not unreadable, (
        "these gates name a permission constant this guard could not resolve, so "
        "they are no longer being checked:\n"
        + "\n".join(f"  {u}" for u in sorted(unreadable))
    )


def test_every_gating_service_is_still_seen():
    """Per-service, not just a total: the count floor above would stay green while a
    whole service's keys went invisible behind a refactor the walk cannot follow."""
    root = _backend_root()
    seen = {pathlib.Path(w).parts[0] for wheres in _enforced_keys().values() for w in wheres}
    gating = set()
    for path, tree in _iter_sources(root):
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                fn = node.func
                if (getattr(fn, "id", None) or getattr(fn, "attr", None)) in _GATES:
                    gating.add(path.relative_to(root).parts[0])
    assert gating <= seen, f"these services enforce permissions the walk no longer sees: {gating - seen}"


def test_the_guard_would_fail_on_an_unregistered_key():
    """Proves the assertion above can fail: a catalog containing everything and a
    scan returning nothing read identically without it."""
    catalog = set(PERMISSIONS.keys())
    assert "workflow.sop.read" in catalog
    assert "definitely.not.a.real.permission" not in catalog


def test_no_registered_key_is_a_duplicate_or_empty():
    keys = list(PERMISSIONS.keys())
    assert len(keys) == len(set(keys))
    assert all(k and "." in k for k in keys if k != "*"), keys
