"""sites: TIME-OF-USE TARIFF SLABS and EMISSION FACTORS — homes, not values

Revision ID: 0019_site_tariff_emissions
Revises: 0018_site_building_facts
Create Date: 2026-08-31

WHY THESE TABLES EXIST
----------------------
0018 gave a rating its denominator (area) and a single scalar tariff. The BI
mockup's Time-of-Use strip and CO2 figures need two more INPUTS the platform
could not state:

* ``site_tariff_slabs`` — a tariff that changes with the clock. The scalar
  ``sites.energy_tariff_per_kwh`` stays: it is the legitimate simple case.
  PRECEDENCE (documented here and in the UI): if ANY slab exists for a site
  whose ``effective_from`` is on or before the date being priced, the slabs
  override the scalar ENTIRELY for that date; an hour no slab covers has NO
  price (absence, never a fallback into the scalar — blending two assertions
  would produce a figure nobody stated). The scalar applies only when no slab
  set is in effect.

  Windows are stored as MINUTES since midnight so the mockup's half-hour cells
  are expressible. ``end_minute <= 1440``; ``end > start`` is a plain window
  ``[start, end)``; ``end < start`` WRAPS midnight (22:00 -> 06:00);
  ``end == start`` is refused as ambiguous (a full day is ``0 -> 1440``).

  ``effective_from`` exists so a tariff REVISION is a new generation of rows,
  not a silent rewrite of the one BI already divided by. The PUT is still a
  full replace of the whole list (the retraction property from 0018: an
  explicit empty list clears everything), so keeping history is the operator
  restating every generation they stand behind.

* ``site_emission_factors`` — kg CO2 per kWh, with a REQUIRED ``source``: a
  factor with no citation is exactly the fabrication this platform forbids.
  Scalar per ``effective_from`` today; a later time-of-day variant ADDS
  nullable window columns to this table rather than rewriting it.

THESE TABLES SHIP EMPTY. No default slabs, no "standard" grid factor, no
seeded rates. Every row is typed by an operator who can also take it back.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0019_site_tariff_emissions"
down_revision = "0018_site_building_facts"
branch_labels = None
depends_on = None


def _has_table(bind, name: str) -> bool:
    return sa.inspect(bind).has_table(name)


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "site_tariff_slabs"):
        op.create_table(
            "site_tariff_slabs",
            sa.Column("slab_id", sa.String(length=36), nullable=False),
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column("site_id", sa.String(length=36), nullable=False),
            sa.Column("name", sa.String(length=64), nullable=False),
            # Minutes since midnight. start in [0, 1440); end in (0, 1440].
            # end > start: [start, end). end < start: wraps midnight.
            sa.Column("start_minute", sa.Integer(), nullable=False),
            sa.Column("end_minute", sa.Integer(), nullable=False),
            sa.Column("rate_per_kwh", sa.Float(), nullable=False),
            # Beside the rate, never assumed — a bare 8.5 is not a price.
            sa.Column("currency", sa.String(length=8), nullable=False),
            # Generation key: a revision is NEW rows under a new date.
            sa.Column("effective_from", sa.Date(), nullable=False),
            # Display order within the set, assigned from the request list.
            sa.Column("position", sa.Integer(), nullable=False),
            sa.Column("created_by", sa.String(length=36), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("slab_id", name="pk_site_tariff_slabs"),
        )
        op.create_index("ix_site_tariff_slabs_tenant_id", "site_tariff_slabs", ["tenant_id"])
        op.create_index("ix_site_tariff_slabs_site_id", "site_tariff_slabs", ["site_id"])

    if not _has_table(bind, "site_emission_factors"):
        op.create_table(
            "site_emission_factors",
            sa.Column("factor_id", sa.String(length=36), nullable=False),
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column("site_id", sa.String(length=36), nullable=False),
            sa.Column("kg_co2_per_kwh", sa.Float(), nullable=False),
            # REQUIRED. Who published this number (e.g. "CEA Baseline v19,
            # 2023"). A factor with no citation is an invented figure wearing
            # a real kWh's credibility, and the schema refuses to hold one.
            sa.Column("source", sa.String(length=512), nullable=False),
            sa.Column("effective_from", sa.Date(), nullable=False),
            sa.Column("created_by", sa.String(length=36), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("factor_id", name="pk_site_emission_factors"),
            # Two factors from the same date would be a contradiction, not a
            # history. (Time-of-day windows, when they come, join this key.)
            sa.UniqueConstraint(
                "site_id", "effective_from", name="uq_site_emission_factors_site_date"
            ),
        )
        op.create_index(
            "ix_site_emission_factors_tenant_id", "site_emission_factors", ["tenant_id"]
        )
        op.create_index(
            "ix_site_emission_factors_site_id", "site_emission_factors", ["site_id"]
        )


def downgrade() -> None:
    op.drop_table("site_emission_factors")
    op.drop_table("site_tariff_slabs")
