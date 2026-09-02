"""reporting: the CCEI's carbon-intensity leaf, with its factor typed

Revision ID: 0020_ccei_carbon_intensity
Revises: 0019_ccei_delta_t_occupancy
Create Date: 2026-09-02

The second of the fourteen the estate can measure. `carbon_intensity` is CPI's
heaviest component (weight 0.50) and it said it was blocked on "the grid
emission factor as a typed input". It is typed now:

    carbon_intensity = norm_down(annualize(energy × factor ÷ area), 9.0, 20.0)

Three inputs, three different KINDS of input, and the type system is what keeps
them apart:

    energy   MEASURED — last − first over the site's confirmed kWh registers
    factor   CITED    — the `site_emission_factors` row effective at the
                        window's end, carrying the document an operator entered
    area     RECORDED — the site's gross floor area, an operator's assertion

`emission_factor` is its own DIMENSION (kg CO2 per kWh), and `energy ×
emission_factor = mass` is the only product that yields a mass on this platform.
That is deliberate: it means a factor cannot be multiplied into a tariff, added
to a mass, or averaged with a temperature, and every one of those is caught at
REGISTRATION rather than shipped as a plausible-looking number.

The factor is resolved by the same rule as a metric version and a benchmark
standard — the latest row whose effective date is not after the window. Grid
factors are republished yearly, and re-grading last year's emissions with this
year's number would be a silent restatement of history.

A missing factor refuses as `missing_factor` and says where to record one. It
does NOT fall back to a national average: an average is a defensible value, but
it is one somebody has to choose and cite, not one a metric may assume on their
behalf.
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op
from reporting.ccei_spec import definitions

revision = "0020_ccei_carbon_intensity"
down_revision = "0019_ccei_delta_t_occupancy"
branch_labels = None
depends_on = None

_SEEDED_BY = "platform (CCEI Methodology Spec v1.0) via migration 0020"
_ADDED = ("carbon_intensity",)

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
                components=json.dumps(d["components"]) if d["components"] else None,
                output=json.dumps(d["output"]),
                guards=json.dumps(d["guards"]),
                display=json.dumps(d["display"]),
                created_by=_SEEDED_BY,
            )
        )


def downgrade() -> None:
    for key in _ADDED:
        op.execute(
            sa.text(
                "DELETE FROM metric_definitions "
                "WHERE tenant_id IS NULL AND key = :key AND created_by = :seeded_by"
            ).bindparams(key=key, seeded_by=_SEEDED_BY)
        )
