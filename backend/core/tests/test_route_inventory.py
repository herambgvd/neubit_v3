"""Every route is authenticated unless this file says why not.

Core has 216 API routes and every gate is a per-route `Depends`; nothing otherwise
checks that a new route has one. So the surface is pinned here: a new route either
resolves an actor, or goes in ALLOWED_UNAUTHENTICATED with a written reason.

The walk is over the resolved FastAPI dependant tree, not the source, so a gate
behind a shared sub-dependency counts. Always go through `_walk`: this FastAPI
version defers `include_router`, so `app.routes` holds wrapper objects and a naive
iteration sees 41 of the 216.
"""


import pytest
from fastapi.routing import APIRoute

from app.app import create_base_app

#: Dependency callables that establish WHO is calling. Matched on qualified name,
#: because `require_permission` and friends return closures called `_dep`.
_AUTHENTICATORS = (
    "get_current_user",
    "require_permission",
    "require_service_permission",
    "get_scope",
    "scope_of",
    "_resolve_actor",
    "require_tenant_active",
    "HTTPBearer",
    "ApiKeyPrincipal",
)

#: Routes that legitimately answer without resolving a caller. Each entry is
#: (METHOD, path) and each one is a decision, not an omission.
ALLOWED_UNAUTHENTICATED = {
    # --- pre-session: you cannot hold a token yet -------------------------
    ("POST", "/api/v1/auth/login"): "the login itself",
    ("POST", "/api/v1/auth/login/mfa"): "second factor, holding only an mfa challenge",
    ("POST", "/api/v1/auth/refresh"): "exchanges the refresh cookie; no access token by definition",
    ("POST", "/api/v1/auth/forgot-password"): "by design anonymous; answers identically either way",
    ("POST", "/api/v1/auth/reset-password"): "carries a single-use reset token instead",
    ("GET", "/api/v1/auth/setup-status"): "is this a fresh install — asked before any user exists",
    ("POST", "/api/v1/auth/setup"): "creates the first admin; refuses once any user exists",
    ("POST", "/api/v1/auth/2fa/enroll/begin"): "enrolment forced at login, on the mfa challenge token",
    ("POST", "/api/v1/auth/2fa/enroll/confirm"): "same challenge token; returns the real tokens",
    ("GET", "/api/v1/auth/sso/login"): "starts the OIDC authorization-code flow",
    ("POST", "/api/v1/auth/sso/callback"): "the IdP redirect; the code is the credential",
    ("POST", "/api/v1/auth/token"): "exchanges a raw API key for a JWT; the key is the credential",
    # --- infrastructure ---------------------------------------------------
    ("GET", "/health"): "liveness for a load balancer",
    ("GET", "/readyz"): "readiness for an orchestrator; names which dependency is down",
    ("GET", "/metrics"): "no longer routed publicly by the gateway (routes.yml)",
    ("GET", "/"): "the landing page",
    ("GET", "/internal/auth/verify"): "Traefik ForwardAuth; reachable only on the internal network",
    # --- deliberate, and each one carries its own protection --------------
    # Mount /files once, at the root, in create_app. Adding it to base_routers too
    # publishes the same public blob route at a second address.
    ("GET", "/files/{key:path}"): (
        "public blob serving, and it has to be: an avatar or a logo is loaded from "
        "an <img> with no token. What protects it is on both sides — content types "
        "come from a whitelist and non-raster types are sent as attachments, keys "
        "are unguessable uuid4 hex, and anything under `signed_url_prefixes` "
        "(report exports) additionally requires an unexpired HMAC. That last one "
        "used to be a permanent capability url: the download endpoint checked "
        "`report.export` and then handed out a link that outlived the permission."
    ),
    ("GET", "/api/v1/realtime/access-events"): "SSE resolves its own principal; see core/sse_auth.py",
    ("GET", "/api/v1/realtime/incidents"): "SSE resolves its own principal; see core/sse_auth.py",
    ("GET", "/api/v1/realtime/vms-events"): "SSE resolves its own principal; see core/sse_auth.py",
    ("GET", "/api/v1/realtime/wall-events"): "SSE resolves its own principal; see core/sse_auth.py",
}


def _walk(routes, prefix: str = ""):
    """Flatten deferred `include_router` wrappers into (full_path, route) pairs.

    A deferred include keeps the mount prefix on the wrapper (`include_context.prefix`)
    and leaves the route's own `.path` unprefixed, so the prefix must be accumulated
    on the way down or an allowlist of real paths matches nothing.
    """
    for route in routes:
        original = getattr(route, "original_router", None)
        if original is not None:
            context = getattr(route, "include_context", None)
            yield from _walk(original.routes, prefix + (getattr(context, "prefix", "") or ""))
            continue
        yield prefix + getattr(route, "path", ""), route


def _dependency_names(route: APIRoute) -> set[str]:
    names: set[str] = set()

    def visit(dependant) -> None:
        for sub in dependant.dependencies:
            call = sub.call
            names.add(getattr(call, "__qualname__", "") or type(call).__name__)
            visit(sub)

    visit(route.dependant)
    return names


def _inventory():
    app = create_base_app(title="test")
    rows = []
    for path, route in _walk(app.routes):
        if not isinstance(route, APIRoute):
            continue
        names = _dependency_names(route)
        protected = any(a in n for n in names for a in _AUTHENTICATORS)
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            rows.append((method, path, protected))
    return rows


