"""The CCEI, as the methodology spec defines it — the pack, not the engine.

WHAT THIS IS
------------
`NEUBIT_CCEI_Methodology_Spec` v1.0 §2 and §4 define one composite over four
sub-indices over fourteen component metrics, each with a direction, a target, a
floor or worst value, a weight and a named data source. This module is that
definition AS DATA, in one place, so the migration that seeds the registry rows
and the test that checks them cannot drift apart: there is only one copy to
change, and changing it fails the test unless the spec moved with it.

Deliberately dependency-free — plain dicts, no SQLAlchemy, no alembic — because
both an Alembic migration and a pytest run import it.

WHY THE FOURTEEN LEAVES ARE NAMED BUT NOT DEFINED
-------------------------------------------------
Only the composites are seeded as registry rows. Every leaf is NAMED by its key
in its parent's component list and left undefined, which makes the evaluator
answer, per component, "no metric `plant_kw_per_tr` is effective at <t>" — and a
composite of a refusal is a refusal, so the site score is a dash that enumerates
exactly which of the fourteen the estate cannot yet measure, at their spec
weights.

That is the point. A leaf becomes a row when the estate can actually measure it,
and not one day earlier:

  * `temp_in_band`, `co2_in_band` and `humidity_in_band` are band-OCCUPANCY
    metrics and the `occupancy` kind now exists to express them — but none of
    the three has a sensor on this estate, so they stay named and undefined.
    `chw_delta_t_in_band` is the one of the four that DOES have its signal, and
    it is defined below.
  * `plant_kw_per_tr` needs chilled-water FLOW (TR = flow × ΔT / 3.517). No
    flow signal is bound on this estate.
  * `economizer_capture` needs return-air temperature, damper position and
    zone CO2. None is instrumented.
  * `consumption_vs_baseline` and `avoided_emissions` need a baseline, and the
    baseline rule is same-month-last-year — it needs ≥13 months of history.
  * `clean_energy_share` needs on-site/PPA/REC generation metering.
  * The four OPI leaves are the platform's OWN event trail (uptime heartbeats,
    alarm acknowledge/resolve timestamps, workflow outcomes). The registry's
    inputs read points and site facts; an event-bus input source does not exist.

Registering a stub that scores 0, or quietly dropping a component and
redistributing its weight onto the survivors, would both turn "we cannot measure
this" into a number. The spec's §7 coverage gate DOES redistribute — but it
redistributes around a component whose SENSOR went quiet for part of a window,
not around one that was never instrumented at all. Calling a single measured
metric "the Energy Efficiency Index" is the same class of error this whole
registry exists to prevent.
"""

from __future__ import annotations

# The citation every seeded row carries, so a definition can name its own source.
CITATION = (
    "NEUBIT, \"Command & Control Efficiency Index (CCEI) — Methodology "
    "Specification: Metric Definitions & Normalization Math\", Version 1.0 "
    "(Engineering & Product Reference), §2 (weights and bands) and §4 "
    "(sub-index component tables). Section 10 (V7 rule changes, adopted "
    "07-Jul-2026) revises how EEI and CPI inputs are MEASURED and priced; it "
    "leaves the composite, the weights and the normalization functions of §2/§3 "
    "unchanged."
)

# §2 — the scoring bands, carried on the composite for the reader that renders it.
BANDS = [
    {"name": "Excellent", "min": 85, "max": 100},
    {"name": "Good", "min": 75, "max": 84},
    {"name": "Fair", "min": 65, "max": 74},
    {"name": "Needs Work", "min": 0, "max": 64},
]

