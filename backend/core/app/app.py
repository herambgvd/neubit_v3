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
    from .branding import public_router as branding_public_router
    from .branding import router as branding_router
    from .branding import public_router as branding_public_router
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
    from .settings import public_router as settings_public_router
    from .security.router import sso_router
    from .messaging import router as messaging_router
    from .module_catalog import router as module_catalog_router
    from .platform_admin import router as platform_admin_router
    from .reports import router as reports_router
    from .search import router as search_router
    from .security import routers as security_routers
    from .settings import public_router as settings_public_router
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
        # files_router is deliberately absent: `create_app` mounts it at the root
        # (`/files/{key}`), which is what `LocalStorage.url()` builds and what the
        # gateway routes. Listing it here would give the same public blob route a
        # second address under `/api/v1/files/…`.
        audit_router,
        system_router,
        messaging_router,
        branding_router,
        branding_public_router,
        reports_router,
        settings_router,
        settings_public_router,
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
    """`id()` of every base router that must keep working for a tenant which cannot
    operate — suspended, or past its licence grace window.

    Guarded by default, exempt only if named here: "remember to add the dependency"
    does not survive the next router, and a token minted before a suspension
    otherwise keeps working until it expires.

    Matched by object identity, not prefix or tag — two routers share `/admin`, five
    share `/realtime`, one has neither. A router removed from this list becomes an
    import error rather than a silently lost exemption.
    """
    from .auth import router as auth_router
    from .branding import public_router as branding_public_router
    from .broadcasts import public_router as broadcasts_public_router
    from .core.realtime import realtime_router
    from .core.realtime_access import realtime_access_router
    from .core.realtime_incidents import realtime_incidents_router
    from .core.realtime_vms import realtime_vms_router
    from .core.realtime_wall import realtime_wall_router
    from .core.storage import files_router
    from .licensing import router as licensing_router
    from .settings import public_router as settings_public_router
    from .security.router import sso_router
    from .tenancy.entitlements import router as features_router

    return {
        id(r)
        for r in (
            # A suspended tenant's user must still get far enough to be told they
            # are suspended, and to log out. Also carries the unauthenticated routes
            # (login, password reset) that the guard would turn into 401s.
            auth_router,
            # How the console learns it is suspended. Guarded, the UI gets a 403 and
            # nothing to render the message from.
            features_router,
            # The way out of the state: guarded, an expired tenant could never stop
            # being expired. (Billing is super-admin only, so it bypasses anyway.)
            licensing_router,
            # Unauthenticated by design.
            files_router,
            broadcasts_public_router,
            # The login page reads both before anyone signs in (its logo, colours,
            # and the public settings the anonymous screens need). They are separate
            # router objects so the guard can cover the writes but not these.
            branding_public_router,
            settings_public_router,
            # The OIDC authorization-code flow runs before there is a session, and
            # the guard resolves a user. Its sibling `/security/sso` (the config) is
            # guarded like everything else.
            sso_router,
            # These authorize inside the handler, tenant check included: SSE cannot
            # take it as a dependency, because a StreamingResponse would hold the
            # session for the life of the stream. See core/sse_auth.py.
            realtime_router,
            realtime_access_router,
            realtime_incidents_router,
            realtime_vms_router,
            realtime_wall_router,
        )
    }


def _guarded(router: APIRouter) -> APIRouter:
    """Wrap `router` so every route under it also requires an operable tenant.

    A fresh wrapper each call, not a mutation of `router.dependencies`: the routers
    are module-level singletons and `create_base_app` runs many times per process,
    which would stack one copy of the dependency per app.
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
