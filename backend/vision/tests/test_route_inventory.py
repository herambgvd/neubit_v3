"""Every route, over HTTP, refuses an anonymous caller — and the ownership rule holds.

Nothing in this suite had ever CALLED a route. 528 tests drove services and
drivers directly, which is right for a driver test and cannot answer the question
a gate poses: a permission dependency can be declared and never reached, and only
the wire can tell the difference.

212 routes, 8 of them public by design and each accounted for below.
"""

from __future__ import annotations

import pathlib
import re
import uuid

import pytest
from fastapi.routing import APIRoute

from .conftest import PREFIX, auth, client

#: Public on purpose. Each is a decision, not an omission.
PUBLIC = {
    "/health": "liveness for a load balancer",
    "/readyz": "readiness for an orchestrator, which has no token",
    "/api/v1/vms/media/verify": "Traefik ForwardAuth calls it to verify a stream "
                                "token — it IS the auth check, so gating it is circular",
    "/onvif/device_service": "ONVIF SOAP; auth is WS-Security, not a bearer",
    "/onvif/media_service": "ONVIF SOAP",
    "/onvif/media2_service": "ONVIF SOAP",
    "/onvif/recording_service": "ONVIF SOAP",
    "/onvif/search_service": "ONVIF SOAP",
    "/onvif/replay_service": "ONVIF SOAP",
    "/openapi.json": "schema",
    "/docs": "swagger",
    "/docs/oauth2-redirect": "swagger",
    "/redoc": "redoc",
}


def _walk(routes, prefix: str = ""):
    """Flatten deferred include_router wrappers; the mount prefix lives on the
    wrapper and the route's own path is unprefixed, so it must be accumulated."""
    for route in routes:
        original = getattr(route, "original_router", None)
        if original is not None:
            ctx = getattr(route, "include_context", None)
            yield from _walk(original.routes, prefix + (getattr(ctx, "prefix", "") or ""))
            continue
        yield prefix + getattr(route, "path", ""), route


def _protected():
    from app.main import create_app

    out = []
    for path, route in _walk(create_app().routes):
        if not isinstance(route, APIRoute) or path in PUBLIC:
            continue
        url = "/".join(
            str(uuid.uuid4()) if seg.startswith("{") and seg.endswith("}") else seg
            for seg in path.split("/")
        )
        for method in sorted(set(route.methods) - {"HEAD", "OPTIONS"}):
            out.append((method, url))
    return sorted(set(out))


PROTECTED = _protected()


def test_the_walk_sees_the_whole_surface():
    """A walk that finds nothing makes every assertion below vacuous — and this
    router uses deferred includes, where a naive iteration sees a handful."""
    assert len(PROTECTED) > 190, len(PROTECTED)


@pytest.mark.parametrize("method,url", PROTECTED, ids=lambda v: str(v))
async def test_anonymous_is_refused(app, method, url):
    async with client(app) as c:
        r = await c.request(
            method, url, json={} if method in ("POST", "PUT", "PATCH") else None
        )
    assert r.status_code == 401, f"{method} {url} -> {r.status_code}: {r.text[:200]}"


def test_every_public_route_is_accounted_for():
    """A route dropping out of a gate must not silently join the public set: the
    list above is the decision record, so an unlisted ungated path fails here."""
    from app.main import create_app

    unlisted = []
    for path, route in _walk(create_app().routes):
        if not isinstance(route, APIRoute) or path in PUBLIC:
            continue
        names = set()

        def visit(dep):
            for sub in dep.dependencies:
                names.add(getattr(sub.call, "__qualname__", "") or type(sub.call).__name__)
                visit(sub)

        visit(route.dependant)
        if not any("require_permission" in n or "get_principal" in n or "get_scope" in n
                   for n in names):
            unlisted.append(f"{sorted(route.methods)[0]} {path}")
    assert not unlisted, (
        "these routes resolve no caller and are not in PUBLIC. Add the gate, or "
        "add the route with the reason it does not need one:\n  " + "\n  ".join(unlisted)
    )


# ── the ownership rule, checked across the service ───────────────────────────

def test_every_ownership_check_says_what_it_does_about_platform_rows():
    """`assert_owned` defaults to allow_shared=True: a NULL tenant_id is readable
    by everyone. That default is right for a SHARED record and wrong for the
    by-id path of something a tenant owns — and the helpers it lives in are the
    same ones update and delete go through.

    It cost this service a real hole. The single media node on a live deployment
    is the standalone recorder, `tenant_id` NULL, and a tenant holding
    `vms.config.manage` could PATCH it: the request returned 200 with
    `api_url: http://attacker.example:8000`.

    So every call now states its intent rather than taking the default. The one
    that keeps shared reads is media_nodes, and it says `allow_shared=not
    for_write` — read the shared recorder, do not edit it.
    """
    bare = []
    for p in sorted(pathlib.Path("app").rglob("*.py")):
        src = p.read_text()
        for m in re.finditer(r"assert_owned\((?:[^()]|\([^()]*\))*\)", src):
            if "allow_shared" not in m.group(0):
                line = src[: m.start()].count("\n") + 1
                bare.append(f"{p}:{line}")
    assert not bare, (
        "these ownership checks take the allow_shared default, which lets any "
        "tenant reach a NULL-tenant row:\n  " + "\n  ".join(bare)
    )
