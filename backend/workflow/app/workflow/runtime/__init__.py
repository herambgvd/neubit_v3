"""Process plumbing shared by the features — not domain, not a feature.

Nothing in here knows about SOPs, incidents or notifications. Put a module here
when more than one feature needs it and it belongs to none of them.

  * ``events``    — the process-wide ``EventBus`` and ``emit()``.
  * ``session``   — the per-run NullPool session every scheduled job uses.
  * ``consumers`` — whether the JetStream durables are still consuming.
  * ``heartbeat`` — whether the Celery worker still runs tasks and beat still
    sends them.

Does not belong here: anything that knows a table, a schema or a route.
Feature-specific plumbing (the notification connectors) lives with its feature.
"""
