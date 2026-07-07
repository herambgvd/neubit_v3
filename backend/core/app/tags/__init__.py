"""Tags domain — cross-cutting, color-coded labels applied across modules.

A control-plane primitive ported from neubit_v2's ``platform/app/module/tags`` and
adapted to neubit_v3 conventions:

  * SQLAlchemy 2 async ORM on the shared ``Base`` (portable generic types), instead
    of the v2 Mongo-document + Postgres-ORM split.
  * Tenant row-scoping via ``app.tenancy.scope`` (nullable ``tenant_id`` column) —
    every list/get/update/delete is scoped or ownership-checked.
  * Uniform errors from ``app.core.errors`` and audit via ``app.core.audit.record``.
  * Domain events on the NATS spine (``app.core.events_nats``) under
    ``tenant.<tenant_id>.tags.tag.<event>``.

A ``Tag`` is a reusable label (name + hex color + description). A ``TagLink`` is a
generic association row so ANY entity — a site or zone today, a device or incident
tomorrow — can be tagged without a schema change: it carries ``entity_type`` (a
free string like ``"site"`` / ``"zone"``) and ``entity_id``.

Wire into a scenario app::

    from app import tags
    app = create_base_app(..., extra_routers=[*tags.routers])
"""

from .router import router as tags_router

# Exposed as a list for symmetry with the sites domain (``*tags.routers``).
routers = [tags_router]

__all__ = ["routers", "tags_router"]
