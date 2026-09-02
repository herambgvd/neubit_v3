"""reporting: the first CCEI leaf that this estate can actually measure

Revision ID: 0019_ccei_delta_t_occupancy
Revises: 0018_ccei_v2_spec
Create Date: 2026-09-02

Migration 0018 seeded the CCEI composites and left all fourteen component
metrics named-but-undefined, each refusing with what stood in its way. One of
those reasons has been removed: `chw_delta_t_in_band` said band occupancy
"needs a per-bucket evaluation the registry cannot express yet". It can now —
the `occupancy` kind and the `in_band(x, lo, hi)` membership function exist —
and both chilled-water temperatures are already bound to roles on every
chiller, so this leaf is defined here.

    chw_delta_t_in_band = in_band(abs(owt − iwt), 5, 7), per bucket

TWO THINGS IN THAT LINE ARE DELIBERATE.

The band is 5–7 K because §4.1 says so. The platform's own `hvac_health` v1
graded |ΔT| against 3–7 K, a band taken from general chilled-water practice
when no spec was in hand. That row is untouched — versioning is data — but
where the two disagree, the spec is the one with a citation.

`abs()` is load-bearing, not tidying. This platform defines ΔT as leaving −
entering, which is NEGATIVE for a machine that is cooling, and the spec states
its band on the magnitude. The side effect is that a chiller wired with its
sensors swapped scores the same as one wired correctly — and one on this estate
reads leaving warmer than entering. That is a real fault and deliberately not
this metric's job: a band-occupancy percentage that quietly doubled as a sign
check would answer neither question well.

The rest of the fourteen keep their reasons. The same insert guard as 0018 is
used, so this migration only adds the row 0018 did not have.

The table's own kind constraint has to widen with it. `ck_metric_defs_kind`
listed exactly `formula` and `composite`, and it did its job — the first attempt
to seed this row was refused by the DATABASE, not discovered later as a metric
nobody could evaluate. A new kind is therefore a schema change, on purpose:
adding one is a decision, not a typo in a JSON blob.
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op
from reporting.ccei_spec import LEAF_DEFINITIONS, definitions

revision = "0019_ccei_delta_t_occupancy"
down_revision = "0018_ccei_v2_spec"
branch_labels = None
depends_on = None

_SEEDED_BY = "platform (CCEI Methodology Spec v1.0) via migration 0019"

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


_KINDS = ("formula", "composite", "occupancy")


def upgrade() -> None:
    op.drop_constraint("ck_metric_defs_kind", "metric_definitions", type_="check")
    op.create_check_constraint(
        "ck_metric_defs_kind",
        "metric_definitions",
        "kind IN " + str(_KINDS),
    )
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
    # Only the leaf this migration added. 0018's composites are 0018's to remove.
    for key, d in LEAF_DEFINITIONS.items():
        op.execute(
            sa.text(
                "DELETE FROM metric_definitions "
                "WHERE tenant_id IS NULL AND key = :key AND version = :version "
                "AND created_by = :seeded_by"
            ).bindparams(key=key, version=d["version"], seeded_by=_SEEDED_BY)
        )
    # Narrow the constraint back only AFTER the rows that need the wider one are
    # gone, or the constraint would be rejected by its own table.
    op.drop_constraint("ck_metric_defs_kind", "metric_definitions", type_="check")
    op.create_check_constraint(
        "ck_metric_defs_kind",
        "metric_definitions",
        "kind IN ('formula', 'composite')",
    )
