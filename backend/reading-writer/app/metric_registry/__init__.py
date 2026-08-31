"""Metric registry — derived metrics defined as DATA, not code.

A metric is a ROW in `metric_definitions`: a formula over named inputs, each
input a POINT ROLE with unit requirements, plus guards and display. A new
sensor domain therefore becomes configuration — an INSERT — instead of a branch
in an evaluator that has to stay domain-agnostic (the same argument the
dashboard contract §11 makes for the dataset registry's `difference`).

The package:

* ``units``      the dimension table and the algebra over it. A spec that does
                 not type-check (kWh − °C) is rejected at REGISTRATION, never
                 discovered at render.
* ``expr``       the safe expression language. `ast`-parsed with a strict node
                 whitelist; literals, input names, + − × ÷, parentheses, and a
                 tiny function set. Never `eval` on a raw string.
* ``registry``   read/write over `metric_definitions`. Versioned: a formula
                 change is a NEW version with its own `effective_from`, because
                 recomputing yesterday with today's formula is silent history
                 rewriting. The evaluator picks the version effective at the
                 evaluated time.
* ``roles``      point → role, with the same suggestion-vs-assertion split as
                 units: a tag like `IWT` SUGGESTS `inlet_water_temp`, labelled
                 with the matched pattern; only an operator stores one.
* ``evaluator``  computes a metric over the rollups (never raw), with every
                 guard failure a STRUCTURED ABSENCE — `{status, reason}` —
                 never a zero, never a null that renders as one.
"""
