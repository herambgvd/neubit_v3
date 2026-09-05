"""Process plumbing shared by the features — not domain, not a feature.

The distinction this package exists to make visible: a module in here says
nothing about SOPs, incidents or notifications. It is how this service talks to
the outside (the NATS bus) and how a Celery task body gets a database session.
Put it here when more than one feature needs it and it would be a lie to file it
under any one of them.

  * ``events``    — the process-wide ``EventBus`` and ``emit()``.
  * ``session``   — the per-run NullPool session used by every scheduled job.
  * ``consumers`` — whether the JetStream durables this service binds are still
    consuming. It knows a durable NAME and a stream, which is transport, not
    domain: swap the correlation engine for something else and this is unchanged.
  * ``heartbeat`` — whether the Celery worker is still executing tasks and beat
    still sending them, kept in Redis because the reader is another container and
    the writer is a forked pool child.

What does NOT belong here: anything that knows a table, a schema or a route.
Feature-specific plumbing (the notification connectors, for instance) lives with
its feature, because "infrastructure" is not a reason to move code away from the
one thing that uses it.
"""