# §4 — each leaf: the key it is named by, and what it will take to define it.
# `blocked_by` is not decoration: it is the sentence an operator needs in order
# to know whether the gap is a field job, a config job or a build job.
LEAVES: dict[str, dict] = {
    # 4.1 Energy Efficiency
    "plant_kw_per_tr": {
        "label": "Plant efficiency (kW/TR)",
        "direction": "lower", "target": 0.60, "worst": 0.95,
        "source": "chiller kW, chilled-water flow, ΔT",
        "blocked_by": "no chilled-water FLOW signal is bound; TR = flow × ΔT / 3.517",
    },
    "chw_delta_t_in_band": {
        "label": "Chilled-water ΔT in the 5–7 °C band (%)",
        "direction": "higher", "target": 95, "floor": 60,
        "source": "CHW supply/return temperature",
        # DEFINED — see LEAF_DEFINITIONS. Kept in this table because the table
        # is the spec's component list, not a list of gaps.
    },
    "economizer_capture": {
        "label": "Economizer free-cooling capture (%)",
        "direction": "higher", "target": 90, "floor": 30,
        "source": "OAT, RAT, CO₂, damper position",
        "blocked_by": "return-air temperature, damper position and zone CO₂ are not instrumented",
    },
    "consumption_vs_baseline": {
        "label": "Consumption vs normalized baseline (% saved)",
        "direction": "higher", "target": 20, "floor": 0,
        "source": "kWh meter, weather, occupancy",
        "blocked_by": "the baseline is the same calendar month last year; that needs ≥13 months of history",
    },
    # 4.2 Operational Performance
    "equipment_uptime": {
        "label": "Equipment uptime (%)",
        "direction": "higher", "target": 99.5, "floor": 95,
        "source": "device heartbeat / health",
        "blocked_by": "sourced from the platform's own event trail; registry inputs read points and site facts only",
    },
    "alarm_mtta": {
        "label": "Alarm MTTA (min)",
        "direction": "lower", "target": 5, "worst": 30,
        "source": "event bus + acknowledge log",
        "blocked_by": "acknowledgement is a gateway-local mutation and is never published",
    },
    "alarm_mttr": {
        "label": "Alarm MTTR (min)",
        "direction": "lower", "target": 30, "worst": 180,
        "source": "event bus + resolve log",
        "blocked_by": "resolve timestamps are not published either",
    },
    "automation_success": {
        "label": "Automation / interlock success (%)",
        "direction": "higher", "target": 99, "floor": 80,
        "source": "workflow engine outcomes",
        "blocked_by": "workflow outcomes are not an input source the registry can name",
    },
    # 4.3 Carbon Performance
    "carbon_intensity": {
        "label": "Carbon intensity (kg CO₂/m²/yr)",
        "direction": "lower", "target": 9.0, "worst": 20.0,
        "source": "kWh × grid emission factor ÷ area",
        # DEFINED — see LEAF_DEFINITIONS.
    },
    "avoided_emissions": {
        "label": "Avoided emissions (% vs baseline)",
        "direction": "higher", "target": 25, "floor": 0,
        "source": "baseline model vs actual",
        "blocked_by": "same baseline gap as consumption_vs_baseline",
    },
    "clean_energy_share": {
        "label": "Clean-energy share (%)",
        "direction": "higher", "target": 40, "floor": 0,
        "source": "on-site / PPA / REC meters",
        "blocked_by": "no generation metering is bound as a clean-energy source",
    },
    # 4.4 Comfort & Compliance
    "temp_in_band": {
        "label": "Temperature in band (RAT ± 1.5 °C) (%)",
        "direction": "higher", "target": 95, "floor": 70,
        "source": "return-air temperature sensor",
        "blocked_by": "no zone or return-air temperature point exists on this estate",
    },
    "co2_in_band": {
        "label": "CO₂ in band (< 1000 ppm) (%)",
        "direction": "higher", "target": 98, "floor": 75,
        "source": "CO₂ sensor / DCV",
        "blocked_by": "no CO₂ point exists on this estate",
    },
    "humidity_in_band": {
        "label": "Humidity in band (40–60 % RH) (%)",
        "direction": "higher", "target": 95, "floor": 70,
        "source": "humidity sensor",
        "blocked_by": "no humidity point exists on this estate",
    },
}

