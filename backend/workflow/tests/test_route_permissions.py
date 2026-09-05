"""Every mounted route is permission-gated, checked against the routers themselves.

``app/workflow/router.py`` claims it: "Every endpoint is gated by a ``workflow.*``
permission via ``kernel.auth.require_permission``". Fifty-eight calls make that true
today and NOTHING made it stay true. The failure this guards is not a wrong
permission — a wrong one still 403s the wrong people, loudly, and someone files a
bug. It is a MISSING one: a route added in a hurry with the decorator's
``dependencies=[...]`` left off answers 200 to any authenticated principal in the
tenant, including one whose role grants nothing, and it does that silently, forever.
The two spellings in use here make it easy to do by accident — some routes carry the
gate in ``dependencies=[Depends(require_permission(...))]`` and others take it as a
parameter default (``actor: Principal = Depends(require_permission(...))``) — so
"looks like the one above it" is not a check.

WHY THE LIVE DEPENDANT TREE AND NOT THE SOURCE. test_package_boundaries.py parses
the AST because it needs to name a FILE and a LINE for an import. Here the question
is different: what does FastAPI actually resolve for this route, including gates
inherited from the router and gates hidden behind a shared sub-dependency. Only the
built ``route.dependant`` knows that, and it is also what the running server obeys.
A source scan would pass on a route whose gate is on a dependency FastAPI never
reaches.

WHAT THIS DELIBERATELY DOES NOT CHECK: that each route's permission is the RIGHT
one. ``workflow.sop.delete`` versus ``workflow.sop.update`` on a given handler is a
judgement about the domain, and a test that restated the mapping would be a second
copy of the routing table maintained by hand — it would fail on every rename and
catch nothing. Presence is the property that can be checked mechanically, and
absence is the failure that is silent.
"""

from __future__ import annotations

from fastapi.routing import APIRoute

from app.workflow.router import routers

#: What ``require_permission`` produces. It is a closure named ``_dep`` defined
#: inside the factory, so the qualname is the reliable identity — the object has no
#: other marker, and comparing by name would match any local called ``_dep``.
_GATE_QUALNAME = "require_permission.<locals>._dep"


def _walk(dependant):
    """Every dependency FastAPI will resolve for one route, at any depth."""
    for sub in dependant.dependencies:
        yield sub
        yield from _walk(sub)


def _permissions_of(call) -> tuple[str, ...]:
    """The permission strings a ``require_permission`` closure was built with.

    Read out of the closure rather than re-parsing the source, so a route that
    composes its gate at runtime is still reported by the keys it will enforce.
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

    If ``routers`` ever ends up empty — a bad import, a refactor that moves the
    mount — every assertion below would pass vacuously and report the service as
    fully gated while serving nothing. Fail on that first.
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

    Permissions are carried in the core-minted JWT, so a typo like ``workflows.sop
    .read`` or a copy-paste of ``vms.camera.read`` is a string no workflow role
    grants and no workflow role was ever meant to grant. It fails closed rather than
    open, which is why it is a separate test from the one above — but it fails
    closed for EVERY caller including the ones who should get through, and that
    reads as a permissions bug in core rather than a typo here.
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
