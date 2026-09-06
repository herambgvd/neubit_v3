"""Branding: white-label identity (app name, logo, brand colours) for a deployment.

One row per tenant, plus a platform-default row tenants fall back to. The read is
public (the login page themes itself); management is gated by
``CorePerm.BRANDING_MANAGE``.

Wire in::

    from app import branding
    app = create_app(registry, extra_routers=[branding.router])
"""

from .models import Branding
from .router import public_router, router

__all__ = ["router", "Branding", "public_router"]
