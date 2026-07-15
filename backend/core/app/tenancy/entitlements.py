"""Effective entitlements — the ONE resolver every consumer reads.

Decision (docs/TENANCY_AND_ENTITLEMENTS_PLAN.md #3): *one resolver, two sources*.
A single :func:`effective_entitlements` turns a tenant's stored license state
(``plan`` + ``features{}`` toggles + ``limits{}`` + expiry/grace) into the canonical
shape that drives:

  * ``GET /api/v1/features`` (this module's router) — the operator console's nav +
    license display,
  * the ``features``/``limits`` JWT claims (see :func:`token_entitlements`) that
    satellite services authorise against,
  * (later) API feature-gates + quota checks.

Source of that stored state is the ``Tenant`` row for the **cloud multi-tenant**
edition; for **on-prem single-tenant** the signed license seeds the lone tenant's
row at boot — either way this resolver is the only shape downstream sees.

Super-admins (no tenant) get everything: all catalog modules enabled, no limits,
an ``active`` license — mirroring the scope/feature bypass everywhere else.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..db.base import get_db
from ..module_catalog.service import ModuleCatalogService
from .models import Tenant, effective_license_state
from .scope import Scope, get_scope


def effective_entitlements(
    tenant: Tenant | None,
    modules: list,
    *,
    is_superadmin: bool = False,
    now: datetime | None = None,
) -> dict:
    """Resolve a tenant's live entitlements into the canonical ``/features`` shape.

    ``modules`` is the platform module catalog (list of ``Module``); each becomes a
    ``{key, name, category, enabled}`` entry. ``enabled`` is truthy iff the tenant's
    ``features[key]`` is on (super-admins → always on). ``limits``/``license_state``
    come from the tenant row (super-admins → unlimited/active).
    """
    features = dict((tenant.features or {})) if tenant else {}
    limits = dict((tenant.limits or {})) if tenant else {}
    state = effective_license_state(tenant, now) if tenant else "active"

    module_out = [
        {
            "key": m.key,
            "name": m.name,
            "category": m.category,
            "enabled": True if is_superadmin else bool(features.get(m.key)),
        }
        for m in modules
    ]
    return {
        "plan": tenant.plan if tenant else None,
        "modules": module_out,
        "limits": {} if is_superadmin else limits,
        "license_state": "active" if is_superadmin else state,
        "expires_at": (
            tenant.license_expires_at.isoformat()
            if tenant and tenant.license_expires_at
            else None
        ),
    }


async def token_entitlements(db: AsyncSession, user: User) -> tuple[dict, dict, str, str]:
    """Return ``(features, limits, license_state, tenant_status)`` for token claims.

    ``features``/``limits`` are the RAW tenant dicts (``features`` is ``{key: bool}``)
    so a satellite service's ``feature_enabled(key)`` check has the same semantics as
    core's ``require_feature``. ``license_state`` is "active"|"grace"|"expired" and
    ``tenant_status`` is "active"|"suspended" so a satellite can gate on expiry OR
    suspension locally (core already blocks both at login; this closes the window
    where a token issued before suspension/expiry keeps working). Super-admins (or
    any tenant-less user) get ``({}, {}, "active", "active")`` — they bypass anyway.
    """
    if getattr(user, "is_superadmin", False) or not getattr(user, "tenant_id", None):
        return {}, {}, "active", "active"
    tenant = await db.get(Tenant, user.tenant_id)
    if tenant is None:
        return {}, {}, "active", "active"
    return (
        dict(tenant.features or {}),
        dict(tenant.limits or {}),
        effective_license_state(tenant),
        tenant.status or "active",
    )


# Mounted by create_app under the api_prefix → full path {api_prefix}/features.
# This tenant-aware endpoint is the multi-tenant core's authoritative /features;
# create_app only registers its legacy signed-license /features as a fallback when
# no router already claims the path (see app/core/api.py).
router = APIRouter(tags=["platform"])


@router.get("/features")
async def features(
    db: AsyncSession = Depends(get_db),
    scope: Scope = Depends(get_scope),
) -> dict:
    """The caller's effective entitlements, resolved from their tenant.

    Reachable under grace/expired so the frontend can still render the license
    banner and the (gated) nav. Super-admin → all modules enabled, unlimited.
    """
    modules = await ModuleCatalogService(db).list_modules()
    tenant = (
        None
        if scope.is_platform or scope.tenant_id is None
        else await db.get(Tenant, scope.tenant_id)
    )
    return effective_entitlements(tenant, modules, is_superadmin=scope.is_platform)