def test_the_walk_sees_the_whole_surface():
    """`app.routes` holds deferred wrappers; a naive iteration sees 41 of 216, which
    would make every other assertion in this file about the wrong 41."""
    rows = _inventory()
    assert len(rows) > 180, f"only walked {len(rows)} routes; the router walk is broken"


def test_every_route_authenticates_or_is_listed_with_a_reason():
    unlisted = [
        (m, p) for m, p, protected in _inventory()
        if not protected and (m, p) not in ALLOWED_UNAUTHENTICATED
    ]
    assert not unlisted, (
        "these routes resolve no caller and are not in ALLOWED_UNAUTHENTICATED. "
        "Add the gate, or add the route with the reason it does not need one:\n"
        + "\n".join(f"  {m:6} {p}" for m, p in sorted(unlisted, key=lambda x: x[1]))
    )


def test_the_allowlist_has_no_stale_entries():
    """An entry matching no unauthenticated route was renamed or has since been
    gated; either way the reason it records is now misleading."""
    actual = {(m, p) for m, p, protected in _inventory() if not protected}
    stale = sorted(set(ALLOWED_UNAUTHENTICATED) - actual, key=lambda x: x[1])
    assert not stale, "\n".join(f"  {m:6} {p}" for m, p in stale)


def test_every_allowlist_entry_states_why():
    for key, reason in ALLOWED_UNAUTHENTICATED.items():
        assert reason and len(reason) > 15, f"{key} has no real reason recorded"


# ---------------------------------------------------------------------------
# The other direction: routes that MUST answer without a credential.
#
# The inventory above cannot catch this. Guarding every base router with
# `require_tenant_active` turned `GET /branding` and `GET /settings/public` into
# 401s while the inventory stayed green, because `require_tenant_active` is in
# _AUTHENTICATORS — a gate in the wrong place reads the same as one in the right
# place. Asserted over HTTP because that is the property: an anonymous GET works.
# ---------------------------------------------------------------------------

PUBLIC_ROUTES = {
    "/api/v1/branding": "the login page themes itself before anyone has signed in",
    "/api/v1/settings/public": "the unauthenticated screens read their settings here",
    "/api/v1/broadcasts/active": "a maintenance notice has to reach the login page",
    "/health": "liveness for a load balancer",
    # /readyz is deliberately absent: with no database or redis it correctly answers
    # 503 here. test_health_probes.py covers it.
}


@pytest.mark.asyncio
@pytest.mark.parametrize("path", sorted(PUBLIC_ROUTES))
async def test_a_public_route_answers_without_a_token(sessionmaker_, path):
    import httpx

    from app.db.base import get_db

    app = create_base_app(title="test")

    async def _override_db():
        async with sessionmaker_() as session:
            yield session

    app.dependency_overrides[get_db] = _override_db
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get(path)
    assert r.status_code != 401, (
        f"{path} now requires a credential — {PUBLIC_ROUTES[path]}. "
        f"Got {r.status_code}: {r.text[:200]}"
    )
    assert r.status_code < 500, f"{path} -> {r.status_code}: {r.text[:200]}"


# Over the wire, every route. --------------------------------------------------
#
# `test_every_route_authenticates_or_is_listed_with_a_reason` reads the dependency
# tree. That is the right check for "somebody added a route and forgot the gate",
# and it is a DIFFERENT question from "the gate answers": a dependency can be
# declared and never reached — an earlier one that raises something else, a router
# mounted without its gates, a path that 500s before any of it runs.
#
# Core is the biggest surface in the estate and the one holding auth, tenants and
# users, and until now only the five PUBLIC routes had ever been CALLED without a
# token. This calls all of them.


def _protected_urls():
    """A concrete URL per route that is supposed to need a credential.

    Note what this does NOT filter on: whether the static walk thinks the route is
    gated. Taking `protected` into account here would make this test only ever
    visit routes the walk already approved of — an ungated route would be excluded
    from it by the very property that makes it a bug. The allowlists are the only
    exemption, so a route with no gate at all fails this as well as the static
    check above.
    """
    import uuid as _uuid

    out = []
    for method, path, _protected in _inventory():
        if (method, path) in ALLOWED_UNAUTHENTICATED or path in PUBLIC_ROUTES:
            continue
        url = "/".join(
            str(_uuid.uuid4()) if seg.startswith("{") and seg.endswith("}") else seg
            for seg in path.split("/")
        )
        out.append((method, url))
    return sorted(set(out))


PROTECTED_URLS = _protected_urls()


def test_there_is_something_to_call():
    """A walk that finds nothing makes the assertion below pass over an empty list —
    which is exactly how 41-of-216 went unnoticed before."""
    assert len(PROTECTED_URLS) > 180, len(PROTECTED_URLS)


@pytest.mark.asyncio
@pytest.mark.parametrize("method,url", PROTECTED_URLS, ids=lambda v: str(v))
async def test_anonymous_is_refused_over_http(sessionmaker_, method, url):
    """401, and never a 2xx or a 500. A 500 here would mean the route did work
    before it looked at the caller."""
    import httpx

    from app.db.base import get_db

    app = create_base_app(title="test")

    async def _override_db():
        async with sessionmaker_() as session:
            yield session

    app.dependency_overrides[get_db] = _override_db
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.request(
            method, url, json={} if method in ("POST", "PUT", "PATCH") else None
        )
    assert r.status_code == 401, f"{method} {url} -> {r.status_code}: {r.text[:200]}"
