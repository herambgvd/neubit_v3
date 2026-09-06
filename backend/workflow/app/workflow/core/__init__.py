"""Workflow core — the vocabulary and pure rules every feature shares.

The leaf of the internal dependency graph: imports no feature package and not even
``app.db``. Features import it, never the other way round.

  * ``primitives`` — the two column-default callables every table uses.
  * ``enums``      — literals that appear in DB columns and in request/response
    bodies, plus the pure rules over them.
  * ``mixins``     — the ORM column mixin every tenant-scoped table carries.
  * ``matching``   — trigger-condition evaluation.
  * ``references`` — service-side mixin checking a field that names another
    tenant-owned row.

Does not belong here: anything owning a session, model, connector or HTTP request;
anything only one feature uses; anything that would need to import a feature.

Nothing is re-exported — import the module you mean.
"""
