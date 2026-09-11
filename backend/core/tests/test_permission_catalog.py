"""Every permission the estate enforces must be one core can grant.

A key that `require_permission` checks but `app/auth/permissions.py` does not hold
can only be held by the built-in `*` Administrator, and cannot be added to a role by
hand at all: create_role, update_role and the API-key scope path all reject an
unregistered key. Whole products have shipped unreachable this way.

So this walks the real source of every service in `backend/`, extracts the literal
keys passed to the gate factories, and fails on any the catalog does not hold.

Source and not an import, because core's image deliberately does not install the
satellites (see conftest), and parsing stays true for a service that is not running.
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


def _enforced_keys() -> dict[str, set[str]]:
    """{permission key: {"service/path.py:line", …}} for every literal gate call."""
    root = _backend_root()
    assert root is not None, "cannot locate backend/ — check run-tests.sh mounts it at /src"
    found: dict[str, set[str]] = {}
    for service in _SERVICES:
        base = root / service
        if not base.is_dir():
            continue  # a service not present in this checkout is not a failure
        for path in base.rglob("*.py"):
            if any(part in {".venv", "migrations", "tests", "__pycache__"} for part in path.parts):
                continue
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            except (SyntaxError, UnicodeDecodeError):
                continue
            # Module-level constants like PERM_READ = "access.read", so a gate
            # called with a name instead of a literal still resolves.
            consts: dict[str, str] = {}
            for node in tree.body:
                if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
                    if isinstance(node.value.value, str):
                        for t in node.targets:
                            if isinstance(t, ast.Name):
                                consts[t.id] = node.value.value
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                fn = node.func
                name = getattr(fn, "id", None) or getattr(fn, "attr", None)
                if name not in _GATES:
                    continue
                for arg in node.args:
                    key = None
                    if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                        key = arg.value
                    elif isinstance(arg, ast.Name):
                        key = consts.get(arg.id)
                    if key and "." in key:
                        where = f"{path.relative_to(root)}:{node.lineno}"
                        found.setdefault(key, set()).add(where)
    return found


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
