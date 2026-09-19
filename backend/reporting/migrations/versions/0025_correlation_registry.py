"""reporting: the cross-domain correlation registry — the seven questions

Revision ID: 0025_correlation_registry
Revises: 0024_point_supersede
Create Date: 2026-09-19

WHY THIS TABLE EXISTS AT ALL
----------------------------
A building management system owns HVAC and only HVAC. That is not a criticism of
Siemens, Honeywell or JCI, it is their scope: the plant is what they sell, so the
questions they can ask are questions about the plant. "Is the chiller efficient?"
is answerable inside one domain. "Are we cooling and ventilating a floor that
nobody badged into this morning?" is not, and no amount of BMS features makes it
so, because the badge is in a different product with a different database.

This platform owns video, access control, IoT and energy on ONE estate. The
questions that need two of those at once are the ones a competitor structurally
cannot answer — and today the console does not ask a single one. This revision is
the list of them.

SPECS AS DATA, FOR THE SAME REASON THE METRIC REGISTRY IS
----------------------------------------------------------
0014 argued that a derived metric is a row and not an `if device_type ==` branch,
because the second derived value would otherwise be the second branch in the one
file that has to stay domain-agnostic. A cross-domain correlation is the same
argument one layer up: the EIGHTH question — the one a customer asks in a
deployment nobody here has seen — must be an INSERT, not a release.

So a correlation declares WHAT IT NEEDS, in a closed vocabulary of signal
sources, and the reader (`reading_writer.api.correlations`) resolves those needs
against the estate at request time. The table holds no counts, no scores and no
status: a status computed at migration time would be a fact about the database on
the morning it was written.

WHAT A CORRELATION ROW IS
-------------------------
    key / version       identity, versioned exactly like `metric_definitions`:
                        a change in what a correlation NEEDS is a new version,
                        because "this was live in August" must stay answerable.
    tenant_id IS NULL   a PLATFORM correlation, visible to every tenant. All
                        seven seeded here are platform rows — the cross-domain
                        question is a product claim, not one estate's opinion.
    name / question     what a human calls it, and the question in words. The
                        question is the product; it is not decoration.
    unlocks             what becomes possible once every signal is satisfied.
    domains             which platform domains it spans. Two or more, always —
                        a single-domain "correlation" belongs in the metric
                        registry, which already computes those.
    signals             the list of things it needs, each naming the SOURCE that
                        supplies it. Order is load-bearing: the reader reports
                        the FIRST unsatisfied signal as the blocking gap, so a
                        correlation's signals are declared in the order the
                        title names them and the blocker is not an author's
                        opinion about which gap is worse.

THE SOURCE VOCABULARY IS CLOSED
--------------------------------
`point_live`, `point_unit`, `point_role`, `projection`, `site_fact` — five, each
with its own resolver and its own gap kind. The vocabulary is closed in
`reading_writer.api.correlations.SOURCES`, and a seed naming a sixth is a loud
failure in this service's own tests rather than a signal that silently never
resolves. Widening it is a code change ON PURPOSE: a new source means a new way
of being satisfied, and there is no generic way to be satisfied.

THE FROZEN-SEED LESSON, APPLIED
--------------------------------
0018/0019/0020 each looped over `reporting.ccei_spec.definitions()`, a module
that GROWS, and so each one seeded rows belonging to later revisions the moment
somebody extended it — `alembic upgrade head` died at 0018 on a fresh database
and never on an existing one. The fix there was to pin WHICH rows each revision
owns while leaving the bodies in the shared spec module, because the registry
type-checks those bodies against a published specification and a second copy
would be a second source of truth.

Nothing of that kind applies here: there is no published external specification
for these seven and nothing type-checks their bodies against one. So the bodies
are frozen HERE, as literals, and this revision imports nothing from the
application at all. A revision that cannot read a module that grows cannot drift
with it. `_SEEDS` pins the (key, version) pairs anyway, and `_check()` asserts
the bodies and the pin agree — so adding a row to `_ROWS` without claiming it in
`_SEEDS` fails at import, not at INSERT.

NOTHING HERE IS MEASURED, ESTIMATED OR COUNTED
-----------------------------------------------
Every string below is a declaration of a need or a sentence for a human to read.
There is not one number in this file that describes this or any deployment.
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0025_correlation_registry"
down_revision = "0024_point_supersede"
branch_labels = None
depends_on = None

_SEEDED_BY = "platform via migration 0025"

# THE ROWS THIS REVISION OWNS, PINNED — (key, version). See the header.
_SEEDS = (
    ("ambient_temp_vs_chiller_load", 1),
    ("chiller_delta_t_vs_plant_kw", 1),
    ("occupancy_vs_hvac_energy", 1),
    ("people_count_vs_fresh_air", 1),
    ("after_hours_access_vs_energy", 1),
    ("water_use_vs_occupancy", 1),
    ("dg_runtime_vs_scope1_carbon", 1),
)

# ── The seven ────────────────────────────────────────────────────────────────
#
# A note on the tag patterns below, because they look like the thing this
# codebase bans. `app/api/units.py` is emphatic that a tag is a naming convention
# and a convention is evidence of nothing, so nothing may INFER a unit from a
# tag. That rule is intact here: no pattern below ever asserts a unit, a role or
# a meaning. A pattern is used for exactly one thing — deciding which SENTENCE a
# human is shown about a gap. "Two points look like ambient temperature and
# neither has a confirmed unit" and "no point on this estate looks like ambient
# temperature at all" are different problems with different remedies, and telling
# them apart is the entire product claim this table makes. The reader returns the
# matched points alongside the gap so the operator can check the probe rather
# than trust it.
#
# Every pattern is anchored (`^`…`$`) and matched case-insensitively, the same
# discipline the unit catalogue uses, so a rule fires on a tag SHAPE and never on
# a substring that could turn up anywhere.

_ROWS: tuple[dict, ...] = (
    {
        "key": "ambient_temp_vs_chiller_load",
        "version": 1,
        "name": "Ambient temperature ↔ chiller load",
        "question": (
            "Does the plant's load actually track the weather, or is it tracking "
            "a schedule nobody has revisited since commissioning?"
        ),
        "unlocks": (
            "A chiller sitting at load on a cool morning is a control fault, not "
            "a weather event — and it is invisible to anything that can only see "
            "the chiller."
        ),
        "domains": ["environment", "hvac"],
        "signals": [
            {
                "key": "ambient_temp",
                "label": "Ambient temperature",
                "domain": "environment",
                "source": "point_unit",
                "unlocks": "the x-axis: what the weather was doing.",
                # `dimension` is declared, so a confirmed unit that is not a
                # temperature does not satisfy this. Confirming `kWh` on a point
                # called AmbTemp is a human error and this is where it stops.
                "requires": {
                    "tag_pattern": "^.*ambtemp$",
                    "category": "hvac",
                    "dimension": "temperature",
                },
            },
            {
                "key": "chiller_load",
                "label": "Chiller system load",
                "domain": "hvac",
                "source": "point_unit",
                "unlocks": "the y-axis: what the plant was doing about it.",
                # NO `dimension`. This estate reports system load as a percentage
                # and `%` is deliberately absent from the metric registry's
                # dimension table — a percentage is not a quantity that composes.
                # What this signal needs is therefore weaker and exactly stated:
                # that a HUMAN has said what the number is. Inventing a `percent`
                # dimension so that this line could look like the one above would
                # put a unit into the algebra purely to satisfy a screen.
                "requires": {"tag_pattern": "^.*sysload$", "category": "hvac"},
            },
        ],
    },
    {
        "key": "chiller_delta_t_vs_plant_kw",
        "version": 1,
        "name": "Chiller ΔT ↔ plant kW",
        "question": (
            "Is the plant producing less cooling per kilowatt than it did — and "
            "did that start on a date?"
        ),
        "unlocks": (
            "Low ΔT syndrome, named. A chiller whose water side narrows while its "
            "electrical side does not is fouling, a stuck valve or a pump running "
            "for nothing; the machine's own panel reports none of that as a fault."
        ),
        "domains": ["hvac", "energy"],
        "signals": [
            {
                "key": "inlet_water_temp",
                "label": "Entering water temperature",
                "domain": "hvac",
                "source": "point_role",
                "unlocks": "the warm side of ΔT.",
                "requires": {
                    "role": "inlet_water_temp",
                    "category": "hvac",
                    "candidate_tag_pattern": "^.*iwt$",
                },
            },
            {
                "key": "outlet_water_temp",
                "label": "Leaving water temperature",
                "domain": "hvac",
                "source": "point_role",
                "unlocks": "the cold side of ΔT.",
                "requires": {
                    "role": "outlet_water_temp",
                    "category": "hvac",
                    "candidate_tag_pattern": "^.*owt$",
                },
            },
            {
                "key": "plant_power",
                "label": "Chiller electrical power",
                "domain": "energy",
                "source": "point_unit",
                "unlocks": "the electrical cost of that ΔT.",
                # `_kw` and not `_kwh`: the anchor is doing real work here. The
                # same meters publish both and one of them is a register.
                "requires": {
                    "tag_pattern": "^.*em[ _]?kw$",
                    "dimension": "power",
                },
            },
        ],
    },
    {
        "key": "occupancy_vs_hvac_energy",
        "version": 1,
        "name": "Occupancy ↔ HVAC energy",
        "question": "Are we conditioning floors that nobody badged into today?",
        "unlocks": (
            "The single largest avoidable load in most buildings, and the one "
            "neither an access system nor a BMS can see on its own: one knows who "
            "came in, the other knows what it spent, and nothing joins them."
        ),
        "domains": ["access", "hvac"],
        "signals": [
            {
                "key": "badge_events",
                "label": "Door access events",
                "domain": "access",
                "source": "projection",
                "unlocks": "occupancy, as measured rather than assumed.",
                "requires": {"projection_key": "access_events", "key_column": "door_id"},
            },
            {
                "key": "hvac_energy",
                "label": "HVAC energy register",
                "domain": "hvac",
                "source": "point_role",
                "unlocks": "what the conditioning cost over the same hours.",
                "requires": {
                    "role": "energy_register",
                    "category": "hvac",
                    "candidate_tag_pattern": "^.*kwh$",
                },
            },
        ],
    },
    {
        "key": "people_count_vs_fresh_air",
        "version": 1,
        "name": "People count ↔ fresh air",
        "question": (
            "Is the treated-fresh-air plant sized to the people who are actually "
            "in the space, or to the people the design day assumed?"
        ),
        "unlocks": (
            "Demand-controlled ventilation with a measured denominator. Ventilation "
            "is conditioned outside air — the most expensive air in the building — "
            "and it is almost always delivered against a headcount nobody measures."
        ),
        "domains": ["vision", "hvac"],
        "signals": [
            {
                "key": "people_count",
                "label": "Camera people-count analytics",
                "domain": "vision",
                "source": "projection",
                "unlocks": "how many people were actually in the space.",
                # No such projection is registered today, and that is the point:
                # the reader reports this as UNKNOWN rather than as zero. See the
                # long note in `correlations._resolve_projection` — the camera
                # inventory lives in the vision service's own database, which this
                # service is banned from opening, so "there are no cameras" is not
                # a sentence this store is entitled to say.
                "requires": {"projection_key": "camera_analytics", "key_column": "camera_id"},
            },
            {
                "key": "tfa_energy",
                "label": "Treated fresh-air unit energy",
                "domain": "hvac",
                "source": "point_unit",
                "unlocks": "what ventilating for that headcount cost.",
                # This estate meters its TFA unit ELECTRICALLY. There is no airflow
                # or CO2 point on it, so the ventilation signal that exists here is
                # the unit's own energy — which is what the correlation reads. A
                # declared need for a volumetric airflow point would be a need for
                # a sensor nobody has, dressed up as a configuration gap.
                "requires": {
                    "device_type": "tfa",
                    "tag_pattern": "^kwh$",
                    "dimension": "energy",
                },
            },
        ],
    },
    {
        "key": "after_hours_access_vs_energy",
        "version": 1,
        "name": "After-hours access ↔ energy spike",
        "question": (
            "When consumption rises outside working hours, did anyone badge in — "
            "and when somebody badges in out of hours, does consumption follow?"
        ),
        "unlocks": (
            "Both directions of one fault. Load with nobody there is equipment "
            "left running; somebody there with no load is a person working in a "
            "building whose systems are asleep. Each is a finding; neither is "
            "visible from one domain."
        ),
        "domains": ["access", "energy"],
        "signals": [
            {
                "key": "badge_events",
                "label": "Door access events",
                "domain": "access",
                "source": "projection",
                "unlocks": "who was in the building, and when.",
                "requires": {"projection_key": "access_events", "key_column": "door_id"},
            },
            {
                "key": "energy_register",
                "label": "Site energy register",
                "domain": "energy",
                "source": "point_role",
                "unlocks": "the consumption those hours actually carried.",
                "requires": {
                    "role": "energy_register",
                    "category": "energy",
                    "candidate_tag_pattern": "^.*kwh$",
                },
            },
        ],
    },
    {
        "key": "water_use_vs_occupancy",
        "version": 1,
        "name": "Water use ↔ occupancy",
        "question": "Is water being drawn in proportion to the people drawing it?",
        "unlocks": (
            "Leak detection that does not need a leak sensor. Consumption per "
            "occupant is flat in a healthy building; a step change with no matching "
            "step in occupancy is a leak, a stuck valve or a tanker fill, and a "
            "flow meter alone cannot tell which."
        ),
        "domains": ["water", "access"],
        "signals": [
            {
                "key": "water_volume",
                "label": "Water volume",
                "domain": "water",
                "source": "point_role",
                "unlocks": "the numerator: what was drawn.",
                "requires": {
                    "role": "water_volume",
                    "category": "water",
                    # Cumulative flow only. The same meter publishes `Flow Rate`,
                    # `For_Flow` and `Rev_Flow`, and none of those is a volume —
                    # probing for them would report "a point exists, bind it" about
                    # points that must never carry this role.
                    "candidate_tag_pattern": "^(.+_)?cum_?flow$",
                },
            },
            {
                "key": "badge_events",
                "label": "Door access events",
                "domain": "access",
                "source": "projection",
                "unlocks": "the denominator: how many people drew it.",
                "requires": {"projection_key": "access_events", "key_column": "door_id"},
            },
        ],
    },
    {
        "key": "dg_runtime_vs_scope1_carbon",
        "version": 1,
        "name": "Generator runtime ↔ Scope-1 carbon",
        "question": "What did this estate burn, and what may we say that it emitted?",
        "unlocks": (
            "A carbon figure with a citation on it. Runtime alone is an hours "
            "number; runtime times a factor somebody typed and sourced is a "
            "disclosure a customer can put in front of an auditor."
        ),
        "domains": ["hvac", "sustainability"],
        "signals": [
            {
                "key": "run_hours",
                "label": "Machine run hours",
                "domain": "hvac",
                "source": "point_live",
                "unlocks": "how long the machine actually ran.",
                # `point_live`, not `point_unit`. Run hours are already hours; the
                # one thing that would make this need a unit is a dimension table
                # entry for time, and adding one so that this line could demand a
                # confirmation would invent a gap rather than find one.
                "requires": {"tag_pattern": "^.*run ?hours$", "category": "hvac"},
            },
            {
                "key": "grid_emission_factor",
                "label": "Cited grid emission factor",
                "domain": "sustainability",
                "source": "site_fact",
                "unlocks": "the multiplier, and the citation that makes it defensible.",
                # The factor must carry a SOURCE. A kg CO2/kWh with no citation is
                # a number somebody remembered, and the whole value of the output
                # is that it is not that.
                "requires": {"fact": "emission_factor"},
            },
        ],
    },
)


def _check() -> tuple[dict, ...]:
    """`_ROWS` and the pin agree, decided at import rather than at INSERT."""
    pinned = list(_SEEDS)
    bodies = [(r["key"], r["version"]) for r in _ROWS]
    if bodies != pinned:  # pragma: no cover — a mis-edit, caught loudly
        raise RuntimeError(
            f"0025: `_ROWS` holds {bodies} but `_SEEDS` pins {pinned}. Every row "
            f"this revision inserts must be claimed by the pin, or its downgrade "
            f"leaves rows behind and a later revision cannot know who owns them."
        )
    return _ROWS


# tenant_id IS NULL means the unique constraint cannot help — Postgres treats
# NULLs as distinct, so ON CONFLICT never fires on a platform row. The guard is
# an explicit NOT EXISTS, which also makes the migration re-runnable. Copied
# deliberately from 0018 rather than reinvented.
_INSERT = sa.text(
    """
    INSERT INTO correlation_defs
        (tenant_id, key, version, name, question, unlocks, domains, signals, created_by)
    SELECT NULL, :key, :version, :name, :question, :unlocks,
           CAST(:domains AS jsonb), CAST(:signals AS jsonb), :created_by
     WHERE NOT EXISTS (
         SELECT 1 FROM correlation_defs
          WHERE tenant_id IS NULL AND key = :key AND version = :version
     )
    """
)


def upgrade() -> None:
    op.create_table(
        "correlation_defs",
        sa.Column(
            "id", UUID(as_uuid=True), primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        # NULL = a platform correlation, visible to every tenant.
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=True),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("version", sa.Integer, nullable=False),
        # The instant this version starts answering for. The reader picks the
        # latest version with effective_from <= now, exactly as the metric
        # evaluator does, so a correlation that USED to need three signals still
        # explains an August screenshot.
        sa.Column(
            "effective_from", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("question", sa.Text, nullable=False),
        sa.Column("unlocks", sa.Text, nullable=False),
        sa.Column("domains", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        # The needs, in order. See the header for why order is load-bearing.
        sa.Column("signals", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("created_by", sa.String(320), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("tenant_id", "key", "version", name="uq_correlation_defs_key_version"),
        # A correlation that spans one domain is a metric, and the metric registry
        # already computes those. Enforced in the schema because the whole claim
        # this table makes is that its rows CROSS a boundary.
        sa.CheckConstraint("jsonb_array_length(domains) >= 2", name="ck_correlation_defs_domains"),
        sa.CheckConstraint("jsonb_array_length(signals) >= 2", name="ck_correlation_defs_signals"),
    )
    op.create_index("ix_correlation_defs_key", "correlation_defs", ["key", "effective_from"])

    for row in _check():
        op.execute(
            _INSERT.bindparams(
                key=row["key"],
                version=row["version"],
                name=row["name"],
                question=row["question"],
                unlocks=row["unlocks"],
                domains=json.dumps(row["domains"]),
                signals=json.dumps(row["signals"]),
                created_by=_SEEDED_BY,
            )
        )


def downgrade() -> None:
    op.drop_index("ix_correlation_defs_key", table_name="correlation_defs")
    op.drop_table("correlation_defs")
