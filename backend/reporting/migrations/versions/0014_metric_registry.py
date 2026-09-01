"""reporting: the metric registry — derived metrics as ROWS, roles as assertions

Revision ID: 0014_metric_registry
Revises: 0013_site_inputs_mirror
Create Date: 2026-08-31

WHY A TABLE AND NOT CODE
------------------------
The first derived value this platform grew — chiller ΔT — went into the dataset
registry as a row (migration 0009), for a stated reason: an `if device_type ==
'chiller'` branch would make the NEXT derived value another branch in the one
file that must stay domain-agnostic. This migration is the same argument one
level up. A METRIC — a formula over named point roles, with unit requirements,
guards and display — is data, so a new sensor domain is an INSERT, not a
release.

`metric_definitions`
--------------------
One row per (tenant, key, VERSION). Versioning is load-bearing:

* A formula change is a NEW version with its own `effective_from`. Recomputing
  yesterday's window with today's formula is silent history rewriting, so the
  evaluator selects the version effective AT the evaluated instant and an old
  window keeps the formula it was measured under.
* `tenant_id IS NULL` marks a PLATFORM definition (seeded here); a tenant sees
  the union of platform rows and its own.

A definition is TYPE-CHECKED at registration (`app/metric_registry/registry.py`):
the formula must parse in the whitelist grammar, every name must be a declared
input, and the dimension algebra must produce the declared output — `kWh − °C`
is rejected on insert, never discovered at render. Rows seeded here passed the
same check (asserted by the package's own tests of the seed below).

`kind='composite'` is a weighted sum of other metrics' outputs — the shape a
future CCEI takes. Schema and evaluator support only; no UI yet.

`point_roles`
-------------
(tenant, point) → role, mirroring `points.unit_source` EXACTLY: a tag like
`IWT` is a naming convention, so the API only SUGGESTS `inlet_water_temp` with
the matched pattern shown, and nothing is stored until an operator confirms an
explicit list of point ids. `role_source='operator'` is the only source that
exists today; the column is there so a future machine source can never be
confused with a human's assertion. Deleting the row is the retraction, and it
is reachable (`role: null`).

THE SEED — `chiller_delta_t` v1
-------------------------------
The hardcoded ΔT (dataset measure `delta_t`, migration 0009; displayed by
`features/bi/components/DeltaT.tsx`) restated as the first registry row:
`owt − iwt` over roles outlet/inlet_water_temp, output temperature_delta,
guarded by units_confirmed + same_unit + non_frozen. With 0 units confirmed and
0 roles confirmed its honest state on this deployment is BLOCKED everywhere —
that is correct, not a defect. The display path is untouched; swapping it onto
the registry happens after the portfolio work lands.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0014_metric_registry"
down_revision = "0013_site_inputs_mirror"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "metric_definitions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        # NULL = a platform definition, visible to every tenant.
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=True),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("version", sa.Integer, nullable=False),
        # The instant this version starts answering for. The evaluator picks
        # the latest version with effective_from <= the evaluated time.
        sa.Column("effective_from", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("kind", sa.String(16), nullable=False, server_default="formula"),
        # {"scope": "device"|"site", "category": ..., "device_type": ...}
        sa.Column("applies_to", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        # input name → {"role": ..., "dimension"|"unit": ..., "aggregation": ...}
        sa.Column("inputs", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        # kind=formula: the whitelist-grammar expression over the input names.
        sa.Column("formula", sa.Text, nullable=True),
        # kind=composite: [{"metric": key, "weight": number}, ...]
        sa.Column("components", JSONB, nullable=True),
        # {"dimension": ...} or {"unit": ...} — what the formula must type to.
        sa.Column("output", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        # ["units_confirmed", "same_unit", "non_frozen", ...] — each mechanized
        # in the evaluator; a failed guard is a structured refusal, never a 0.
        sa.Column("guards", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        # {"label": ..., "description": ..., "precision": n}
        sa.Column("display", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_by", sa.String(320), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.UniqueConstraint("tenant_id", "key", "version", name="uq_metric_defs_key_version"),
        sa.CheckConstraint("kind IN ('formula', 'composite')", name="ck_metric_defs_kind"),
    )
    op.create_index("ix_metric_defs_key", "metric_definitions", ["key", "effective_from"])

    op.create_table(
        "point_roles",
        # One role per point: a point IS one thing to the registry. PK on the
        # point, tenant carried for the scoped reads every query does.
        sa.Column("point_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("role", sa.String(64), nullable=False),
        # Provenance, mirroring points.unit_source: 'operator' is the only
        # writer today, and the row's existence IS the confirmation — clearing
        # deletes it, so an unbound point has no row rather than a null role.
        sa.Column("role_source", sa.String(16), nullable=False, server_default="operator"),
        sa.Column("confirmed_by", sa.String(320), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("ix_point_roles_tenant_role", "point_roles", ["tenant_id", "role"])

    # ── Seed: chiller ΔT, restated as data ───────────────────────────────────
    op.execute(
        """
        INSERT INTO metric_definitions
            (tenant_id, key, version, effective_from, kind, applies_to, inputs,
             formula, output, guards, display, created_by)
        VALUES
            (NULL, 'chiller_delta_t', 1, now(), 'formula',
             '{"scope": "device", "device_type": "chiller"}'::jsonb,
             '{"owt": {"role": "outlet_water_temp", "dimension": "temperature", "aggregation": "avg"},
               "iwt": {"role": "inlet_water_temp",  "dimension": "temperature", "aggregation": "avg"}}'::jsonb,
             'owt - iwt',
             '{"dimension": "temperature_delta"}'::jsonb,
             '["roles_present", "units_confirmed", "same_unit", "non_frozen"]'::jsonb,
             '{"label": "Chiller ΔT", "precision": 1,
               "description": "Leaving minus entering water temperature (OWT − IWT). A ΔT near zero is the fault being looked for, so no side is ever coalesced and a frozen input renders as undefined, never 0.0."}'::jsonb,
             'migration:0014')
        """
    )


def downgrade() -> None:
    op.drop_index("ix_point_roles_tenant_role", table_name="point_roles")
    op.drop_table("point_roles")
    op.drop_index("ix_metric_defs_key", table_name="metric_definitions")
    op.drop_table("metric_definitions")
