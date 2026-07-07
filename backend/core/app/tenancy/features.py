"""Feature-gating primitive — deny a route unless the caller's tenant has a feature.

The tenant model carries a ``features: dict`` (e.g. ``{"anpr": true, "vms": false}``).
The keys are drawn from the platform MODULE CATALOG (``app.module_catalog``): a
super-admin toggles a module per tenant by setting ``features[key]`` on the tenant.

This module provides the enforcement primitive so a domain route can require a
feature with one dependency:

    from app.tenancy.features import require_feature

    @router.get("/anpr/plates", dependencies=[Depends(require_feature("anpr"))])
    async def list_plates(...): ...

Resolution rules (kept in ONE place, mirroring the scope/isolation design):
  * SUPER-ADMIN (platform scope, no tenant) → ALWAYS allowed (bypass). The catalog
    and per-tenant toggles are things the super-admin manages; they never gate them.
  * NO TENANT (platform/system caller that isn't a super-admin — shouldn't normally
    happen for a tenant route) → allowed (nothing to gate against).
  * TENANT-ADMIN / tenant user → allowed iff ``tenant.features.get(key)`` is truthy;
    otherwise 403 FEATURE_DISABLED.

``feature_enabled(db, scope, key)`` is the reusable predicate (returns a bool) for
callers that want to branch rather than hard-fail.
"""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.errors import ForbiddenError
from ..db.base import get_db
from .models import Tenant
from .scope import Scope, get_scope


async def feature_enabled(db: AsyncSession, scope: Scope, key: str) -> bool:
    """Whether ``scope`` may use the feature ``key``.

    Super-admins and no-tenant callers always pass. A tenant caller passes iff the
    feature flag is truthy on their tenant row. A tenant_id that no longer resolves
    to a live tenant is treated as NOT enabled (fail-closed).
    """
    if scope.is_platform or scope.tenant_id is None:
        return True
    tenant = await db.get(Tenant, scope.tenant_id)
    if tenant is None:
        return False
    return bool((tenant.features or {}).get(key))


def require_feature(key: str):
    """Build a FastAPI dependency that 403s unless the caller's tenant has ``key``.

    Usage: ``dependencies=[Depends(require_feature("anpr"))]`` on a router or route.
    Super-admin bypasses; a tenant without the flag gets 403 FEATURE_DISABLED.
    """

    async def _dep(
        db: AsyncSession = Depends(get_db),
        scope: Scope = Depends(get_scope),
    ) -> None:
        if not await feature_enabled(db, scope, key):
            raise ForbiddenError(
                f"the '{key}' module is not enabled for this tenant",
                code="FEATURE_DISABLED",
            )

    return _dep
