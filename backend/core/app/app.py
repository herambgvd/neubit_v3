"""Assemble a ready-to-run scenario app with every platform-base capability.

A scenario's main.py becomes a few lines:

    from app.app import create_base_app
    from app.core import ModuleRegistry
    from .modules import cameras, attendance          # scenario feature modules
    registry = ModuleRegistry().register(cameras.SPEC).register(attendance.SPEC)
    app = create_base_app(registry, title="Vizor FRS")

create_base_app mounts the always-on platform routers (auth, licensing, storage
file-serving, audit, system, messaging, branding, reports, realtime hub), then the
license-gated feature modules from the registry.
"""

from __future__ import annotations

from collections.abc import Iterable

from fastapi import APIRouter, FastAPI

from .core import ModuleRegistry, create_app


def base_routers() -> list[APIRouter]:
    """Every always-on platform router. Imported lazily to keep import order clean."""
    from .admin import router as admin_router
    from .alerts import router as alerts_router
    from .auth import router as auth_router
    from .billing import router as billing_router
    from .branding import router as branding_router
    from .broadcasts import public_router as broadcasts_public_router
    from .broadcasts import router as broadcasts_router
    from .core.audit import audit_router
    from .core.realtime import realtime_router
    from .core.realtime_access import realtime_access_router
    from .core.realtime_incidents import realtime_incidents_router
    from .core.realtime_vms import realtime_vms_router
    from .core.realtime_wall import realtime_wall_router
    from .dashforge import router as dashforge_router
    from .device_brands import router as device_brands_router
    from .infra import router as infra_router
    from .licensing import router as licensing_router
    from .security.router import sso_router
    from .messaging import router as messaging_router
    from .module_catalog import router as module_catalog_router
    from .platform_admin import router as platform_admin_router
    from .reports import router as reports_router
    from .search import router as search_router
    from .security import routers as security_routers
    from .settings import router as settings_router
    from .sites import routers as sites_routers
    from .system import system_router
    from .tags import routers as tags_routers
    from .tenancy.entitlements import router as features_router

    return [
        auth_router,
        features_router,
        admin_router,
        billing_router,
        alerts_router,
        broadcasts_router,
        broadcasts_public_router,
        infra_router,
        platform_admin_router,
        module_catalog_router,
        device_brands_router,
        licensing_router,
        dashforge_router,
        # files_router is NOT here. `create_app` already mounts it at the ROOT
        # (`/files/{key}`), which is the path `LocalStorage.url()` builds and the
        # only one the gateway routes. Listing it again gave the same public,
        # unauthenticated blob route a second address under `/api/v1/files/…` —
        # unused by anything, and a second surface to remember when hardening the
        # first. Found by the route inventory in tests/test_route_inventory.py.
        audit_router,
        system_router,
        messaging_router,
        branding_router,
        reports_router,
        settings_router,
        search_router,
        realtime_router,
        realtime_incidents_router,
        realtime_access_router,
        realtime_vms_router,
        realtime_wall_router,
        *sites_routers,
        *tags_routers,
        *security_routers,
    ]


def _tenant_active_exempt() -> set[int]:
    """`id()` of every base router that must keep working for a tenant which CANNOT
    operate — suspended by a super-admin, or past its licence grace window.

    `require_tenant_active` existed and was applied to exactly ONE router
    (dashforge). Its own docstring said "for most of core that window is accepted",
    and the window is real: core refuses a suspended tenant at LOGIN and then nothing
    on the request path looks again, so a token minted a minute before the suspension
    keeps working across users, sites, settings, messaging and reports until it
    expires. Where suspension is a commercial control, that is the control. And
    "remember to add the dependency" is not a rule that survives the next router.

    So the default is inverted — every base router is guarded unless it is named
    here. Matched by OBJECT IDENTITY, not by prefix or tag: two different routers
    share the `/admin` prefix, five share `/realtime`, and one has neither prefix nor
    tag, so any string key would silently mis-classify some of them. A router that
    disappears from this list is an import error, not a quiet loss of an exemption.
    """
    from .auth import router as auth_router
    from .broadcasts import public_router as broadcasts_public_router
    from .core.realtime import realtime_router
    from .core.realtime_access import realtime_access_router
    from .core.realtime_incidents import realtime_incidents_router
    from .core.realtime_vms import realtime_vms_router
    from .core.realtime_wall import realtime_wall_router
    from .core.storage import files_router
    from .licensing import router as licensing_router
    from .security.router import sso_router
    from .tenancy.entitlements import router as features_router

    return {
        id(r)
        for r in (
            # Sign in, sign out, read your own profile, refresh. A suspended tenant's
            # user must still authenticate far enough to be TOLD they are suspended,
            # and to log out. Also carries the unauthenticated routes (login, password
            # reset) which the guard — which resolves a user — would turn into 401s.
            auth_router,
            # How the console LEARNS it is suspended. Guarding it leaves the UI with
            # a 403 and nothing to render the message from.
            features_router,
            # The way OUT of the state. Guarding this makes an expired tenant unable
            # to stop being expired. (Billing sits under /admin and is super-admin
            # only, which bypasses the guard anyway.)
            licensing_router,
            # Unauthenticated by design.
            files_router,
            broadcasts_public_router,
            # `/auth/sso/login` and `/auth/sso/callback` are the OIDC authorization-
            # code flow and run BEFORE there is a session at all — the guard resolves
            # a user, so it would turn the login flow into a 401. Its sibling
            # `/security/sso` (the CONFIG) is guarded like everything else.
            sso_router,
            # These authorize inside the handler — SSE cannot take this as a FastAPI
            # dependency, because a StreamingResponse would hold the session for the
            # life of the stream — and they check the tenant themselves. See
            # core/sse_auth.py.
            realtime_router,
            realtime_access_router,
            realtime_incidents_router,
            realtime_vms_router,
            realtime_wall_router,
        )
    }


def _guarded(router: APIRouter) -> APIRouter:
    """Wrap `router` so every route under it also requires an operable tenant.

    A fresh wrapper each call rather than mutating `router.dependencies`: these are
    module-level singletons and `create_base_app` runs many times per process in the
    test suite, which would stack one copy of the dependency per app.
    """
    from fastapi import Depends

    from .tenancy.features import require_tenant_active

    wrapper = APIRouter(dependencies=[Depends(require_tenant_active())])
    wrapper.include_router(router)
    return wrapper


def create_base_app(
    registry: ModuleRegistry | None = None,
    *,
    title: str = "Neubit",
    extra_routers: Iterable[APIRouter] = (),
    lifespan=None,
) -> FastAPI:
    registry = registry if registry is not None else ModuleRegistry()
    exempt = _tenant_active_exempt()
    base = [r if id(r) in exempt else _guarded(r) for r in base_routers()]
    return create_app(
        registry,
        title=title,
        extra_routers=[*base, *extra_routers],
        lifespan=lifespan,
    )
