"""reporting: benchmark standards as CITED DATA + per-site band config

Revision ID: 0016_benchmark_standards
Revises: 0015_retire_dataset_delta_t
Create Date: 2026-09-01

WHAT THIS IS
------------
§19 shipped Ratings with the benchmark DELIBERATELY absent: "a threshold typed
from memory would be an invented grade wearing a real EPI's credibility". This
migration is the other half of that sentence — the table a PINNED standard can
be loaded into, plus the first pinned standard.

`benchmark_standards` holds a published rating scheme as a row: name, version,
full citation, source URL, and the band tables verbatim. A band that cannot
cite its document does not get a row; there is no API that accepts one without
a citation.

`benchmark_site_config` holds what the STANDARD needs to know about a SITE
before a band applies: the climate zone and the air-conditioned-share category.
Both are OPERATOR statements (BEE's bands differ by both), both nullable, and
NULL means NOT RECORDED — the band is then blocked naming exactly which input
is missing. Nothing derives a zone from a city name: the zone→city mapping is
its own published document and it is not pinned here.

THE SEED — BEE Star Rating for Office Buildings, February 2009
--------------------------------------------------------------
Source (pinned, fetched and read 2026-09-01):
  "SCHEME FOR BEE STAR RATING FOR OFFICE BUILDINGS — Details of the scheme for
  rating of office buildings, February 2009", Bureau of Energy Efficiency,
  Ministry of Power, Govt. of India.
  https://beeindia.gov.in/sites/default/files/BEE%20Star%20Rating%20for%20existing%20Office%20Buildings.pdf

The bands below are Annexure 4 of that document, verbatim: EPI (kWh/sqm/year)
per climate zone (Composite, Warm and Humid, Hot and Dry), split by whether
the air-conditioned area exceeds 50% of built-up area. Two definitional facts
from the scheme ride along in `notes` because an EPI graded against these
bands must be computed the way the scheme computes it:

  * EPI = (purchased + generated electricity) / built-up area, EXCLUDING
    electricity generated from on-site renewable sources (para iv/v) and
    excluding basement area from the denominator (Annexure 1, Table 1 item 5a).
  * The scheme targets buildings with connected load >= 100 kW.

KNOWN, STATED: BEE is reported to have revised these bands with effect from
January 2022 (referenced by BEE's own site and secondary sources). The revised
TABLE could not be pinned to a primary document during this seed, so the 2009
tables enter under version "feb-2009" and the revision enters as a NEW version
row when somebody pins it. Grading against a cited 2009 table beats grading
against an uncited 2022 rumour; the version is printed wherever a band renders.
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0016_benchmark_standards"
down_revision = "0015_retire_dataset_delta_t"
branch_labels = None
depends_on = None


# Annexure 4, verbatim. `min`/`max` bound the EPI (kWh/sqm/year) for each star;
# `max: null` never occurs here — the 1-star row's upper bound is the WORST
# graded EPI (above it the scheme awards no star), and the 5-star row has
# `min: null` (anything below its threshold is 5-star).
_BANDS = {
    "unit": "kWh/m2/yr",
    "zones": {
        "composite": {
            "label": "Composite",
            "gt50pct_ac": [
                {"stars": 1, "min": 165, "max": 190},
                {"stars": 2, "min": 140, "max": 165},
                {"stars": 3, "min": 115, "max": 140},
                {"stars": 4, "min": 90, "max": 115},
                {"stars": 5, "min": None, "max": 90},
            ],
            "lt50pct_ac": [
                {"stars": 1, "min": 70, "max": 80},
                {"stars": 2, "min": 60, "max": 70},
                {"stars": 3, "min": 50, "max": 60},
                {"stars": 4, "min": 40, "max": 50},
                {"stars": 5, "min": None, "max": 40},
            ],
        },
        "warm_humid": {
            "label": "Warm and Humid",
            "gt50pct_ac": [
                {"stars": 1, "min": 175, "max": 200},
                {"stars": 2, "min": 150, "max": 175},
                {"stars": 3, "min": 125, "max": 150},
                {"stars": 4, "min": 100, "max": 125},
                {"stars": 5, "min": None, "max": 100},
            ],
            "lt50pct_ac": [
                {"stars": 1, "min": 75, "max": 85},
                {"stars": 2, "min": 65, "max": 75},
                {"stars": 3, "min": 55, "max": 65},
                {"stars": 4, "min": 45, "max": 55},
                {"stars": 5, "min": None, "max": 45},
            ],
        },
        "hot_dry": {
            "label": "Hot and Dry",
            "gt50pct_ac": [
                {"stars": 1, "min": 155, "max": 180},
                {"stars": 2, "min": 130, "max": 155},
                {"stars": 3, "min": 105, "max": 130},
                {"stars": 4, "min": 80, "max": 105},
                {"stars": 5, "min": None, "max": 80},
            ],
            "lt50pct_ac": [
                {"stars": 1, "min": 65, "max": 75},
                {"stars": 2, "min": 55, "max": 65},
                {"stars": 3, "min": 45, "max": 55},
                {"stars": 4, "min": 35, "max": 45},
                {"stars": 5, "min": None, "max": 35},
            ],
        },
    },
}

_NOTES = (
    "EPI per the scheme: (purchased + generated electricity) / built-up area "
    "in sqm, EXCLUDING electricity generated from on-site renewable sources "
    "(solar PV etc.) and excluding basement area from the built-up figure. "
    "Scheme targets buildings with connected load >= 100 kW; initial climatic "
    "zones are Warm and Humid, Composite, and Hot and Dry. KNOWN: BEE reports "
    "a band revision effective January 2022; its table was not pinned to a "
    "primary document at seed time (2026-09-01), so it is NOT here — it enters "
    "as a new version when pinned. The version in force is printed beside "
    "every band this standard renders."
)

_CITATION = (
    "Bureau of Energy Efficiency (Ministry of Power, Govt. of India), "
    '"Scheme for BEE Star Rating for Office Buildings — Details of the scheme '
    'for rating of office buildings", February 2009, Annexure 4. '
    "https://beeindia.gov.in/sites/default/files/BEE%20Star%20Rating%20for%20existing%20Office%20Buildings.pdf"
)


def upgrade() -> None:
    op.create_table(
        "benchmark_standards",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("version", sa.String(32), nullable=False),
        sa.Column("title", sa.Text, nullable=False),
        # A standard without a citation cannot exist in this table. NOT NULL is
        # the schema saying so.
        sa.Column("citation", sa.Text, nullable=False),
        sa.Column("source_url", sa.Text, nullable=False),
        sa.Column("dimension", sa.String(32), nullable=False,
                  server_default="energy_per_area"),
        sa.Column("bands", JSONB, nullable=False),
        sa.Column("notes", sa.Text, nullable=True),
        sa.Column("seeded_by", sa.String(320), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.UniqueConstraint("key", "version", name="uq_benchmark_key_version"),
    )
    op.create_table(
        "benchmark_site_config",
        sa.Column("site_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=True),
        sa.Column("standard_key", sa.String(64), nullable=False,
                  server_default="bee_star_office"),
        # BOTH nullable. NULL = not recorded, and the band is blocked naming
        # the missing one. No default zone, ever.
        sa.Column("climate_zone", sa.String(32), nullable=True),
        sa.Column("ac_category", sa.String(32), nullable=True),
        sa.Column("set_by", sa.String(320), nullable=True),
        sa.Column("set_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.execute(
        sa.text(
            """
            INSERT INTO benchmark_standards
                (key, version, title, citation, source_url, dimension, bands,
                 notes, seeded_by)
            VALUES
                ('bee_star_office', 'feb-2009',
                 'BEE Star Rating for Office Buildings',
                 :citation, :url, 'energy_per_area',
                 CAST(:bands AS jsonb), :notes,
                 'operator (delegated seed, contract §21) via migration 0016')
            ON CONFLICT (key, version) DO NOTHING
            """
        ).bindparams(
            citation=_CITATION,
            url="https://beeindia.gov.in/sites/default/files/BEE%20Star%20Rating%20for%20existing%20Office%20Buildings.pdf",
            bands=json.dumps(_BANDS),
            notes=_NOTES,
        )
    )


def downgrade() -> None:
    op.drop_table("benchmark_site_config")
    op.drop_table("benchmark_standards")
