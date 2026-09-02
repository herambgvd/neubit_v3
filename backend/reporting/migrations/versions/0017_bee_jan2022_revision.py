"""reporting: the BEE January-2022 star-rating revision, pinned and seeded

Revision ID: 0017_bee_jan2022_revision
Revises: 0016_benchmark_standards
Create Date: 2026-09-01

WHAT THIS IS
------------
Migration 0016 seeded BEE's February-2009 office-building bands and stated,
in its own notes, that a January-2022 revision was KNOWN but could not be
pinned to a primary document at seed time — "the revision enters as a NEW
version row when somebody pins it". Somebody pinned it. This migration is
that new version row, plus the two schema extensions the revised model needs.

THE PINNED DOCUMENT (fetched and read in full, 2026-09-01)
----------------------------------------------------------
  Bureau of Energy Efficiency, "Schedule for Star Rating of Commercial
  Buildings — Office Buildings", w.e.f. 01 January 2022. Copy hosted by
  JREDA (Jharkhand Renewable Energy Development Agency):
  https://api.jreda.com/all-uploaded-img/Directory/6343f17ec4de0.pdf

Unlike 2009's fixed EPI ranges, the 2022 schedule defines each star band as a
STRAIGHT-LINE EQUATION (Section 6): "The Star Rating Band is formed by
straight line equations is in the form y=(a*b)+c, where 'b' denotes the
percentage of AC area out of total built-up area." The equations differ by
climatic zone AND by building size category (in line with ECBC 2017):
Large BUA > 30,000 m²; Medium 10,000 ≤ BUA ≤ 30,000 m²; Small BUA < 10,000 m².

So the schema grows what an equation-based standard needs:

  * `benchmark_standards.effective_from` — a version now has a DATE, because
    two versions of the same scheme coexist and the one that applies to a
    window is the latest whose effective date ≤ the window's end. Backfilled
    2009-02-01 for the existing feb-2009 row (its bands, citation and notes
    are untouched — versioning is data, history stays).
  * `benchmark_site_config.ac_share_percent` — the 2022 equations take a
    CONTINUOUS AC-share percentage (the 'b'), not 2009's over/under-50%
    category. A new operator input, 0–100, NULL = NOT RECORDED (the jan-2022
    band is then blocked naming exactly this input). The 2009 `ac_category`
    column stays — it is what the feb-2009 version reads.

The band-kind is carried INSIDE the bands JSON (`"kind":
"linear_by_ac_share"`); rows without a kind are the original fixed-range
shape. The size category is not stored anywhere: it DERIVES from
`site_facts.gross_floor_area_sqm` at resolution time, so a corrected area
re-categorises the site without a second fact drifting out of step.

BOUNDARY SEMANTICS — ENCODED FROM THE DOCUMENT'S OWN WORKED EXAMPLE
-------------------------------------------------------------------
The document states (Section 6, verbatim): "The equations provide the upper
limit of the corresponding Star Rating. Lower limit will be the value
obtained by the equation of next higher rating." Its worked example then
contradicts that header line: "For Example: Any Large Office Building in
Composite climatic zone, having 75% AC area / Lowest EPI value for 1-Star
will be: 0.95*75 + 60 = 131.25 kwh/sqm. / Lower limit for 2-star building
will be: 0.9*75 + 50 = 117.5 kwh/sqm. / So, any building having 75% AC area,
and having EPI less than 131.25 kwh/sqm. but equals to or more than 117.5
kwh/sqm. that building will be awarded 2-star rating." The worked example is
the precise statement and is what the evaluator encodes: the s-star equation
value is the INCLUSIVE LOWER edge of the s-star band and the exclusive upper
edge is the (s−1)-star equation; 5-star is open below; EPI ≥ the 1-star
value grades 1-star ("Lowest EPI value for 1-Star"). See
`app/metric_registry/evaluator.py::linear_band_table` — the semantics live
in code, this migration only carries the coefficients, verbatim.
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0017_bee_jan2022_revision"
down_revision = "0016_benchmark_standards"
branch_labels = None
depends_on = None


def _stars(rows: list[tuple[float, float]]) -> dict:
    """rows = [(a, c) for 1★..5★] → {"1": {"a":…, "c":…}, …} — y = a·x + c,
    x = percentage of AC area out of total built-up area."""
    return {str(i + 1): {"a": a, "c": c} for i, (a, c) in enumerate(rows)}


# Section 6, "Table for Star Rating of the Office Building" — VERBATIM.
# Coefficients (a, c) of y = a·x + c per zone × size category × star.
_BANDS = {
    "kind": "linear_by_ac_share",
    "unit": "kWh/m2/yr",
    "x": (
        "percentage of AC area out of total built-up area "
        "(site input `ac_share_percent`, 0–100)"
    ),
    "size_categories": {
        "large": {"label": "Large Office (BUA > 30,000 m²)"},
        "medium": {"label": "Medium Office (10,000 m² ≤ BUA ≤ 30,000 m²)"},
        "small": {"label": "Small Office (BUA < 10,000 m²)"},
    },
    "zones": {
        "composite": {
            "label": "Composite",
            "large": _stars([(0.95, 60), (0.9, 50), (0.85, 40), (0.8, 30), (0.75, 20)]),
            "medium": _stars([(1.1, 60), (1.05, 50), (1.0, 40), (0.95, 30), (0.9, 20)]),
            "small": _stars([(0.65, 60), (0.6, 50), (0.55, 40), (0.5, 30), (0.45, 20)]),
        },
        "warm_humid": {
            "label": "Warm and Humid",
            "large": _stars([(0.9, 65), (0.85, 55), (0.8, 45), (0.75, 35), (0.7, 25)]),
            "medium": _stars([(0.9, 65), (0.85, 55), (0.8, 45), (0.75, 35), (0.7, 25)]),
            "small": _stars([(0.7, 65), (0.65, 55), (0.6, 45), (0.55, 35), (0.5, 25)]),
        },
        "hot_dry": {
            "label": "Hot and Dry",
            "large": _stars([(1.1, 55), (1.05, 45), (1.0, 35), (0.95, 25), (0.9, 15)]),
            "medium": _stars([(1.25, 55), (1.2, 45), (1.15, 35), (1.1, 25), (1.05, 15)]),
            "small": _stars([(0.75, 55), (0.7, 45), (0.65, 35), (0.6, 25), (0.55, 15)]),
        },
    },
}

_CITATION = (
    "Bureau of Energy Efficiency, \"Schedule for Star Rating of Commercial "
    "Buildings — Office Buildings\", w.e.f. 01 January 2022, Section 6 (Star "
    "Rating Table). Copy hosted by JREDA (Jharkhand Renewable Energy "
    "Development Agency): "
    "https://api.jreda.com/all-uploaded-img/Directory/6343f17ec4de0.pdf"
)

_NOTES = (
    "EPI per the schedule (Section 2d, unchanged from 2009 in substance): "
    "[electricity purchased and generated (excl. generated from on-site RE "
    "resources)] ÷ [built-up area excluding basement parking, lawn, roads, "
    "etc. (in sqm.)], in kWh/m²/yr. Eligibility: connected load of 100 kW and "
    "above — recorded as a note, NOT enforced (our EPI is a measurement, not "
    "a scheme application). MEDIUM-WORDING NOTE: the document's Terminology "
    "section prints the Medium range garbled as '30,000 m² ≤ BUA < 10,000 m²'; "
    "it is treated as 10,000 ≤ BUA ≤ 30,000 m², in line with ECBC 2017 and "
    "the document's own fees table. BOUNDARY-SEMANTICS NOTE: the document's "
    "header line ('the equations provide the upper limit of the corresponding "
    "Star Rating') and its worked example disagree; the worked example's "
    "inequalities are encoded verbatim — 'EPI less than 131.25 kwh/sqm. but "
    "equals to or more than 117.5 kwh/sqm. … will be awarded 2-star rating' "
    "(Large, Composite, 75% AC) — i.e. each star's equation is the inclusive "
    "lower edge of its own band."
)


def upgrade() -> None:
    # A version now has an effective date: the version that applies to an
    # evaluation window is the LATEST whose effective_from ≤ the window's end.
    op.add_column(
        "benchmark_standards",
        sa.Column("effective_from", sa.Date, nullable=True),
    )
    op.execute(
        "UPDATE benchmark_standards SET effective_from = DATE '2009-02-01' "
        "WHERE key = 'bee_star_office' AND version = 'feb-2009'"
    )
    # The 2022 equations take the AC share as a CONTINUOUS percentage.
    # NULL = not recorded; the jan-2022 band is blocked naming this input.
    op.add_column(
        "benchmark_site_config",
        sa.Column("ac_share_percent", sa.Numeric(5, 2), nullable=True),
    )
    op.create_check_constraint(
        "ck_benchmark_ac_share_pct",
        "benchmark_site_config",
        "ac_share_percent IS NULL OR (ac_share_percent >= 0 AND ac_share_percent <= 100)",
    )
    op.execute(
        sa.text(
            """
            INSERT INTO benchmark_standards
                (key, version, title, citation, source_url, dimension, bands,
                 notes, seeded_by, effective_from)
            VALUES
                ('bee_star_office', 'jan-2022',
                 'BEE Star Rating of Commercial Buildings — Office Buildings',
                 :citation, :url, 'energy_per_area',
                 CAST(:bands AS jsonb), :notes,
                 'operator (delegated seed, contract §21 addendum) via migration 0017',
                 DATE '2022-01-01')
            ON CONFLICT (key, version) DO NOTHING
            """
        ).bindparams(
            citation=_CITATION,
            url="https://api.jreda.com/all-uploaded-img/Directory/6343f17ec4de0.pdf",
            bands=json.dumps(_BANDS),
            notes=_NOTES,
        )
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM benchmark_standards "
        "WHERE key = 'bee_star_office' AND version = 'jan-2022'"
    )
    op.drop_constraint(
        "ck_benchmark_ac_share_pct", "benchmark_site_config", type_="check"
    )
    op.drop_column("benchmark_site_config", "ac_share_percent")
    op.drop_column("benchmark_standards", "effective_from")
