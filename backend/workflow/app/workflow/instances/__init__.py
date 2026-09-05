"""Incidents — a SOP in motion.

    models.py    workflow_instances
    schemas.py   request / response bodies + the stats strip
    service.py   InstanceService (create, transition, assign, escalate, stats)
    router.py    /workflow/instances
    pdf.py       the incident report export
    jobs.py      the escalation + timeout sweeps (worker beat)

BELONGS HERE: everything that happens to an incident after it exists, whether an
operator drives it (``service``) or the clock does (``jobs``). Those two are
deliberately in the same package: an SLA breach and a manual status change move
the same state machine, and separating them is how the rules drift apart.

This is the one feature that reads across others — it needs the ``sops`` graph it
is executing, the ``forms`` validator for data captured on a transition, and the
``notifications`` outbox to write into. That direction is one-way; nothing here
may be imported BY those packages.
"""
