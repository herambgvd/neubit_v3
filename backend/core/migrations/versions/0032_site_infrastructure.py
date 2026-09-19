"""sites: the EQUIPMENT REGISTRY — systems, equipment, point slots

Revision ID: 0032_site_infrastructure
Revises: 0031_placement_without_a_pin
Create Date: 2026-09-19

WHAT COULD NOT BE SAID
----------------------
Building Intelligence knew POINTS and SITES and nothing in between. It could not
say that `1FYC1_IWT`, `1FYC1_OWT` and `1FYC1_EM_kW` are the entering water, the
leaving water and the power of ONE chiller, that the chiller is rated at some
number of TR, or that it was designed for some ΔT band. So:

  * the ΔT band is a literal in a formula string (`in_band(abs(owt - iwt), 5, 7)`
    in `neubit_reporting.metric_definitions`) — the same band for every chiller in
    every building, whatever its nameplate says;
  * kW/TR cannot be computed at all, because nothing states a chiller's TR;
  * no plant schematic can be drawn, because nothing states which chillers, towers
    and pumps form which loop.

Three tables, beside the sites that own them:

  * `site_systems`          — a loop / fleet / chain on a site, of a closed kind;
  * `site_equipment`        — a unit in a system, of a closed class, with a
    `design` object of nameplate facts;
  * `equipment_point_slots` — a named slot on a unit, optionally bound to a point
    by the gateway's `device_tag` + `point_tag`.

BOUND BY TAG, NOT BY POINT ID
-----------------------------
The gateway on this estate re-keys every point id when it rebuilds a connection.
On 11 Sept that orphaned every metric-role binding held by uuid, silently. The
tag pair is what the gateway is configured with and survives the rebuild, so it is
the binding; a consumer resolves it to the live point at read time. The unique
constraint on `(tenant_id, device_tag, point_tag)` stops one point feeding two
slots — a kW point on two chillers is plant kW counted twice.

DDL IS WRITTEN OUT
------------------
Nothing here imports `app.*`. A migration that imports a model runs against
whatever that model has become by the time it is run, and reporting 0018–0020
shows what that costs. The columns below are this revision's, forever.

Primary and foreign keys take Postgres's default names, because a FRESH database
never runs this file: `migrate.sh` builds it from the ORM (0001's create_all) and
stamps head, and the ORM leaves those names to Postgres. Naming them here would
give the two paths two schemas. The unique and check constraints are named in
both places, identically.

`site_equipment.design` is JSON NOT NULL DEFAULT '{}' rather than nullable: a
nullable JSON column takes a python None as the JSON scalar `null`, which no
`IS NULL` sees (0031's lesson), and an empty object is one spelling of "no facts
recorded" where nullable would allow three.

THESE TABLES SHIP EMPTY. No seed plant, no default TR, no typical ΔT band.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0032_site_infrastructure"
down_revision = "0031_placement_without_a_pin"
branch_labels = None
depends_on = None


def _audit_columns() -> list[sa.Column]:
    return [
        sa.Column("created_by", sa.String(length=36), nullable=True),
        sa.Column("updated_by", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "site_systems",
        sa.Column("system_id", sa.String(length=36), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=True),
        sa.Column("site_id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        # A key of app/sites/infrastructure/vocabulary.py:SYSTEM_KINDS, checked
        # at the API. Not a CHECK here: the vocabulary grows by code review, and a
        # CHECK would turn every addition into a migration for no extra safety.
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("description", sa.String(length=500), nullable=True),
        *_audit_columns(),
        sa.PrimaryKeyConstraint("system_id"),
        sa.UniqueConstraint("site_id", "name", name="uq_site_systems_site_name"),
    )
    op.create_index("ix_site_systems_tenant_id", "site_systems", ["tenant_id"])
    op.create_index("ix_site_systems_site_id", "site_systems", ["site_id"])

    op.create_table(
        "site_equipment",
        sa.Column("equipment_id", sa.String(length=36), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=True),
        sa.Column("site_id", sa.String(length=36), nullable=False),
        sa.Column("system_id", sa.String(length=36), nullable=False),
        sa.Column("tag", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=True),
        sa.Column("equipment_class", sa.String(length=32), nullable=False),
        sa.Column("design", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        *_audit_columns(),
        sa.PrimaryKeyConstraint("equipment_id"),
        sa.ForeignKeyConstraint(
            ["system_id"], ["site_systems.system_id"], ondelete="CASCADE",
        ),
        sa.UniqueConstraint("site_id", "tag", name="uq_site_equipment_site_tag"),
    )
    op.create_index("ix_site_equipment_tenant_id", "site_equipment", ["tenant_id"])
    op.create_index("ix_site_equipment_site_id", "site_equipment", ["site_id"])
    op.create_index("ix_site_equipment_system_id", "site_equipment", ["system_id"])

    op.create_table(
        "equipment_point_slots",
        sa.Column("slot_id", sa.String(length=36), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=True),
        sa.Column("site_id", sa.String(length=36), nullable=False),
        sa.Column("equipment_id", sa.String(length=36), nullable=False),
        sa.Column("slot", sa.String(length=32), nullable=False),
        # 255: the width of neubit_reporting.points.device_tag / point_tag.
        sa.Column("device_tag", sa.String(length=255), nullable=True),
        sa.Column("point_tag", sa.String(length=255), nullable=True),
        *_audit_columns(),
        sa.PrimaryKeyConstraint("slot_id"),
        sa.ForeignKeyConstraint(
            ["equipment_id"], ["site_equipment.equipment_id"], ondelete="CASCADE",
        ),
        sa.UniqueConstraint("equipment_id", "slot", name="uq_equipment_point_slots_slot"),
        sa.UniqueConstraint(
            "tenant_id", "device_tag", "point_tag", name="uq_equipment_point_slots_binding"
        ),
        # Half a binding names no point — both tags or neither.
        sa.CheckConstraint(
            "(device_tag IS NULL) = (point_tag IS NULL)",
            name="ck_equipment_point_slots_binding_whole",
        ),
    )
    op.create_index("ix_equipment_point_slots_tenant_id", "equipment_point_slots", ["tenant_id"])
    op.create_index("ix_equipment_point_slots_site_id", "equipment_point_slots", ["site_id"])
    op.create_index(
        "ix_equipment_point_slots_equipment_id", "equipment_point_slots", ["equipment_id"]
    )


def downgrade() -> None:
    # Operator-typed facts go with the tables. Nothing else in the schema refers
    # to them, so the drop is clean — and the facts are unrecoverable, which is
    # why a downgrade past this revision is a decision, not a routine.
    op.drop_table("equipment_point_slots")
    op.drop_table("site_equipment")
    op.drop_table("site_systems")
