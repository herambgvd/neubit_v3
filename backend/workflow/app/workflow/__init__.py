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

LAYOUT — one package per feature, each holding its own models / schemas / service
/ router, so a change to one subject is a change inside one directory:

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

plus two files at this level, both of which exist to be the ONE place something is
listed:

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
