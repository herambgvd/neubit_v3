"""Every mounted route is permission-gated, checked against the routers themselves.

The failure this guards is a MISSING gate, not a wrong one: a wrong permission
403s loudly and gets reported, while a route with ``dependencies=[...]`` left off
answers 200 to any authenticated principal in the tenant, silently. Two spellings
are in use here — on the decorator, and as a parameter default — so "looks like the
one above it" is not a check.

It walks the built ``route.dependant`` rather than the source, so a gate inherited
from the router or hidden behind a shared sub-dependency counts, and a gate on a
dependency FastAPI never reaches does not.

It deliberately does not check that each route's permission is the RIGHT one: that
would be a second copy of the routing table, failing on every rename and catching
nothing. Presence is what can be checked mechanically.
"""

from __future__ import annotations

from fastapi.routing import APIRoute

from app.workflow.router import routers

#: What ``require_permission`` produces: a closure named ``_dep`` inside the
#: factory. The qualname is the only reliable identity — the name alone would match
#: any local called ``_dep``.
_GATE_QUALNAME = "require_permission.<locals>._dep"


def _walk(dependant):
    """Every dependency FastAPI will resolve for one route, at any depth."""
    for sub in dependant.dependencies:
        yield sub
        yield from _walk(sub)


def _permissions_of(call) -> tuple[str, ...]:
    """The permission strings a ``require_permission`` closure was built with.

    Read from the closure, not the source, so a route composing its gate at runtime
    is still reported by the keys it will enforce.
    """
    free = getattr(call, "__code__", None)
    if free is None or "permissions" not in free.co_freevars:
        return ()
    cell = call.__closure__[free.co_freevars.index("permissions")]
    return tuple(cell.cell_contents)


def _gated_routes():
    """[(method+path, (permissions...))] for every route the service mounts."""
    out = []
    for router in routers:
        for route in router.routes:
            if not isinstance(route, APIRoute):
                continue
            perms: list[str] = []
            for dep in _walk(route.dependant):
                if getattr(dep.call, "__qualname__", "") == _GATE_QUALNAME:
                    perms.extend(_permissions_of(dep.call))
            methods = ",".join(sorted(route.methods - {"HEAD", "OPTIONS"}))
            out.append((f"{methods} {route.path}", tuple(perms)))
    return out


def test_the_routers_actually_mount_routes():
    """A guard whose subject is empty passes and means nothing.

    If ``routers`` ends up empty, every assertion below passes vacuously and reports
    a fully gated service that serves nothing. Fail on that first.
    """
    routes = _gated_routes()
    assert len(routes) > 40, (
        f"only {len(routes)} routes found across {len(routers)} routers; the workflow "
        f"API is far bigger than that, so this is a broken import, not a small API."
    )


def test_every_route_is_permission_gated():
    """The claim in app/workflow/router.py, enforced instead of documented."""
    ungated = sorted(name for name, perms in _gated_routes() if not perms)
    assert not ungated, (
        "these routes resolve NO require_permission dependency, so any authenticated "
        "principal in the tenant can call them regardless of role:\n  "
        + "\n  ".join(ungated)
        + "\n\nAdd the gate, in either spelling: dependencies=[Depends("
          "require_permission('workflow.x.y'))] on the decorator, or "
          "actor: Principal = Depends(require_permission('workflow.x.y')) when the "
          "handler needs the caller. If a route is genuinely meant to be open to any "
          "authenticated user, it does not belong on this router — the probes in "
          "app/main.py are mounted outside the api_prefix for exactly that reason."
    )


def test_every_gate_uses_a_workflow_permission():
    """A workflow route gated on someone else's key is gated on nothing here.

    A typo like ``workflows.sop.read``, or a copy-paste of ``vms.camera.read``, is a
    string no workflow role grants. It fails closed rather than open — but closed
    for everyone, which reads as a core permissions bug rather than a typo here.
    """
    wrong = sorted(
        f"{name} → {p}"
        for name, perms in _gated_routes()
        for p in perms
        if not p.startswith("workflow.")
    )
    assert not wrong, (
        "routes gated on a permission outside the workflow namespace:\n  "
        + "\n  ".join(wrong)
    )
