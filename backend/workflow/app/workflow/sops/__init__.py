"""SOPs — the incident playbook and the state machine it defines.

    models.py    sops, workflow_states, workflow_transitions
    schemas.py   request / response bodies for all three
    service.py   SopService, StateService, TransitionService
    router.py    /workflow/sops, .../{sop_id}/states, .../{sop_id}/transitions

Belongs here: the SHAPE of a playbook — its states, the edges between them, which
state is initial, what a transition requires.

Does not belong here: a RUNNING playbook. Once instantiated it is an incident and
lives in ``instances``. This package must not import ``instances``; the dependency
runs the other way.

Nothing is re-exported — importers name the module.
"""
