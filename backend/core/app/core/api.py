"""FastAPI application factory shared by every scenario app.

    from app.core import create_app, ModuleRegistry
    registry = ModuleRegistry()
    registry.register(cameras.SPEC).register(attendance.SPEC)  # etc.
    app = create_app(registry, title="Vizor FRS")

What it wires up (so every scenario gets the same production baseline):
  1. Structured logging + per-request id, Prometheus /metrics
  2. Uniform error envelope + stable codes
  3. License verification + expiry gate, then license-gated feature modules
  4. Versioned API: everything mounts under settings.api_prefix (default /api/v1);
     health/readyz/metrics/files stay unversioned at the root.
"""

from __future__ import annotations

from collections.abc import Iterable

from fastapi import APIRouter, FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from .config import Settings, get_settings
from .errors import register_error_handlers
from .health import router as health_router
from .license import load_license
from .logging import RequestLoggingMiddleware, configure_logging, get_logger
from .request_limits import RequestSizeLimitMiddleware
from .metrics import MetricsMiddleware, metrics_response
from .modules import ModuleRegistry


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Standard security response headers on every response.

    Defence-in-depth for the API tier; the proxy and frontend set the same on HTML.
    The CSP is locked all the way down because the API returns only JSON.
    """

    _HEADERS = {
        "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-site",
        "X-Permitted-Cross-Domain-Policies": "none",
    }

    async def dispatch(self, request, call_next):
        response = await call_next(request)
        for key, value in self._HEADERS.items():
            response.headers.setdefault(key, value)
        # Files are blobs, not JSON: relax the CSP just far enough for an image to
        # load, plus `sandbox` so anything reaching the browser as a document (an
        # SVG, a legacy .html) runs with no script and an opaque origin. Backs up
        # the attachment disposition in core/storage.py.
        if request.url.path.startswith("/files"):
            response.headers["Content-Security-Policy"] = (
                "default-src 'none'; img-src 'self'; sandbox"
            )
        return response


class GlobalRateLimitMiddleware(BaseHTTPMiddleware):
    """Coarse per-IP request cap across the whole API (abuse backstop).

    The window lives in Redis (core/ratelimit.py) so the cap means the same number
    whether core runs one uvicorn worker or eight.

    Only `/health`, `/readyz` and `/metrics` are exempt — a throttled probe reads as
    an outage. Matched exactly, not by prefix: `startswith` would also exempt
    `/health-bypass`. `/files` gets a wider budget rather than an exemption; `/docs`
    and `/openapi.json` get neither.
    """

    #: Exact paths that are never counted.
    EXEMPT_PATHS = frozenset({"/health", "/readyz", "/metrics"})

    #: `/files` is bandwidth, not API calls: its own bucket, wider budget.
    FILES_PREFIX = "/files"
    FILES_MULTIPLIER = 10

    def __init__(self, app, limit: int, skip_prefixes: tuple[str, ...] = ()):
        super().__init__(app)
        self.limit = limit
        # Accepted for callers that still pass it; the class decides the policy.
        self.skip_prefixes = skip_prefixes

    async def dispatch(self, request, call_next):
        path = request.url.path
        if (
            self.limit <= 0
            or request.method == "OPTIONS"
            or path in self.EXEMPT_PATHS
        ):
            return await call_next(request)
        from .client_ip import client_ip
        from .ratelimit import RateLimitError, hit

        # `client_ip`, not `request.client.host`: behind a gateway the peer is the
        # gateway, which would count the whole estate into one bucket.
        ip = client_ip(request)
        if path.startswith(self.FILES_PREFIX):
            bucket, limit = f"files:{ip}", self.limit * self.FILES_MULTIPLIER
        else:
            bucket, limit = f"global:{ip}", self.limit
        try:
            await hit(bucket, limit, 60.0)
        except RateLimitError as exc:
            return JSONResponse(
                status_code=429,
                content={"error": {"code": exc.code, "message": str(exc)}},
            )
        return await call_next(request)


class LicenseEnforcementMiddleware(BaseHTTPMiddleware):
    """Block feature access when the license is expired.

    Login, license, features, branding, health and metrics stay reachable so an
    admin can sign in and upload a fresh license; everything else gets a
    LICENSE_EXPIRED envelope. Read per request, so a renewal takes effect at once.
    """

    def __init__(self, app, allow_prefixes: tuple[str, ...]):
        super().__init__(app)
        self.allow_prefixes = allow_prefixes

    async def dispatch(self, request, call_next):
        if request.method == "OPTIONS":  # never block CORS preflight
            return await call_next(request)
        lic = getattr(request.app.state, "license", None)
        if (
            lic is not None
            and lic.is_expired
            and not request.url.path.startswith(self.allow_prefixes)
        ):
            return JSONResponse(
                status_code=403,
                content={
                    "error": {
                        "code": "LICENSE_EXPIRED",
                        "message": "License expired. Please update your license to continue.",
                    }
                },
            )
        return await call_next(request)


# Shipped defaults and .env.example placeholders. Boot is refused if any of these
# survive outside dev/test.
#
# The exact-match list did NOT cover the two values actually in
# deploy/.env.example — it named two near-miss variants that appear nowhere in the
# repository. Copying the example, setting VE_ENV=prod and leaving the secrets
# alone therefore booted core and every satellite on a string anyone can read in
# the source, with this function reading as though it had checked. Every
# placeholder this repository ships begins "change-me", so that is the rule now;
# the list stays for the empty string and for anything that ever does not.
#
# Kept in step with kernel/kernel/config.py, which had the same list and no length
# floor at all. backend/kernel/tests/test_boot_guard.py asserts they agree, and
# asserts both refuse whatever deploy/.env.example currently ships.
_WEAK_SECRETS = {
    "change-me-in-prod",
    "change-me-secret",
    "change-me-to-a-long-random-string-min-32-bytes",
    "change-me-another-long-random-string",
    "",
}
_PLACEHOLDER_MARKER = "change-me"


def _is_placeholder(value: str) -> bool:
    return value in _WEAK_SECRETS or _PLACEHOLDER_MARKER in value.lower()


def _enforce_secrets(settings: Settings, log) -> None:
    """Refuse to start outside dev/test with default or too-short crypto secrets."""
    if settings.env in ("dev", "test", "local"):
        if _is_placeholder(settings.jwt_secret) or _is_placeholder(settings.secrets_key):
            log.warning("running with DEFAULT secrets — fine for dev, NEVER for production")
        return
    weak = []
    if _is_placeholder(settings.jwt_secret) or len(settings.jwt_secret) < 32:
        weak.append("VE_JWT_SECRET (needs a strong random value, >=32 chars)")
    if _is_placeholder(settings.secrets_key) or len(settings.secrets_key) < 16:
        weak.append("VE_SECRETS_KEY (needs a strong random value)")
    if weak:
        raise RuntimeError(
            f"refusing to start in env={settings.env!r}: weak/default secret(s): "
            + "; ".join(weak)
        )


def create_app(
    registry: ModuleRegistry,
    *,
    title: str = "Neubit",
    settings: Settings | None = None,
    extra_routers: Iterable[APIRouter] = (),
    lifespan=None,
) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.env)
    log = get_logger("edge.startup")
    prefix = settings.api_prefix

    _enforce_secrets(settings, log)

    # Resolve the rate-limit backend once, here, so the startup log says which one
    # is in force. A per-process window is fine for a single worker and a silent
    # downgrade for anything else, so it must not be reached by accident.
    from .ratelimit import configure_rate_limiter

    configure_rate_limiter(settings)

    lic = load_license(settings)
    log.info("license: client=%s modules=%s", lic.client, sorted(lic.modules))

    app = FastAPI(title=title, lifespan=lifespan)
    app.state.settings = settings
    app.state.license = lic
    app.state.registry = registry

    # Endpoints reachable even under an expired license (so the app can be renewed).
    allow_prefixes = (
        "/health",
        "/readyz",
        "/metrics",
        "/files",
        "/docs",
        "/redoc",
        "/openapi.json",
        f"{prefix}/auth",
        f"{prefix}/license",
        f"{prefix}/features",
        f"{prefix}/branding",
    )

    # Middleware: LAST added is OUTERMOST.
    # On-prem/single-tenant only. The multi-tenant edition gates per tenant per
    # request instead, and sets VE_LICENSE_ENFORCE_GLOBAL=false.
    if settings.license_enforce_global:
        app.add_middleware(LicenseEnforcementMiddleware, allow_prefixes=allow_prefixes)
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(
        GlobalRateLimitMiddleware,
        limit=settings.rate_limit_global_per_minute,
        # The policy lives on the class — see GlobalRateLimitMiddleware.
        skip_prefixes=(),
    )
    app.add_middleware(MetricsMiddleware)
    app.add_middleware(RequestLoggingMiddleware)
    # Near-outermost — the body has to be measured before anything reads it.
    # Starlette's multipart parser spools parts over 1 MiB to disk, so a
    # handler-side cap protects the heap and nothing else.
    app.add_middleware(RequestSizeLimitMiddleware)

    # CORS LAST, so it is the OUTERMOST middleware, and this is a correctness fix
    # rather than a style preference.
    #
    # It used to be added FIRST, which made it the innermost — so every response
    # produced by a middleware OUTSIDE it never passed back through it and carried
    # no Access-Control-Allow-Origin. A cross-origin client hitting the rate limit
    # (429), an expired licence (402) or the body cap (413) did not see any of
    # those: the browser blocked the response and reported a CORS failure, which
    # sends the reader to look at configuration instead of at the rate limit they
    # actually hit. Same-origin traffic through the gateway never showed it, which
    # is why it survived — but cors_origins exists precisely because other origins
    # are expected (see docs/MOBILE_CLIENT_CONTRACT.md).
    #
    # Outermost also means a preflight OPTIONS is answered here, rather than being
    # rate-limited and licence-checked on its way to an answer it was always going
    # to get. The body cap is unaffected: CORS reads headers, never the body.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=settings.cors_origin_regex,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_error_handlers(app)

    # --- Unversioned root endpoints ---------------------------------------
    app.include_router(health_router)  # /health, /readyz

    from .storage import files_router  # public object serving (/files/{key})

    app.include_router(files_router)

    @app.get("/metrics", include_in_schema=False)
    def metrics():
        return metrics_response()

    # --- Gateway ForwardAuth target (internal; never routed to externally) --
    # An injector, not an enforcer: always 200, and only a valid access token gets
    # the identity headers Traefik injects downstream. It must never reject, so
    # public routes still pass; enforcement stays in each service's own JWT check.
    @app.get("/internal/auth/verify", include_in_schema=False)
    def internal_auth_verify(request: Request):
        from ..auth.security import decode_token

        resp = Response(status_code=200)
        header = request.headers.get("Authorization", "")
        if header[:7].lower() == "bearer ":
            try:
                payload = decode_token(header[7:])
                if payload.get("type") == "access":
                    resp.headers["X-User-Id"] = str(payload.get("sub", ""))
                    tid = payload.get("tenant_id")
                    if tid:
                        resp.headers["X-Tenant-Id"] = str(tid)
                    resp.headers["X-Permissions"] = ",".join(payload.get("permissions") or [])
            except Exception:
                pass  # no headers; the service will 401 if the route is protected
        return resp

    # --- Versioned API (everything under settings.api_prefix) -------------
    for r in extra_routers:  # always-on: auth, licensing, audit, system, ...
        app.include_router(r, prefix=prefix)

    enabled = registry.enabled(lic)
    for spec in enabled:  # license-gated feature modules
        app.include_router(spec.router, prefix=f"{prefix}/modules/{spec.id}", tags=[spec.name])
    log.info("mounted modules: %s", [s.id for s in enabled])

    # Legacy signed-license /features, the fallback for on-prem apps with no
    # tenant-aware endpoint. Only added when nothing else has claimed the path.
    #
    # The claim check must scan extra_routers, NOT app.routes: this FastAPI version
    # defers include_router, so an included router shows up in app.routes as a
    # wrapper with no `.path` and the scan finds nothing — leaving an
    # unauthenticated licence and module dump at this path.
    features_path = f"{prefix}/features"

    def _claims_features(router) -> bool:
        router_prefix = getattr(router, "prefix", "") or ""
        return any(
            f"{prefix}{router_prefix}{getattr(r, 'path', '')}" == features_path
            for r in getattr(router, "routes", ())
        )

    if not any(_claims_features(r) for r in extra_routers):

        @app.get(features_path, tags=["platform"])
        def features() -> dict:
            """Frontend calls this on load to build its nav from enabled modules."""
            return {
                "client": lic.client,
                "expires_at": lic.expires_at.isoformat() if lic.expires_at else None,
                "modules": [spec.nav for spec in enabled],
                "limits": {} if lic._dev else lic.limits,
                "features": {} if lic._dev else lic.features,
            }

    @app.get("/", include_in_schema=False, response_class=HTMLResponse)
    def index() -> str:
        return _LANDING_HTML.format(title=title)

    return app


_LANDING_HTML = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{title}</title>
<style>
 :root{{color-scheme:dark}} *{{box-sizing:border-box}}
 body{{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  background:#000;color:#ededed;min-height:100vh;
  display:flex;align-items:center;justify-content:center;padding:24px}}
 .card{{width:100%;max-width:600px;background:#0a0a0a;border:1px solid #262626;border-radius:14px;padding:40px}}
 .badge{{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:500;letter-spacing:.02em;
  color:#a3a3a3;background:transparent;border:1px solid #262626;padding:5px 11px;border-radius:999px}}
 h1{{margin:18px 0 6px;font-size:28px;font-weight:600;letter-spacing:-.02em;color:#fff}}
 p.sub{{margin:0 0 28px;color:#8f8f8f;font-size:14px}}
 .grid{{display:grid;grid-template-columns:1fr 1fr;gap:10px}}
 a.tile{{display:block;text-decoration:none;color:#ededed;background:transparent;border:1px solid #262626;
  border-radius:10px;padding:15px 17px;transition:.15s}}
 a.tile:hover{{border-color:#525252;background:#111}}
 a.tile b{{display:block;font-size:14px;margin-bottom:2px;font-weight:500}} a.tile span{{font-size:13px;color:#8f8f8f}}
 .dot{{width:7px;height:7px;border-radius:50%;background:#3ecf8e;box-shadow:0 0 0 3px rgba(62,207,142,.15)}}
 footer{{margin-top:26px;font-size:12px;color:#666}}
</style></head><body>
 <div class="card">
  <span class="badge"><span class="dot"></span>API online</span>
  <h1>{title}</h1>
  <p class="sub">Backend API is running. This is the API host — the application UI runs separately.</p>
  <div class="grid">
   <a class="tile" href="/docs"><b>API Docs &rarr;</b><span>Interactive Swagger UI</span></a>
   <a class="tile" href="/redoc"><b>ReDoc &rarr;</b><span>Reference documentation</span></a>
   <a class="tile" href="/health"><b>Health &rarr;</b><span>Liveness probe</span></a>
   <a class="tile" href="/metrics"><b>Metrics &rarr;</b><span>Prometheus</span></a>
  </div>
  <footer>Neubit — physical security command center</footer>
 </div>
</body></html>"""

