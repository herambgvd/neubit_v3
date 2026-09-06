"""Triggers and alert formats — how an incoming event becomes an incident.

    models.py    workflow_triggers, alert_formats
    schemas.py   request / response bodies, incl. the simulator's report
    service.py   TriggerService, AlertFormatService, SimulatorService
    router.py    /workflow/triggers, /workflow/alert-formats, /workflow/events

Belongs here: the MATCHING side — which events fire what, keyed by event type plus
conditions (a trigger) or by alert code (an alert format), and the dry-run
simulator over both.

The two tables share a package because the correlation engine consults them
together on every message.

Does not belong here: the matcher itself (``core.matching``, also used by the
engine) and the consumption of live events (``correlation``). This package only
stores what to look for.
"""
