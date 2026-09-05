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
    """Dependency: 403 when the caller's tenant cannot operate — it is SUSPENDED
    by a super-admin, or its licence is EXPIRED past the grace window.

    Core already refuses both at LOGIN (``AuthService.authenticate``). This closes
    the window that leaves open: a token minted before the suspension keeps
    working until it expires, because nothing on the request path looks again.

    THE DEFAULT IS NOW INVERTED. This docstring used to say "for most of core that
    window is accepted; apply this dependency to a router where it is not", and it
    was applied to exactly one router — because "remember to add the dependency" is
    not a rule that survives the next router. ``app/app.py`` guards EVERY base
    router unless it appears in ``_tenant_active_exempt()`` with its reason, and
    ``app/auth/routes/`` is split into a self-service half and an admin half
    precisely so the admin half can carry this while sign-in and sign-out do not.

    It resolves a PERSON OR A SERVICE KEY, not ``get_scope``. That is the other
    reason it stayed on one router: ``get_scope`` goes through
    ``get_current_user``, which refuses api-key tokens by design, so attaching this
    anywhere a key reaches 401ed the key. Suspension applies to a tenant's machine
    credentials at least as much as to its people.

    The satellite services get the same guarantee from the kernel's
    ``require_active_license``, which reads the tenant's state from a JWT CLAIM
    because a satellite has no ``tenants`` table to ask — and a claim is exactly
    the stale thing being guarded against. Core reads the live row, so this is
    the stronger of the two and the reason a folded-in module does not lose
    anything by leaving the kernel behind.

    ``grace`` passes (the UI warns); super-admins and tenant-less platform
    callers bypass, matching ``feature_enabled``.
    """

    from ..auth.deps import _bearer, _resolve_actor

    async def _dep(
        db: AsyncSession = Depends(get_db),
        cred=Depends(_bearer),
    ) -> None:
        # Resolves a PERSON OR A SERVICE KEY, not `get_scope`.
        #
        # `get_scope` goes through `get_current_user`, which refuses an api-key token
        # on purpose ("a service credential cannot open the UI"). So this dependency
        # could only ever be attached to a router no key needs to reach — which is
        # why it lived on exactly one, and why applying it more widely 401ed every
        # key on /audit the first time it was tried. Suspension applies to a
        # tenant's machine credentials at least as much as to its people.
        actor = await _resolve_actor(cred, db)
        scope = scope_of(actor)
        if scope.is_platform or scope.tenant_id is None:
            return
        tenant = await db.get(Tenant, scope.tenant_id)
        if tenant is None:
            # Fail CLOSED. A tenant_id that no longer resolves is a deleted
            # tenant whose token is still in someone's browser, which is the
            # case this whole dependency exists for.
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