# §4 — the four sub-indices and their component weights (each set sums to 1).
SUB_INDICES: dict[str, dict] = {
    "eei": {
        "label": "Energy Efficiency Index",
        "description": "Plant efficiency, ΔT health, free-cooling capture, consumption vs baseline.",
        "weight_in_ccei": 0.35,
        "components": [
            ("plant_kw_per_tr", 0.40),
            ("chw_delta_t_in_band", 0.25),
            ("economizer_capture", 0.20),
            ("consumption_vs_baseline", 0.15),
        ],
    },
    "opi": {
        "label": "Operational Performance Index",
        "description": "Equipment uptime, alarm response speed, automation reliability.",
        "weight_in_ccei": 0.25,
        "components": [
            ("equipment_uptime", 0.35),
            ("alarm_mtta", 0.20),
            ("alarm_mttr", 0.20),
            ("automation_success", 0.25),
        ],
    },
    "cpi": {
        "label": "Carbon Performance Index",
        "description": "Carbon intensity, avoided emissions, clean-energy share.",
        "weight_in_ccei": 0.20,
        "components": [
            ("carbon_intensity", 0.50),
            ("avoided_emissions", 0.30),
            ("clean_energy_share", 0.20),
        ],
    },
    "cci": {
        "label": "Comfort & Compliance Index",
        "description": "Time spent within temperature, CO₂ and humidity comfort bands.",
        "weight_in_ccei": 0.20,
        "components": [
            ("temp_in_band", 0.40),
            ("co2_in_band", 0.35),
            ("humidity_in_band", 0.25),
        ],
    },
}

# ── The leaves that ARE defined ──────────────────────────────────────────────
#
# `chw_delta_t_in_band` (EEI, weight 0.25) is the first of the fourteen the
# estate can actually measure: both chilled-water temperatures are bound to
# roles on every chiller.
#
# THE BAND IS 5–7 K, WHICH IS THE SPEC'S, NOT THE ONE THIS PLATFORM USED. The
# earlier `hvac_health` v1 graded |ΔT| against 3–7 K — a band chosen from
# general chilled-water practice when no spec was in hand. §4.1 states 5–7, so
# 5–7 it is; the old row keeps its own band, because versioning is data.
#
# `abs()` IS LOAD-BEARING. This platform defines ΔT as leaving − entering, which
# is NEGATIVE for a machine that is cooling, and the spec's band is stated on
# the magnitude. Taking the absolute value also means a chiller wired with its
# sensors swapped scores the same as one wired correctly — that is a real
# anomaly on this estate (1F York reads leaving WARMER than entering) and it is
# deliberately NOT this metric's job: a band-occupancy percentage that silently
# became a sign check would answer neither question well. The sign belongs to
# the plant-room investigation.
# `carbon_intensity` (CPI, weight 0.50) is the second. Its three inputs each
# come from a different kind of place, and that is the point of typing them:
#
#   energy  measured   — last − first over the site's confirmed kWh registers
#   factor  cited      — the grid emission factor row effective at the window's
#                        end, carrying the document an operator entered with it
#   area    recorded   — the site's gross floor area, an operator's assertion
#
# The score is `norm_down` against the spec's 9.0 target and 20.0 worst value
# (§4.3), so a site at or under 9 kg CO₂/m²/yr scores 100 and one at or over 20
# scores 0. `annualize()` scales the measured window to a year over the COVERED
# span, the same definition `/bi/rating` uses — the "/yr" in the unit is that
# call, not an assumption about how long the meter has been running.
LEAF_DEFINITIONS: dict[str, dict] = {
    "carbon_intensity": {
        "key": "carbon_intensity",
        "version": 1,
        "kind": "formula",
        "applies_to": {"scope": "site"},
        "inputs": {
            "energy": {"role": "energy_register", "unit": "kWh", "aggregation": "consumption"},
            "factor": {"source": "emission_factor", "unit": "kgCO2/kWh"},
            "area": {"fact": "gross_floor_area_sqm", "unit": "m2", "source": "site_fact"},
        },
        "formula": "norm_down(annualize(energy * factor / area), 9.0, 20.0)",
        "components": None,
        "output": {"dimension": "dimensionless"},
        "guards": ["units_confirmed"],
        "display": {
            "label": "Carbon intensity (kg CO₂/m²/yr)",
            "description": (
                "Annualized Scope-2 emissions per square metre, scored against the "
                "spec's 9.0 target and 20.0 worst value. Energy is measured, the "
                "emission factor is cited, the area is recorded — a missing one of "
                "the three refuses by name rather than being assumed."
            ),
            "precision": 1,
            "citation": CITATION,
        },
    },
    "chw_delta_t_in_band": {
        "key": "chw_delta_t_in_band",
        "version": 1,
        "kind": "occupancy",
        "applies_to": {"scope": "device", "category": "hvac", "device_type": "chiller"},
        "inputs": {
            "iwt": {"role": "inlet_water_temp", "dimension": "temperature", "aggregation": "avg"},
            "owt": {"role": "outlet_water_temp", "dimension": "temperature", "aggregation": "avg"},
        },
        "formula": "in_band(abs(owt - iwt), 5, 7)",
        "components": None,
        "output": {"dimension": "dimensionless"},
        # A frozen temperature pair has no ΔT to be in or out of a band; scoring
        # a dead sensor's constant as 100% in-band is precisely the five stars
        # for a dead meter this platform refuses elsewhere.
        "guards": ["units_confirmed", "same_unit", "non_frozen"],
        "display": {
            "label": "Chilled-water ΔT in the 5–7 °C band (%)",
            "description": (
                "Share of the window in which |leaving − entering| chilled-water "
                "temperature sat inside the spec's 5–7 K design band, counted per "
                "bucket (§3.3), not tested once on a window average."
            ),
            "precision": 1,
            "citation": CITATION,
        },
    },
}

