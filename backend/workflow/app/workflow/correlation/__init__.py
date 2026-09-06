"""Correlation — the live event→incident consumer.

    models.py    correlation_dedup (the firing idempotency slots)
    engine.py    the JetStream durable: match triggers / alert formats → create
                 incidents
    jobs.py      the dedup-slot expiry cleanup + the consumer's long-running
                 Celery runner

Belongs here: consumption of the NATS spine, and the idempotency that makes a
redelivered event safe.

It reads ``sops``, ``triggers`` and ``instances`` and none of them read it — an
entry point, not a dependency. ``triggers.service.SimulatorService`` imports
``engine``'s helpers inside a method; keeping that import lazy is what keeps the
module graph acyclic.

Does not belong here: the matcher (``core.matching``) and CRUD over what is being
matched (``triggers``).
"""
