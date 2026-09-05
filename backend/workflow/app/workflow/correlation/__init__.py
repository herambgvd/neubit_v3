"""Correlation — the live event→incident consumer.

    models.py    correlation_dedup (the firing idempotency slots)
    engine.py    the JetStream durable: match triggers / alert formats → create
                 incidents
    jobs.py      the dedup-slot expiry cleanup + the consumer's long-running
                 Celery runner

BELONGS HERE: consumption of the NATS spine and the idempotency that makes a
redelivered event safe.

It reads ``sops``, ``triggers`` and ``instances`` and is read by none of them —
this package is a leaf in the other direction, an entry point rather than a
dependency. The one apparent exception is ``triggers.service.SimulatorService``,
which imports ``engine``'s match-and-create helpers INSIDE the method so a dry run
cannot drift from the live path; keeping that import lazy is what keeps the module
graph acyclic.

DOES NOT BELONG HERE: the matcher (``core.matching``, shared with the simulator),
and CRUD over what is being matched (``triggers``).
"""
