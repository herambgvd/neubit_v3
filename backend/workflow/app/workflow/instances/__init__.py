"""Incidents — a SOP in motion.

    models.py    workflow_instances
    schemas.py   request / response bodies + the stats strip
    service.py   InstanceService (create, transition, assign, escalate, stats)
    router.py    /workflow/instances
    pdf.py       the incident report export
    jobs.py      the escalation + timeout sweeps (worker beat)

Belongs here: everything that happens to an incident after it exists, whether an
operator drives it (``service``) or the clock does (``jobs``). Same package,
because an SLA breach and a manual status change move the same state machine.

This is the one feature that reads across others — the ``sops`` graph it executes,
the ``forms`` validator, the ``notifications`` outbox. One-way: nothing here may be
imported BY those packages.
"""
