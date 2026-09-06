"""Tags domain — cross-cutting, color-coded labels applied across modules.

A ``Tag`` is a reusable label (name + hex color + description). A ``TagLink`` attaches
one to any entity — a site or zone today, a device or incident later — without a
schema change, via a free-string ``entity_type`` plus ``entity_id``.

Tenant row-scoping goes through ``app.tenancy.scope``; mutations are audited and
published on the NATS spine under ``tenant.<tenant_id>.tags.tag.<event>``.

Wire into an app::

    from app import tags
    app = create_base_app(..., extra_routers=[*tags.routers])
"""

from .router import router as tags_router

# Exposed as a list for symmetry with the sites domain (``*tags.routers``).
routers = [tags_router]

__all__ = ["routers", "tags_router"]
