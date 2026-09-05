"""Every permission the estate ENFORCES must be one core can GRANT.

`app/auth/permissions.py` says this in prose, twice, in comments written after it
had already gone wrong:

    "Enforced by the ingest service … and, until now, MISSING from this catalog —
     so no role could grant them and only a wildcard admin could reach Ingest at
     all. Registering a key here is not book-keeping: it is what makes the
     permission grantable."

It went wrong again, eleven times wider. `backend/access` and `backend/workflow`
enforced 23 distinct keys between them and core's catalog held none of them, so two
shipped products could only be used by the built-in `*` Administrator. Worse than
un-suggested: `AuthService.create_role`, `update_role` and the API-key scope path all
call `dynamic_permissions.unknown()` and REJECT an unregistered key outright, so a
tenant admin trying to build the role by hand was told it did not exist.

A comment cannot enforce this; a test can. This walks the real source of every
service in `backend/`, extracts the literal keys passed to `require_permission` and
its variants, and fails on any that the catalog does not hold. Adding a permission
to a satellite is then one line in `permissions.py`, and forgetting it is a red
suite rather than a product no role can reach.

WHY THE SOURCE AND NOT AN IMPORT: core's image deliberately does not install the
satellites (or the kernel — see conftest). Parsing is what is available, and it is
also what stays true for a service that is not running.
"""

from __future__ import annotations

import ast
import os
import pathlib

import pytest

from app.auth.permissions import PERMISSIONS

#: The dependency factories that take permission keys as positional string literals.
_GATES = {"require_permission", "require_service_permission", "authorize_ws"}

#: Services whose keys core is the registry for. A new backend service belongs here
#: the day it enforces its first permission — that is the point of the list being
#: explicit rather than a glob of whatever happens to be on disk.
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
    """A scan that silently matches nothing would make every test below vacuous —
    the exact shape of failure this file exists to prevent elsewhere."""
    keys = _enforced_keys()
    assert len(keys) > 40, f"only found {len(keys)} enforced keys; the AST walk is broken"


def test_every_enforced_permission_is_registered():
    """The invariant. A key the code checks but the catalog does not hold can only
    ever be held by the wildcard Administrator, and cannot be added to a role at
    all — create_role rejects unknown keys."""
    catalog = set(PERMISSIONS.keys())
    missing = {k: sorted(v) for k, v in _enforced_keys().items() if k not in catalog}
    assert not missing, (
        "these permission keys are ENFORCED but not registered in "
        "app/auth/permissions.py, so no role can grant them:\n"
        + "\n".join(f"  {k}\n      {', '.join(v)}" for k, v in sorted(missing.items()))
    )


def test_the_guard_would_fail_on_an_unregistered_key():
    """Proves the assertion above can fail. Without this, a catalog that somehow
    contained everything — or a scan that returned nothing — reads identically."""
    catalog = set(PERMISSIONS.keys())
    assert "workflow.sop.read" in catalog
    assert "definitely.not.a.real.permission" not in catalog


def test_no_registered_key_is_a_duplicate_or_empty():
    keys = list(PERMISSIONS.keys())
    assert len(keys) == len(set(keys))
    assert all(k and "." in k for k in keys if k != "*"), keys
