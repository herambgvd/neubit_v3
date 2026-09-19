"""reporting: the equipment registry's read-model, and the metrics that read it

Revision ID: 0026_equipment_registry
Revises: 0025_correlation_registry
Create Date: 2026-09-19

WHAT THIS CLOSES
----------------
`chw_delta_t_in_band` v1 (0019) grades every chiller in every building against
one band, `in_band(abs(owt − iwt), 5, 7)`. The 5–7 K is the CCEI spec's §4.1
figure and it is cited, but it is a LITERAL: a 1,000 TR centrifugal selected for
a 7.5 K design ΔT and a 60 TR scroll selected for 4.5 K are graded against the
same two numbers, and the one that is running exactly as designed can score 0%.

The fact that answers it is the chiller's own design band, and it now exists:
core's equipment registry (`app/sites/infrastructure`, core migration 0032)
records `design_dt_min` / `design_dt_max` on a chiller, in K, typed by an
operator or read from an equipment schedule. This revision gives the reporting
store a read-model of that registry and re-versions the metric to read it.

THE READ-MODEL — three tables, one per core table
-------------------------------------------------
    site_systems            a loop / fleet / chain on a site
    site_equipment          a piece of equipment, with `design` (nameplate facts
                            AS STATED) and `design_units` (the unit each numeric
                            fact was stated in — published by core, never assumed)
    equipment_point_slots   a named slot, bound by `device_tag` + `point_tag` or
                            not bound at all

Fed by `reading-writer`'s `app/equipment_sync.py`, a durable consumer on the
EVENTS stream, exactly as `site_facts` is fed by `site_facts_sync` (0012/0013):
core owns the registry and is its only writer; this is a local copy so BI can
join a design fact to a reading without opening a database it is banned from
opening (contract §1). Every row is keyed on the tenant.

What the slot tables do NOT hold is a point id. Which `points` row a tag pair
means is a question about a WINDOW — a gateway rebuild mints a new generation of
ids under the same tags, and on this deployment 45 tag pairs have two live
generations right now — so it is answered at read time by
`app/metric_registry/slots.py`, over actual readings, and never stored.

THE METRIC ROWS — versions are rows, never edits
------------------------------------------------
    chw_delta_t           v1   equipment scope, chiller. owt − iwt over the
                               chiller's own chws / chwr SLOTS. The ΔT a plant
                               schematic draws beside the chiller.
    chw_delta_t_in_band   v2   equipment scope, chiller. The same per-bucket band
                               occupancy as v1, with the band read OFF THE
                               CHILLER: in_band(abs(owt − iwt), dt_min, dt_max).
                               v1 stays and keeps answering for every window that
                               ended before this revision ran.
    chiller_kw_per_tr     v1   equipment scope, chiller. Input power over the
                               cooling the chiller's own load signal says it is
                               delivering. The formula and every assumption in it
                               are stated in the row — see below.

A CHILLER WITH NO RECORDED BAND REFUSES. There is no fallback to 5–7: falling
back would be the literal again, silently, on exactly the machines nobody has
described yet, and the screen could not tell a graded chiller from a guessed
one. The refusal names the missing fact and where it is recorded.

THIS CHANGES WHAT THE CCEI's EEI SCORES
---------------------------------------
`eei` names `chw_delta_t_in_band` as a component. From this revision on, for a
window ending after it, that component is graded against each chiller's design
band rather than the spec's 5–7 K — a methodology change, not a refactor — and
on an estate whose chillers are not yet in the registry it REFUSES where v1
computed. Both are the point: the old number was a literal applied to machines
it may not describe. Recorded here so nobody discovers it from a changed dash.

`chiller_kw_per_tr` is NOT `plant_kw_per_tr`. The CCEI leaf is PLANT efficiency
— chillers, pumps and towers over plant cooling — and ccei_spec's `blocked_by`
for it (no chilled-water flow signal) is still true. This row is one chiller's
own ratio and is not wired into any composite.

THE FROZEN-SEED RULE (0025's note, applied)
-------------------------------------------
The bodies are literals HERE and this revision imports nothing from the
application. `_SEEDS` pins the (key, version) pairs; `_check()` asserts the
bodies and the pin agree at import. `tests/test_equipment_metrics.py` runs the
registry's own type-checker over `_ROWS`, so a body that cannot type-check fails
in review rather than as a metric that refuses everything.
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0026_equipment_registry"
down_revision = "0025_correlation_registry"
branch_labels = None
depends_on = None

_SEEDED_BY = "platform via migration 0026"

# THE ROWS THIS REVISION OWNS, PINNED — (key, version).
_SEEDS = (
    ("chw_delta_t", 1),
    ("chw_delta_t_in_band", 2),
    ("chiller_kw_per_tr", 1),
)

_CHILLER = {"scope": "equipment", "equipment_class": "chiller"}

# A slot input binds a point through the equipment's own slot, never through a
# role on a device. `chws` is the water LEAVING the evaporator — the supply —
# which is why it is `owt`, matching core's vocabulary (chws → outlet_water_temp).
_OWT = {"source": "slot", "slot": "chws", "dimension": "temperature", "aggregation": "avg"}
_IWT = {"source": "slot", "slot": "chwr", "dimension": "temperature", "aggregation": "avg"}

_ROWS: tuple[dict, ...] = (
    {
        "key": "chw_delta_t",
        "version": 1,
        "kind": "formula",
        "applies_to": _CHILLER,
        "inputs": {"owt": _OWT, "iwt": _IWT},
        "formula": "owt - iwt",
        "components": None,
        "output": {"dimension": "temperature_delta"},
        "guards": ["units_confirmed", "same_unit", "non_frozen"],
        "display": {
            "label": "Chilled-water ΔT",
            "precision": 1,
            "description": (
                "Leaving minus entering chilled-water temperature (chws − chwr) "
                "over the window, read from the chiller's own slots. Negative for a "
                "chiller that is cooling; a ΔT near zero is the fault being looked "
                "for, so a frozen or silent side is a refusal, never 0.0."
            ),
        },
    },
    {
        "key": "chw_delta_t_in_band",
        "version": 2,
        "kind": "occupancy",
        "applies_to": _CHILLER,
        "inputs": {
            "owt": _OWT,
            "iwt": _IWT,
            # The band, OFF THE EQUIPMENT. In K on core's side, and the input
            # declares the dimension it must be — a temperature DIFFERENCE — so a
            # fact stated in any other unit refuses rather than being read as K.
            "dt_min": {"source": "equipment_fact", "fact": "design_dt_min",
                       "dimension": "temperature_delta"},
            "dt_max": {"source": "equipment_fact", "fact": "design_dt_max",
                       "dimension": "temperature_delta"},
        },
        "formula": "in_band(abs(owt - iwt), dt_min, dt_max)",
        "components": None,
        "output": {"dimension": "dimensionless"},
        "guards": ["units_confirmed", "same_unit", "non_frozen"],
        "display": {
            "label": "Chilled-water ΔT in the chiller's design band (%)",
            "precision": 1,
            "description": (
                "Share of the window in which |leaving − entering| chilled-water "
                "temperature sat inside THIS chiller's recorded design ΔT band "
                "(design_dt_min … design_dt_max, K), counted per bucket (CCEI spec "
                "§3.3). Supersedes v1's fixed 5–7 K. A chiller with no recorded "
                "band refuses — it is never graded against a typical one."
            ),
            "supersedes": "v1: in_band(abs(owt - iwt), 5, 7) — CCEI spec v1.0 §4.1's fixed band",
        },
    },
    {
        "key": "chiller_kw_per_tr",
        "version": 1,
        "kind": "formula",
        "applies_to": _CHILLER,
        "inputs": {
            # `unit`, not `dimension`: kW/TR is a ratio of two NAMED units and a
            # watt-reading meter would make it a thousand times worse, silently.
            "kw": {"source": "slot", "slot": "kw", "unit": "kW", "aggregation": "avg"},
            # Percent, confirmed as `%` by an operator. A point confirmed as a
            # 0–1 fraction (unit "") refuses on the unit rather than scoring 100×
            # too efficient.
            "load": {"source": "slot", "slot": "load", "unit": "%", "aggregation": "avg"},
            "tr": {"source": "equipment_fact", "fact": "tr", "dimension": "refrigeration"},
        },
        "formula": "kw / (tr * load / 100)",
        "components": None,
        "output": {"unit": "kW/TR"},
        # No `same_unit`: kW and % are different units by construction.
        # `non_frozen` stays even though a chiller can sit at 100% load for an
        # afternoon: a frozen kW is a dead meter far more often than a steady
        # machine, and this module prefers a refusal to a plausible wrong ratio.
        "guards": ["units_confirmed", "non_frozen"],
        "display": {
            "label": "Chiller efficiency (kW/TR)",
            "precision": 2,
            "description": (
                "Average electrical input over the window divided by the cooling "
                "the chiller's own load signal says it delivered: "
                "avg(kW) ÷ (rated TR × avg(load %) ÷ 100). Lower is better."
            ),
            "assumptions": [
                "The `load` slot reports percent of the chiller's RATED COOLING "
                "CAPACITY. Some panels report percent of rated load amps (%RLA), "
                "which is a motor current, not cooling; bound to such a point this "
                "ratio is wrong and nothing here can detect it.",
                "`tr` is the nameplate rating at design conditions. Delivered "
                "capacity at 100% load drifts with condenser and leaving-water "
                "temperature, so cooling here is an ESTIMATE from the load signal, "
                "not a measurement. The measured form is CHW flow × ΔT, and the "
                "registry has no flow slot.",
                "A ratio of window averages (≈ kWh ÷ TRh when both signals report "
                "over the same buckets), not an average of instantaneous ratios, "
                "which runs to infinity as a chiller unloads.",
                "A window whose average load is zero refuses (division by zero); it "
                "is never scored as 0 or as infinitely inefficient.",
            ],
        },
    },
)


def _check() -> tuple[dict, ...]:
    """`_ROWS` and the pin agree, decided at import rather than at INSERT."""
    pinned = list(_SEEDS)
    bodies = [(r["key"], r["version"]) for r in _ROWS]
    if bodies != pinned:  # pragma: no cover — a mis-edit, caught loudly
        raise RuntimeError(
            f"0026: `_ROWS` holds {bodies} but `_SEEDS` pins {pinned}. Every row "
            f"this revision inserts must be claimed by the pin, or its downgrade "
            f"leaves rows behind."
        )
    return _ROWS


# At IMPORT, not only at upgrade: alembic imports every revision to build its
# graph, and the suite loads this file, so a mis-pinned row fails there first.
_check()


# The NOT EXISTS guard 0018/0019/0025 use: tenant_id IS NULL defeats the unique
# constraint (NULLs are distinct), and it makes the revision re-runnable.
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
    op.create_table(
        "site_systems",
        sa.Column("tenant_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("system_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("site_id", UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("description", sa.String(500), nullable=True),
        sa.Column("mirrored_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("ix_site_systems_site", "site_systems", ["tenant_id", "site_id"])

    op.create_table(
        "site_equipment",
        sa.Column("tenant_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("equipment_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("site_id", UUID(as_uuid=True), nullable=False),
        # No FK to site_systems — see the model: the two arrive on different
        # subjects and the equipment must not be lost to an ordering accident.
        sa.Column("system_id", UUID(as_uuid=True), nullable=False),
        sa.Column("tag", sa.String(64), nullable=False),
        sa.Column("name", sa.String(100), nullable=True),
        sa.Column("equipment_class", sa.String(32), nullable=False),
        sa.Column("design", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("design_units", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("source", sa.String(32), nullable=True),
        sa.Column("mirrored_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("ix_site_equipment_site", "site_equipment", ["tenant_id", "site_id"])
    op.create_index("ix_site_equipment_system", "site_equipment", ["tenant_id", "system_id"])

    op.create_table(
        "equipment_point_slots",
        sa.Column("tenant_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("equipment_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("slot", sa.String(32), primary_key=True),
        sa.Column("site_id", UUID(as_uuid=True), nullable=False),
        # 255 to match points.device_tag / point_tag, the columns a binding is
        # resolved against. Case and inner spaces kept exactly as core stored them.
        sa.Column("device_tag", sa.String(255), nullable=True),
        sa.Column("point_tag", sa.String(255), nullable=True),
        sa.Column("mirrored_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint(
            "(device_tag IS NULL) = (point_tag IS NULL)",
            name="ck_equipment_point_slots_binding_whole",
        ),
    )
    op.create_index(
        "ix_equipment_point_slots_binding", "equipment_point_slots",
        ["tenant_id", "device_tag", "point_tag"],
    )

    for row in _check():
        op.execute(
            _INSERT.bindparams(
                key=row["key"],
                version=row["version"],
                kind=row["kind"],
                applies_to=json.dumps(row["applies_to"]),
                inputs=json.dumps(row["inputs"]),
                formula=row["formula"],
                components=json.dumps(row["components"]) if row["components"] else None,
                output=json.dumps(row["output"]),
                guards=json.dumps(row["guards"]),
                display=json.dumps(row["display"]),
                created_by=_SEEDED_BY,
            )
        )


def downgrade() -> None:
    # Only the rows this revision added, identified by the pin AND the stamp, so a
    # tenant's own v2 of some key is never swept up with the platform's.
    for key, version in _SEEDS:
        op.execute(
            sa.text(
                "DELETE FROM metric_definitions "
                "WHERE tenant_id IS NULL AND key = :key AND version = :version "
                "AND created_by = :seeded_by"
            ).bindparams(key=key, version=version, seeded_by=_SEEDED_BY)
        )
    op.drop_index("ix_equipment_point_slots_binding", table_name="equipment_point_slots")
    op.drop_table("equipment_point_slots")
    op.drop_index("ix_site_equipment_system", table_name="site_equipment")
    op.drop_index("ix_site_equipment_site", table_name="site_equipment")
    op.drop_table("site_equipment")
    op.drop_index("ix_site_systems_site", table_name="site_systems")
    op.drop_table("site_systems")
