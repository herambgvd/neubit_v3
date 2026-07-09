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
    from .auth import router as auth_router
    from .branding import router as branding_router
    from .core.audit import audit_router
    from .core.realtime import realtime_router
    from .core.realtime_access import realtime_access_router
    from .core.realtime_incidents import realtime_incidents_router
    from .core.realtime_vms import realtime_vms_router
    from .core.storage import files_router
    from .device_brands import router as device_brands_router
    from .infra import router as infra_router
    from .licensing import router as licensing_router
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

    return [
        auth_router,
        admin_router,
        infra_router,
        platform_admin_router,
        module_catalog_router,
        device_brands_router,
        licensing_router,
        files_router,
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
        *sites_routers,
        *tags_routers,
        *security_routers,
    ]


def create_base_app(
    registry: ModuleRegistry | None = None,
    *,
    title: str = "Neubit",
    extra_routers: Iterable[APIRouter] = (),
    lifespan=None,
) -> FastAPI:
    registry = registry if registry is not None else ModuleRegistry()
    return create_app(
        registry,
        title=title,
        extra_routers=[*base_routers(), *extra_routers],
        lifespan=lifespan,
    )
