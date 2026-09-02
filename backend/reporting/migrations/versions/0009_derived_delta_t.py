"""reporting: the first DERIVED measure — chiller ΔT, computed, never stored

Revision ID: 0009_derived_delta_t
Revises: 0008_points_spatial
Create Date: 2026-08-31

WHAT WAS MISSING
----------------
Every number Building Intelligence could show was a function of ONE series. That
is the whole of what a meter reports and almost none of what a building engineer
asks. "Low ΔT syndrome" — a chiller drawing full power while the water it returns
is barely warmer than the water it took in — is the headline diagnosis on this
product's own mockup, and it is a function of TWO points on one device:

    ΔT = leaving water temperature (OWT) − entering water temperature (IWT)

Both points exist and both have been reporting for the life of this store. There
was simply no way to express a value that reads two of them.

WHERE A DERIVED VALUE LIVES, AND WHERE IT MUST NOT
---------------------------------------------------
**Not in `readings`.** A derived value written back as a row is a second copy of a
number that can be wrong in a second way, it ages silently the moment the formula
is corrected, and it inflates the fact table with something no device measured.
Nothing here writes anything.

**Not in the executor.** A `if device_type == 'chiller'` branch in `sqlgen.py`
would make ΔT work and make the NEXT derived value — a pressure drop, a cooling
tower approach, a power factor from kW and kVA — another branch. Building
Intelligence would accumulate a pile of special cases in the one file that must
stay domain-agnostic.

**In the REGISTRY, as data**, which is where every other "what can be charted"
decision on this platform already lives (builder contract §2). Two additions to
the physical-aggregate vocabulary carry it, and both are closed forms rather than
SQL fragments:

  * `where: {dimension, equals}` — restrict an aggregate to the rows where a
    registry DIMENSION equals a value. It generates `FILTER (WHERE …)` with the
    dimension resolved through the registry and the value BOUND.
  * `difference: {left, right}` — one aggregate minus another, over the same rows.

So the MECHANISM is domain-agnostic and the ROW below is domain-specific. The next
derived value is an INSERT.

THREE HONESTY CONSTRAINTS THIS MEASURE HAD TO MEET
---------------------------------------------------
**1. Only LINEAR aggregates may be differenced.** `avg(OWT) − avg(IWT)` is the
mean difference, because the mean is linear. `min(OWT) − min(IWT)` is NOT the
minimum difference — the two minima can fall in different samples, and the number
that comes out is a subtraction of two unrelated instants. So this measure offers
`avg` and `last` and deliberately not `min`, `max` or `sum`. The registry model
cannot check this (it does not know what a measure means); the reviewer of the row
is the check, and that is why it is written down here.

**2. Absence must propagate.** A bucket where the chiller reported IWT and not
OWT has NO measured ΔT. SQL arithmetic with NULL is NULL, so that falls out for
free — and it is the reason neither side is wrapped in a `coalesce`. A zero would
be a number nobody measured, and on this metric a zero is not neutral: ΔT ≈ 0 IS
the fault being looked for, so a fabricated zero would read as a critical
diagnosis.

**3. It is NOT comparable across devices.** Not because a temperature difference
is meaningless between chillers — it is perfectly meaningful — but because
`points.unit` is empty for every point on this deployment (contract §11/§12) and
nothing on the wire says these two tags are degrees of anything. So it carries the
same rule the raw reading value carries: pin it to one chiller (group by, split
by, or filter to a device) before aggregating. That refusal names what to do, as
the raw value's does.

WHAT THIS DOES NOT CLAIM
------------------------
No design ΔT, no "low ΔT" threshold, no flag, no severity, no rupee impact. The
mockup states "1.8°C vs 5–7°C design"; the design figure is a property of the
chiller that exists in nobody's database here, and a threshold invented to make a
row turn red is the exact failure this contract exists to prevent. The measure
computes ΔT. A person reads it.
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0009_derived_delta_t"
down_revision = "0008_points_spatial"
branch_labels = None
depends_on = None


# The two series, by the tag the gateway publishes them under. These strings are
# the domain-specific half of this change and they are DATA: correcting a site
# that spells them differently is an UPDATE to this row, not a release.
LEAVING = "OWT"   # leaving / supply chilled water
ENTERING = "IWT"  # entering / return chilled water


def _side(tag: str, fn: str, column: str) -> dict:
    """One side of the difference: an aggregate restricted to one point tag.

    `where` sits on the OUTER node so a `ratio` states its filter once and both
    halves inherit it — see `registry.PhysicalAgg`.
    """
    return {
        "fn": fn,
        "column": column,
        "where": {"dimension": "point_tag", "equals": tag},
    }


def _ratio_side(tag: str) -> dict:
    """The rollup's weighted mean for one side.

    `sum(num_sum) / sum(num_count)`, not `avg(num_avg)`: averaging bucket averages
    weights a bucket holding two samples the same as one holding sixty, which on a
    feed whose devices report at different rates is simply the wrong number. Same
    reasoning as the `value` measure's `avg`; the filter is the only difference.
    """
    return {
        "fn": "ratio",
        "numerator": {"fn": "sum", "column": "num_sum"},
        "denominator": {"fn": "sum", "column": "num_count"},
        "where": {"dimension": "point_tag", "equals": tag},
    }


DELTA_T_MEASURE = {
    "key": "delta_t",
    "label": "ΔT (leaving − entering)",
    "type": "number",
    # LINEAR aggregates only. See the module docstring: min/max/sum of a
    # difference are not the difference of the min/max/sum.
    "aggregates": ["avg", "last"],
    "description": (
        "Chilled-water temperature difference across a device: the OWT point "
        "minus the IWT point, computed at query time from the readings already "
        "stored. A device that publishes only one of the two, or neither, has no "
        "ΔT and returns nothing rather than zero — which matters here, because a "
        "ΔT near zero is itself the fault. No design target, threshold or "
        "severity is applied: nothing on this platform knows what this chiller "
        "was specified for."
    ),
    # No unit, and there cannot be one: `points.unit` is empty for every point
    # because the source payloads carry none. A "°C" here would be this console
    # asserting something the wire never said.
    "comparable": False,
    "comparable_within": ["device_id", "device_tag"],
    "incomparable_hint": (
        "a ΔT belongs to one machine, and no unit is on the wire, so averaging "
        "across chillers would combine numbers that may not even be the same "
        "quantity."
    ),
    "physical": {
        "raw": {
            "avg": {
                "fn": "difference",
                "left": _side(LEAVING, "avg", "num"),
                "right": _side(ENTERING, "avg", "num"),
            },
            "last": {
                "fn": "difference",
                "left": _side(LEAVING, "last", "num"),
                "right": _side(ENTERING, "last", "num"),
            },
        },
        "1m": {
            "avg": {
                "fn": "difference",
                "left": _ratio_side(LEAVING),
                "right": _ratio_side(ENTERING),
            },
            "last": {
                "fn": "difference",
                "left": _side(LEAVING, "last", "num_last"),
                "right": _side(ENTERING, "last", "num_last"),
            },
        },
        "1h": {
            "avg": {
                "fn": "difference",
                "left": _ratio_side(LEAVING),
                "right": _ratio_side(ENTERING),
            },
            "last": {
                "fn": "difference",
                "left": _side(LEAVING, "last", "num_last"),
                "right": _side(ENTERING, "last", "num_last"),
            },
        },
    },
}


def upgrade() -> None:
    # Appended, with an idempotence guard, for the same reason 0008 appended its
    # dimensions: the definition is DATA and reprinting it would revert anything
    # else that had touched it.
    op.execute(
        sa.text(
            """
            UPDATE dashboard_datasets
               SET definition = jsonb_set(
                       definition, '{measures}',
                       (definition->'measures') || CAST(:m AS jsonb)),
                   updated_at = now()
             WHERE key = 'iot_readings'
               AND NOT (definition->'measures' @> CAST(:probe AS jsonb))
            """
        ).bindparams(
            m=json.dumps([DELTA_T_MEASURE]),
            probe=json.dumps([{"key": "delta_t"}]),
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE dashboard_datasets
               SET definition = jsonb_set(
                       definition, '{measures}',
                       (SELECT coalesce(jsonb_agg(m), '[]'::jsonb)
                          FROM jsonb_array_elements(definition->'measures') m
                         WHERE m->>'key' <> 'delta_t')),
                   updated_at = now()
             WHERE key = 'iot_readings'
            """
        )
    )
