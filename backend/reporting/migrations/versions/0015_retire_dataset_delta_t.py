"""reporting: retire the dataset `delta_t` measure — the registry owns ΔT now

Revision ID: 0015_retire_dataset_delta_t
Revises: 0014_metric_registry
Create Date: 2026-09-01

WHY THIS ROW GOES
-----------------
Migration 0009 put chiller ΔT into the DATASET registry as a derived measure —
`avg(OWT) − avg(IWT)` via `difference`/`where` — and 0014 restated the same
quantity as the first METRIC registry row (`chiller_delta_t` v1: `owt − iwt`
over confirmed point roles, guarded by units_confirmed/same_unit/non_frozen).

Two definitions of one number is exactly the drift this platform's contracts
exist to prevent. §20 proved fixture parity between the two paths to 1e-12 and
deliberately deferred the swap; §21 records the re-verification on the LIVE
confirmed roles (diff 3.6e-15 over the same 24h window) and the display swap
(`DeltaT.tsx` now reads `/bi/metrics/evaluate`). With the display path moved,
the dataset measure computes nothing anybody renders — it is dead code in data
form, and a dead definition left in place is a future disagreement waiting for
its first caller. Checked before removal: no saved `dashboard_widgets` and no
`dashboard_versions` snapshot references `delta_t`, so nothing goes blank.

WHAT STAYS
----------
The MECHANISM — `difference` / `where` in the physical-aggregate vocabulary and
`sqlgen` — is domain-agnostic and untouched; the next derived dataset measure
is still an INSERT. Only the domain-specific ROW is removed, the same shape it
arrived in. The registry metric also gains nothing here: this migration only
deletes.

The downgrade reinstates the 0009 row verbatim (copied below rather than
imported, so this file stays self-contained the way alembic loads it).
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0015_retire_dataset_delta_t"
down_revision = "0014_metric_registry"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Same statement 0009's downgrade used: filter the measure out of the
    # dataset definition. Idempotent — a definition without the key is left as
    # it is.
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


# ── the 0009 row, verbatim, for the downgrade ────────────────────────────────

_LEAVING = "OWT"
_ENTERING = "IWT"


def _side(tag: str, fn: str, column: str) -> dict:
    return {
        "fn": fn,
        "column": column,
        "where": {"dimension": "point_tag", "equals": tag},
    }


def _ratio_side(tag: str) -> dict:
    return {
        "fn": "ratio",
        "numerator": {"fn": "sum", "column": "num_sum"},
        "denominator": {"fn": "sum", "column": "num_count"},
        "where": {"dimension": "point_tag", "equals": tag},
    }


_DELTA_T_MEASURE = {
    "key": "delta_t",
    "label": "ΔT (leaving − entering)",
    "type": "number",
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
                "left": _side(_LEAVING, "avg", "num"),
                "right": _side(_ENTERING, "avg", "num"),
            },
            "last": {
                "fn": "difference",
                "left": _side(_LEAVING, "last", "num"),
                "right": _side(_ENTERING, "last", "num"),
            },
        },
        "1m": {
            "avg": {
                "fn": "difference",
                "left": _ratio_side(_LEAVING),
                "right": _ratio_side(_ENTERING),
            },
            "last": {
                "fn": "difference",
                "left": _side(_LEAVING, "last", "num_last"),
                "right": _side(_ENTERING, "last", "num_last"),
            },
        },
        "1h": {
            "avg": {
                "fn": "difference",
                "left": _ratio_side(_LEAVING),
                "right": _ratio_side(_ENTERING),
            },
            "last": {
                "fn": "difference",
                "left": _side(_LEAVING, "last", "num_last"),
                "right": _side(_ENTERING, "last", "num_last"),
            },
        },
    },
}


def downgrade() -> None:
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
            m=json.dumps([_DELTA_T_MEASURE]),
            probe=json.dumps([{"key": "delta_t"}]),
        )
    )
