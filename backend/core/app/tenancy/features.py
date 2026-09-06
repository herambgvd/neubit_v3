"""Feature-gating primitive — deny a route unless the caller's tenant has a feature.

The tenant model carries a ``features: dict`` (e.g. ``{"anpr": true, "vms": false}``).
The keys are drawn from the platform MODULE CATALOG (``app.module_catalog``): a
super-admin toggles a module per tenant by setting ``features[key]`` on the tenant.

This module provides the enforcement primitive so a domain route can require a
feature with one dependency:

    from app.tenancy.features import require_feature

    @router.get("/anpr/plates", dependencies=[Depends(require_feature("anpr"))])
    async def list_plates(...): ...

Resolution rules, kept in one place:
  * super-admin (platform scope, no tenant) → always allowed; they manage the
    catalog and the per-tenant toggles, so it never gates them.
  * no tenant (a platform caller that isn't a super-admin) → allowed, nothing to
    gate against.
  * tenant user → allowed iff ``tenant.features.get(key)`` is truthy, else 403
    FEATURE_DISABLED.

``feature_enabled(db, scope, key)`` is the reusable predicate (returns a bool) for
callers that want to branch rather than hard-fail.

``require_tenant_active()`` lives here too — a different question (may this tenant
operate at all?) but the same shape of answer, resolved from the same live row.
"""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.errors import ForbiddenError
from ..db.base import get_db
from .models import Tenant, effective_license_state
from .scope import Scope, get_scope, scope_of


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


def require_tenant_active():
    """Dependency: 403 when the caller's tenant is suspended, or its licence has
    expired past the grace window.

    Login refuses both already (``AuthService.authenticate``); this closes the
    window a token minted before the suspension leaves open. It is applied by
    default: ``app/app.py`` guards every base router unless it is listed in
    ``_tenant_active_exempt()`` with a reason, which is why ``app/auth/routes/`` is
    split into self-service and admin halves.

    It resolves a person or a service key rather than using ``get_scope``, which
    goes through ``get_current_user`` and refuses api-key tokens — suspension has
    to reach a tenant's machine credentials too.

    ``grace`` passes and the UI warns; super-admins and tenant-less platform
    callers bypass, matching ``feature_enabled``.
    """

    from ..auth.deps import _bearer, _resolve_actor

    async def _dep(
        db: AsyncSession = Depends(get_db),
        cred=Depends(_bearer),
    ) -> None:
        # Resolves a person or a service key, not `get_scope`: `get_scope` refuses
        # api-key tokens, so using it here 401s every key on a guarded router.
        actor = await _resolve_actor(cred, db)
        scope = scope_of(actor)
        if scope.is_platform or scope.tenant_id is None:
            return
        tenant = await db.get(Tenant, scope.tenant_id)
        if tenant is None:
            # Fail closed: a tenant_id that no longer resolves is a deleted tenant
            # whose token is still in someone's browser.
            raise ForbiddenError("the tenant no longer exists", code="TENANT_SUSPENDED")
        if tenant.status == "suspended":
            raise ForbiddenError(
                "the tenant is suspended — contact support", code="TENANT_SUSPENDED"
            )
        if effective_license_state(tenant) == "expired":
            raise ForbiddenError(
                "the tenant's license has expired — renew to continue",
                code="LICENSE_EXPIRED",
            )

    return _dep
