"""Sites domain — physical hierarchy: site → floor → zone.

Conventions across the submodules:

  * SQLAlchemy 2 async ORM on the shared ``Base`` (portable generic types).
  * Tenant row-scoping via ``app.tenancy.scope`` (nullable ``tenant_id``): every
    list/get/update/delete is scoped or ownership-checked.
  * Uniform errors from ``app.core.errors`` and audit via ``app.core.audit.record``.
  * Domain events on the NATS spine under
    ``tenant.<tenant_id>.sites.<entity>.<event>``.

The device-placement submodule records a device plotted onto a floor plan: CRUD
plus by-floor/by-zone queries, tenant-scoped.

The infrastructure submodule is a site's equipment registry — systems, equipment
with design facts, and point slots bound by gateway tag — plus the I/O schedule
import that fills it.

Wire into a scenario app::

    from app import sites
    app = create_base_app(..., extra_routers=[*sites.routers])
"""

from .device.router import router as device_router
from .floor.router import router as floor_router
from .infrastructure.router import router as infrastructure_router
from .infrastructure.router import vocabulary_router as infrastructure_vocabulary_router
from .site.router import router as site_router
from .zone.router import router as zone_router

# All routers — mounted by create_base_app under the api_prefix.
routers = [
    site_router,
    floor_router,
    zone_router,
    device_router,
    infrastructure_router,
    infrastructure_vocabulary_router,
]

__all__ = [
    "routers",
    "site_router",
    "floor_router",
    "zone_router",
    "device_router",
    "infrastructure_router",
    "infrastructure_vocabulary_router",
]
