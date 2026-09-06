"""Workflow domain — SOP / incident-automation engine.

Conventions:

  * SQLAlchemy 2 async ORM on this service's own ``Base`` and database,
    ``neubit_workflow``.
  * Tenant row-scoping via ``kernel.auth`` (nullable ``tenant_id``) — every
    list/get/update/delete is ``scoped`` or ``assert_owned``.
  * Uniform errors from ``kernel.errors``.
  * Cross-domain events on the NATS spine under
    ``tenant.<id>.workflow.<entity>.<event>``, with a JetStream durable consumer
    (the correlation engine) driven by a Celery worker.
  * Scheduled work (escalation / timeout / notification dispatch) via Celery beat.

Layout — one package per feature, each with its own models / schemas / service /
router, so a change to one subject stays in one directory:

    sops/           the playbook: sops, states, transitions
    triggers/       what starts an incident: triggers, alert formats, simulator
    instances/      a running incident: state machine, PDF, escalation sweeps
    forms/          dynamic form definitions + their validator
    notifications/  templates, channels, outbox, device tokens, connectors
    threat_levels/  the site / deployment threat-posture register
    correlation/    the live NATS event→incident consumer + its dedup slots

and two packages that are explicitly NOT features:

    core/           the shared vocabulary and pure rules (leaf; imports no feature)
    runtime/        process plumbing: the event bus, the per-run task session

plus two files at this level, each the one place something is listed:

    router.py       assembles the feature routers, in mount order
    tables.py       imports every model module so Alembic sees all 13 tables

The dependency graph is one-directional and must stay that way:
``core`` ← features ← ``instances`` ← ``correlation``. Nothing in ``sops``,
``forms`` or ``notifications`` may import ``instances``.

Wire the routers into the service app::

    from app.workflow.router import routers
    for r in routers:
        app.include_router(r, prefix=settings.api_prefix)
"""

from .router import routers

__all__ = ["routers"]