CCEI_KEY = "ccei"
CCEI_VERSION = 2
SUB_INDEX_VERSION = 1


def definitions() -> list[dict]:
    """Every row this pack seeds, in insert order (children before the parent).

    Shaped exactly as `metric_definitions` stores a definition, so the registry's
    own `typecheck` can be run over the list without translation.
    """
    rows: list[dict] = list(LEAF_DEFINITIONS.values())
    for key, sub in SUB_INDICES.items():
        rows.append(
            {
                "key": key,
                "version": SUB_INDEX_VERSION,
                "kind": "composite",
                "applies_to": {"scope": "site"},
                "inputs": {},
                "formula": None,
                "components": [{"metric": m, "weight": w} for m, w in sub["components"]],
                "output": {"dimension": "dimensionless"},
                "guards": [],
                "display": {
                    "label": sub["label"],
                    "description": sub["description"],
                    "precision": 1,
                    "citation": CITATION,
                    "components": {
                        m: {"weight": w, **LEAVES[m]} for m, w in sub["components"]
                    },
                },
            }
        )
    rows.append(
        {
            "key": CCEI_KEY,
            "version": CCEI_VERSION,
            "kind": "composite",
            "applies_to": {"scope": "site"},
            "inputs": {},
            "formula": None,
            "components": [
                {"metric": k, "weight": s["weight_in_ccei"]} for k, s in SUB_INDICES.items()
            ],
            "output": {"dimension": "dimensionless"},
            "guards": [],
            "display": {
                "label": "Command & Control Efficiency Index",
                "description": (
                    "0.35·EEI + 0.25·OPI + 0.20·CPI + 0.20·CCI — one 0–100 score per "
                    "site, over four sub-indices and fourteen component metrics."
                ),
                "precision": 0,
                "citation": CITATION,
                "bands": BANDS,
            },
        }
    )
    return rows
