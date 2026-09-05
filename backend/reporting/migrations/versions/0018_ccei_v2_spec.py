"""reporting: CCEI v2 — the methodology spec replaces an invented definition

Revision ID: 0018_ccei_v2_spec
Revises: 0017_bee_jan2022_revision
Create Date: 2026-09-02

WHAT THIS CORRECTS
------------------
`ccei` v1 was registered live as `0.6 × intensity_score + 0.4 × hvac_health`.
That definition was DESIGNED, not sourced — the contract says so in as many
words — and it was designed because no authoritative definition had been found.
One exists:

    NEUBIT, "Command & Control Efficiency Index (CCEI) — Methodology
    Specification: Metric Definitions & Normalization Math", Version 1.0.

It defines something quite different:

    CCEI = 0.35·EEI + 0.25·OPI + 0.20·CPI + 0.20·CCI

over four sub-indices and fourteen component metrics, each with a direction, a
target, a floor or worst value, a weight and a named source. Two components of
the invented v1 are not two of the fourteen; the shapes do not overlap. So this
is not a tweak, it is a replacement, and it enters the way every definition
change enters here: as a NEW VERSION. v1 is untouched. A window already measured
under v1 keeps v1's arithmetic, because the evaluator selects the version whose
`effective_from` is latest among those ≤ the evaluated instant, and rewriting
history silently is the failure this table was shaped to prevent.

v2 is a PLATFORM definition (`tenant_id IS NULL`). The CCEI is a product
definition, not one tenant's opinion; the tenant-scoped v1 row stays exactly
where it is.

WHAT THIS SEEDS, AND WHAT IT DELIBERATELY DOES NOT
---------------------------------------------------
Five composite rows: `ccei` v2 over `eei`/`opi`/`cpi`/`cci` v1, each of those
over its own component keys at the spec's weights. The fourteen LEAVES are named
in their parent's component list and left undefined — see `reporting.ccei_spec`
for the per-leaf reason, which is the whole point of this migration.

The honest consequence, today, on this estate: `ccei` evaluates to a REFUSAL on
every site, and the refusal enumerates all fourteen missing components with
their weights. That is strictly more true than v1, which also refused, but
refused about the wrong two things.

A leaf becomes a row when the estate can measure it. Four of them additionally
need a band-OCCUPANCY aggregation (spec §3.3) that the evaluator does not have
yet; the normalization functions those leaves will use — `norm_up`/`norm_down`,
spec §3.1/§3.2 — already exist in the expression language and are tested against
the spec's own worked example.
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op
from reporting.ccei_spec import definitions

revision = "0018_ccei_v2_spec"
down_revision = "0017_bee_jan2022_revision"
branch_labels = None
depends_on = None

_SEEDED_BY = "platform (CCEI Methodology Spec v1.0) via migration 0018"

# tenant_id IS NULL means the unique constraint cannot help us — Postgres treats
# NULLs as distinct, so ON CONFLICT never fires on a platform row. The guard is
# an explicit NOT EXISTS, which also makes the migration re-runnable.
_INSERT = sa.text(
    """
    INSERT INTO metric_definitions
        (tenant_id, key, version, kind, applies_to, inputs, formula,
         components, output, guards, display, created_by)
    SELECT NULL, :key, :version, :kind,
           CAST(:applies_to AS jsonb), CAST(:inputs AS jsonb), :formula,
           CAST(:components AS jsonb), CAST(:output AS jsonb),
           CAST(:guards AS jsonb), CAST(:display AS jsonb), :created_by
     WHERE NOT EXISTS (
         SELECT 1 FROM metric_definitions
          WHERE tenant_id IS NULL AND key = :key AND version = :version
     )
    """
)


def upgrade() -> None:
    for d in definitions():
        op.execute(
            _INSERT.bindparams(
                key=d["key"],
                version=d["version"],
                kind=d["kind"],
                applies_to=json.dumps(d["applies_to"]),
                inputs=json.dumps(d["inputs"]),
                formula=d["formula"],
                components=json.dumps(d["components"]),
                output=json.dumps(d["output"]),
                guards=json.dumps(d["guards"]),
                display=json.dumps(d["display"]),
                created_by=_SEEDED_BY,
            )
        )


def downgrade() -> None:
    # Only the platform rows this migration inserted. The tenant-scoped v1 rows
    # (`ccei` v1, `intensity_score` v1, `hvac_health` v1) are an operator's
    # assertions and are never touched by a schema migration.
    for d in definitions():
        op.execute(
            sa.text(
                "DELETE FROM metric_definitions "
                "WHERE tenant_id IS NULL AND key = :key AND version = :version "
                "AND created_by = :seeded_by"
            ).bindparams(key=d["key"], version=d["version"], seeded_by=_SEEDED_BY)
        )
