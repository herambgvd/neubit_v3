"""SOPs — the incident playbook and the state machine it defines.

    models.py    sops, workflow_states, workflow_transitions
    schemas.py   request / response bodies for all three
    service.py   SopService, StateService, TransitionService
    router.py    /workflow/sops, .../{sop_id}/states, .../{sop_id}/transitions

BELONGS HERE: anything about the SHAPE of a playbook — its states, the edges
between them, which state is initial, what a transition requires before it may be
taken.

DOES NOT BELONG HERE: a RUNNING playbook. The moment a SOP is instantiated it is
an incident and lives in ``instances``. This package must not import ``instances``
— the dependency runs the other way, and a cycle here is the first step back to
one flat directory.

Nothing is re-exported: importers name the module (``from ..sops.models import
SOP``), so a reader can tell a table from a schema from a service at the import
line.
"""
