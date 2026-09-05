"""Every route is authenticated unless this file says why not.

Core has 216 API routes and every gate on them is per-route: a `Depends` in one
handler's signature. Nothing checks that a new route has one. That is how
`/security/dual-auth/{id}/consume` shipped taking nothing but a session, how four
SSE streams shipped with authentication and no authorization, and how the legacy
`/features` fallback shipped unauthenticated behind a guard that could not see the
router shadowing it.

So the surface is enumerated and pinned. A new route either resolves an actor, or it
is added to ALLOWED_UNAUTHENTICATED with a reason someone had to write down. The
test names the offending route and method, so the failure is actionable rather than
a count that moved.

This walks the RESOLVED FastAPI dependant tree, not the source. A gate hidden behind
a shared sub-dependency therefore counts, and a gate on a dependency FastAPI never
reaches does not — the same reasoning as workflow's `test_route_permissions.py`.

Note the router walk: this FastAPI version defers `include_router`, so `app.routes`
holds `_IncludedRouter` wrappers rather than the routes themselves. Iterating it
naively sees 41 of the 216 and every assertion below would be about the wrong 41 —
which is not hypothetical, it is the bug that let the `/features` fallback register.
"""

from __future__ import annotations

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
    ("GET", "/ready"): "readiness for an orchestrator; names which dependency is down",
    ("GET", "/metrics"): "no longer routed publicly by the gateway (routes.yml)",
    ("GET", "/"): "the landing page",
    ("GET", "/internal/auth/verify"): "Traefik ForwardAuth; reachable only on the internal network",
    # --- deliberate, and each one carries its own protection --------------
    # Mounted once, at the root, by create_app. It used to ALSO appear under
    # /api/v1/files via base_routers — the same public blob route at a second
    # address, which this inventory is what found.
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

    The prefix has to be accumulated on the way down. A deferred include keeps the
    mount prefix on the WRAPPER (`include_context.prefix`) and leaves the route's
    own `.path` unprefixed, so a route mounted at `/api/v1/auth/login` reports
    `/auth/login` — and an allowlist written with real paths would match nothing
    while looking entirely correct.
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
    """`app.routes` holds deferred wrappers, so a naive iteration sees 41 of 216 and
    every assertion below would be about the wrong 41. This is not a hypothetical —
    it is the bug that let the unauthenticated /features fallback register."""
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
    """An entry that no longer matches a real unauthenticated route is either a
    renamed path or a route that has since been gated. Either way the reason it
    records is now misleading, which is the failure mode this whole file exists to
    prevent."""
    actual = {(m, p) for m, p, protected in _inventory() if not protected}
    stale = sorted(set(ALLOWED_UNAUTHENTICATED) - actual, key=lambda x: x[1])
    assert not stale, "\n".join(f"  {m:6} {p}" for m, p in stale)


def test_every_allowlist_entry_states_why():
    for key, reason in ALLOWED_UNAUTHENTICATED.items():
        assert reason and len(reason) > 15, f"{key} has no real reason recorded"


# ---------------------------------------------------------------------------
# The other direction: routes that MUST answer without a credential.
#
# Everything above asks "is this route gated". This asks "is this route still
# ungated", and it exists because the inventory above cannot answer it. Guarding
# every base router with `require_tenant_active` turned `GET /branding` and
# `GET /settings/public` into 401s — the login page could no longer fetch its own
# logo — and the inventory stayed green, because `require_tenant_active` IS in
# _AUTHENTICATORS. Adding the guard SATISFIED the test that was supposed to be
# watching. A gate in the wrong place looks identical to a gate in the right one
# unless something asserts the route still works without a token.
#
# Asserted over HTTP rather than by reading dependencies, because that is the
# property: an anonymous GET returns content.
# ---------------------------------------------------------------------------

PUBLIC_ROUTES = {
    "/api/v1/branding": "the login page themes itself before anyone has signed in",
    "/api/v1/settings/public": "the unauthenticated screens read their settings here",
    "/api/v1/broadcasts/active": "a maintenance notice has to reach the login page",
    "/health": "liveness for a load balancer",
    # /ready is deliberately absent: it answers 503 in this harness because there is
    # no database or redis, which is it working correctly. test_health_probes.py
    # covers it, including that its 503 names the failing dependency.
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
