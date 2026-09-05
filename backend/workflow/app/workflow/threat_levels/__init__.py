"""Threat levels — the deployment / site threat-posture register.

    models.py    threat_levels
    schemas.py   request / response bodies
    service.py   ThreatLevelService
    router.py    /workflow/threat-levels

BELONGS HERE: the posture itself and its change history.

Small, and deliberately its own package rather than a corner of ``triggers``:
posture is operator-SET state with its own permissions and its own record, and
the fact that the correlation engine can match on a posture change no more makes
it a trigger than a camera is an alarm.
"""
