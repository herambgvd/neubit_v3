"""Every BI route, over HTTP. None had ever been called.

This service's suite is pure and mostly should be — the writer's decisions are
pure functions. But it also serves the Building Intelligence read API: 30 routes
over the reporting store, behind a JWT, the tenant's `analytics` module, an
unexpired licence and a per-route `bi.read`.

A permission dependency can be declared and never reached — an earlier dependency
that raises something else, a router mounted without its gates, a path that 500s
before any of it runs — and nothing here could tell the difference. This asks the
service.

It matters more than route count suggests. Every one of these reads the store that
holds the estate's telemetry, and `/bi/query` and `/bi/datasets/{key}/values`
generate SQL from a caller's spec.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.routing import APIRoute

from conftest import PREFIX, auth, client

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()
BODY_METHODS = ("POST", "PUT", "PATCH")

#: Reachable without a token, and why. Operational, not tenant data.
PUBLIC = {
    "/health": "liveness for a load balancer",
    "/readyz": "readiness — an orchestrator has no token, and this is what pages",
    "/stats": "the same numbers as /metrics, for a human with curl",
    "/metrics": "Prometheus scrape",
    "/openapi.json": "schema",
    "/docs": "swagger",
    "/docs/oauth2-redirect": "swagger",
    "/redoc": "redoc",
}


def _walk(routes, prefix: str = ""):
    """Flatten deferred `include_router` wrappers.

    FastAPI defers an include: the wrapper holds `.original_router` and the mount
    prefix sits on its `include_context`, not on the route's own `.path`. A naive
    iteration sees only the operational endpoints here — and every assertion built
    on it would then be about those.
    """
    for route in routes:
        original = getattr(route, "original_router", None)
        if original is not None:
            ctx = getattr(route, "include_context", None)
            yield from _walk(original.routes, prefix + (getattr(ctx, "prefix", "") or ""))
            continue
        yield prefix + getattr(route, "path", ""), route


def _routes():
    from app.main import app

    out = []
    for path, route in _walk(app.routes):
        if not isinstance(route, APIRoute):
            continue
        for method in sorted(set(route.methods) - {"HEAD", "OPTIONS"}):
            out.append((method, path))
    return sorted(set(out))


def _url(path: str) -> str:
    return "/".join(
        str(uuid.uuid4()) if seg.startswith("{") and seg.endswith("}") else seg
        for seg in path.split("/")
    )


ROUTES = _routes()
PRIVATE = [(m, p) for m, p in ROUTES if p not in PUBLIC]


async def test_the_walk_sees_the_whole_surface():
    """A walk that finds nothing makes every assertion below vacuous."""
    assert len(PRIVATE) >= 25, [p for _, p in PRIVATE]


@pytest.mark.parametrize("method,path", PRIVATE, ids=lambda v: str(v))
async def test_anonymous_is_refused(app, method, path):
    async with client(app) as c:
        r = await c.request(
            method, _url(path), json={} if method in BODY_METHODS else None
        )
    assert r.status_code == 401, f"{method} {path} -> {r.status_code}: {r.text[:200]}"


#: Gated PER DATASET, not by a fixed permission, so a flat 403 is the wrong
#: expectation for them and asserting it would be asserting the wrong design.
#:
#: A dataset declares its own permission key in the registry TABLE, which is the
#: point of the registry — a domain registers one and it is chartable with no
#: release. The server therefore has to READ the registry before it can know which
#: permission applies, so these reach the database with an unpermissioned caller by
#: construction. What they guarantee instead is stated in
#: `test_the_dataset_list_shows_nothing_it_should_not`: the list OMITS what the
#: caller may not read rather than showing it and refusing, because an inventory of
#: other people's data is itself information.
REGISTRY_GATED = {
    f"{PREFIX}/bi/datasets": "per-dataset permission, read from the registry",
    f"{PREFIX}/bi/datasets/{{key}}": "per-dataset permission",
    f"{PREFIX}/bi/datasets/{{key}}/values": "per-dataset permission",
    f"{PREFIX}/bi/query": "the spec names its dataset; the gate is that dataset's",
    f"{PREFIX}/bi/query/capabilities": "reports what the registry allows",
}

FIXED_PERMISSION = [(m, p) for m, p in PRIVATE if p not in REGISTRY_GATED]


@pytest.mark.parametrize("method,path", FIXED_PERMISSION, ids=lambda v: str(v))
async def test_a_caller_with_no_keys_is_refused(app, method, path):
    """403, so the refusal is proved to come from the permission gate rather than
    from the route failing before anything looked at the caller."""
    async with client(app) as c:
        r = await c.request(
            method,
            _url(path),
            headers=auth(tenant_id=TENANT, permissions=[]),
            json={} if method in BODY_METHODS else None,
        )
    assert r.status_code == 403, f"{method} {path} -> {r.status_code}: {r.text[:200]}"


async def test_the_operational_surface_stays_open(app):
    """`/readyz` is what an operator pages on: if it started demanding a token,
    the page would go quiet exactly when it mattered."""
    async with client(app) as c:
        for path in ("/health", "/readyz", "/stats", "/metrics"):
            r = await c.get(path)
            assert r.status_code != 401, f"{path} now requires a credential"
            # /readyz answers 503 here and that is CORRECT: no consumer is running
            # in a test app, and saying so is what the endpoint is for. The
            # property under test is that it answers at all, without a token.
            assert r.status_code in (200, 503), f"{path} -> {r.status_code}"


async def test_every_public_route_is_accounted_for():
    """A route that loses its gate must not quietly join the public set."""
    from app.main import app as application

    unlisted = []
    for path, route in _walk(application.routes):
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
        "these routes resolve no caller and are not in PUBLIC:\n  " + "\n  ".join(unlisted)
    )



def _dataset(key: str, permission: str):
    """A registry row with just enough on it for `public()` to render.

    Built with `model_construct` on purpose: a real `Definition` requires
    relations, engine and the rest, and none of that is what this asserts. Writing
    a valid one here would make the test about the SCHEMA, and the schema has its
    own tests.
    """
    from app.api import registry

    definition = registry.Definition.model_construct(
        dimensions=[], measures=[], relations=[], engine="sql", tenant_column="tenant_id"
    )
    return registry.Dataset.model_construct(
        key=key, name=key.title(), description="", permission=permission,
        permission_label="", permission_group="Dashboard datasets",
        definition=definition,
    )


# ── what the registry-gated routes guarantee instead ─────────────────────────

async def test_the_dataset_list_shows_nothing_it_should_not(app, monkeypatch):
    """`GET /bi/datasets` OMITS what the caller may not read.

    This is the property the flat 403 check could not express, and it is the
    stronger one. Showing a dataset and refusing it would leak the inventory —
    which domains exist, what they are called — to anyone with a token, and an
    inventory of other people's data is itself information.

    `registry.load` is monkeypatched rather than seeded, because the point under
    test is the FILTER, not the store: the datasets are rows a domain inserts at
    runtime, so any fixture of them would be a second copy of the registry.
    """
    from app.api import permsync, registry
    from app.api import router as bi

    granted = _dataset("mine", "bi.read")
    hidden = _dataset("theirs", "access.read")

    async def _load(_db):
        return {"mine": granted, "theirs": hidden}

    async def _sync(_items):
        return None

    monkeypatch.setattr(registry, "load", _load)
    monkeypatch.setattr(bi.registry, "load", _load, raising=False)
    monkeypatch.setattr(permsync, "sync", _sync)
    monkeypatch.setattr(bi.permsync, "sync", _sync, raising=False)

    async with client(app) as c:
        r = await c.get(
            f"{PREFIX}/bi/datasets",
            headers=auth(tenant_id=TENANT, permissions=["bi.read"]),
        )
    assert r.status_code == 200, r.text
    keys = [d["key"] for d in r.json()["items"]]
    assert keys == ["mine"], keys
    assert "theirs" not in r.text, "a dataset the caller cannot read was listed"


async def test_a_caller_with_no_keys_sees_an_empty_dataset_list(app, monkeypatch):
    """The same filter with nothing granted: 200 and nothing, not 200 and
    everything."""
    from app.api import permsync, registry
    from app.api import router as bi

    ds = _dataset("theirs", "access.read")

    async def _load(_db):
        return {"theirs": ds}

    async def _sync(_items):
        return None

    monkeypatch.setattr(registry, "load", _load)
    monkeypatch.setattr(bi.registry, "load", _load, raising=False)
    monkeypatch.setattr(permsync, "sync", _sync)
    monkeypatch.setattr(bi.permsync, "sync", _sync, raising=False)

    async with client(app) as c:
        r = await c.get(
            f"{PREFIX}/bi/datasets",
            headers=auth(tenant_id=TENANT, permissions=[]),
        )
    assert r.status_code == 200, r.text
    assert r.json()["items"] == [], r.text
