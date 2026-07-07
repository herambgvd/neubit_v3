"""Workflow domain — SOP / incident-automation engine.

Ported from neubit_v2's ``platform/app/module/workflow`` (sop / state / transition
/ trigger / instance / form / notification / threat_level submodules) plus
``module/correlation`` (the event→incident engine), and adapted to neubit_v3
conventions:

  * SQLAlchemy 2 async ORM on this service's OWN ``Base`` (its own db,
    ``neubit_workflow``), instead of the v2 Mongo-document + Postgres-ORM split.
  * Tenant row-scoping via ``kernel.auth`` (nullable ``tenant_id`` column) — every
    list/get/update/delete is ``scoped`` or ``assert_owned``.
  * Uniform errors from ``kernel.errors``.
  * Cross-domain events on the NATS spine (``kernel.events``) under
    ``tenant.<id>.workflow.<entity>.<event>``, and a JetStream durable consumer
    (the correlation engine) driven by a Celery worker.
  * Scheduled work (escalation / timeout / notification dispatch) via Celery beat.

The connector framework (``app.workflow.connectors``) makes notification delivery
pluggable — Email + Webhook today, WhatsApp / mobile-push later as drop-in classes.

Wire the routers into the service app::

    from app.workflow.router import routers
    for r in routers:
        app.include_router(r, prefix=settings.api_prefix)
"""

from .router import routers

__all__ = ["routers"]
