"""Dynamic forms — the field definitions captured on a transition.

    models.py      workflow_forms
    schemas.py     request / response bodies
    service.py     FormService
    router.py      /workflow/forms
    validation.py  validate_form_data — checks submitted data against a definition

Belongs here: what a form is, and whether a submission satisfies it.

Does not belong here: what is done with a valid submission — the transition that
captures it and the audit-trail entry it becomes are in ``instances``.
"""
