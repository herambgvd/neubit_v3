"""Triggers and alert formats — how an incoming event becomes an incident.

    models.py    workflow_triggers, alert_formats
    schemas.py   request / response bodies, incl. the simulator's report
    service.py   TriggerService, AlertFormatService, SimulatorService
    router.py    /workflow/triggers, /workflow/alert-formats, /workflow/events

BELONGS HERE: the MATCHING side of the engine — which events fire what, keyed by
event type + conditions (a trigger) or by alert code (an alert format), and the
dry-run simulator that reports what both would do.

Two tables share this package because they answer the same question and the
correlation engine consults them together on every message; a change to one is
almost always a change to the other.

DOES NOT BELONG HERE: the matcher itself (``core.matching`` — the correlation
engine needs it too, and its operator set is a frozen contract), and the
consumption of live events (``correlation``, which subscribes and creates rows;
this package only stores what to look for).
"""
