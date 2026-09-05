"""Workflow core — the vocabulary and pure rules every feature shares.

This package is the LEAF of the internal dependency graph. It imports nothing from
a feature package (``sops``, ``triggers``, ``instances``, ``forms``,
``notifications``, ``threat_levels``, ``correlation``) and nothing from
``app.db``; features import it. That direction is the whole point — it is what
stops a "shared" bucket from growing back into the flat module this package
replaced, where a helper could reach sideways into any feature it liked.

What belongs here:
  * ``primitives`` — the two column-default callables every table uses.
  * ``enums``      — the literal types that appear in DB columns AND in request /
    response bodies, plus the pure rules defined over them (status-machine
    legality, priority ordering).
  * ``mixins``     — the ORM column mixin shared by every tenant-scoped table.
  * ``matching``   — trigger-condition evaluation. Ported verbatim from
    neubit_v2's ``module/correlation/matcher.py``: the operator set is part of the
    trigger contract and must not drift.

What does NOT belong here: anything that touches a session, a model, a connector
or an HTTP request; anything only one feature uses (put it in that feature);
anything that would need to import a feature to work.

Nothing is re-exported from this ``__init__``. Import the module you mean
(``from ..core.enums import InstanceStatus``) so a reader can see which of the
four kinds of thing a symbol is.
"""
