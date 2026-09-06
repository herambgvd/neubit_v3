"""Threat levels — the deployment / site threat-posture register.

    models.py    threat_levels
    schemas.py   request / response bodies
    service.py   ThreatLevelService
    router.py    /workflow/threat-levels

Belongs here: the posture itself and its change history.

Its own package rather than a corner of ``triggers``: posture is operator-set state
with its own permissions and its own record. The correlation engine matching on a
posture change does not make it a trigger.
"""
