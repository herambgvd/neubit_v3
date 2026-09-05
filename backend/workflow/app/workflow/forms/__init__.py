"""Dynamic forms — the field definitions captured on a transition.

    models.py      workflow_forms
    schemas.py     request / response bodies
    service.py     FormService
    router.py      /workflow/forms
    validation.py  validate_form_data — checks submitted data against a definition

BELONGS HERE: what a form IS and whether a submission satisfies it.

DOES NOT BELONG HERE: what is done with a valid submission. The transition that
captures it, and the audit-trail entry it becomes, are in ``instances``.
"""
