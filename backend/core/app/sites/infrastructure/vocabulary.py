"""The infra designer's CLOSED vocabulary: system kinds, equipment classes, point
slots and design facts.

WHY CLOSED
----------
Every word here is a word something downstream is written against. The BI
evaluator will read ``design_dt_min`` off a ``chiller``; a plant schematic will
draw a ``cooling_tower`` on the condenser side of a ``chw_plant``; kW/TR divides a
chiller's ``kw`` slot by its ``tr`` fact. A free-text class — "Chiller", "CH",
"chiller (screw)" — would be stored, returned and rendered exactly like one of
these, and mean nothing to any of them. That is worse than refusing it, because
it LOOKS like data. So this module is the only place a word is admitted, the API
and the schedule importer both validate against it, and growing it is a code
change somebody reviews. ``metric_registry/roles.py`` in reading-writer keeps
``ROLE_DEFS`` closed for the same reason.

THREE LAYERS, EACH NARROWING THE NEXT
-------------------------------------
* a SYSTEM KIND says which equipment classes may sit in it — a DG set is not part
  of a chilled-water loop;
* an EQUIPMENT CLASS says which slots and which design facts it may carry — a
  pump has no ΔT design band and a header has no TR;
* a SLOT says what dimension the point bound to it measures. A slot has no UNIT:
  the unit belongs to the point and is confirmed in the reporting store
  (``points.unit_source``). A DESIGN FACT does have one, because its value is
  stored here and a bare 150 is not a capacity.

NOTHING HERE IS A VALUE. There is no default TR, no "typical" ΔT band, no rated
kW. A fact exists on a piece of equipment because an operator typed it or a
schedule stated it.
"""

from __future__ import annotations

import math
from typing import Any

# ── system kinds ─────────────────────────────────────────────────────────────

SYSTEM_KINDS: dict[str, dict[str, str]] = {
    "chw_plant": {
        "label": "Chilled-water plant loop",
        "description": (
            "One chilled-water loop: the chillers, cooling towers, pumps and headers "
            "that serve it. A building with two independent plants has two."
        ),
    },
    "air_handling": {
        "label": "Air handling",
        "description": "AHUs, treated-fresh-air units and FCUs.",
    },
    "power": {
        "label": "Power chain",
        "description": "Energy meters, DG sets and PV inverters.",
    },
    "water": {
        "label": "Water systems",
        "description": "Pumps of the domestic, hydro-pneumatic, sewage and similar systems.",
    },
}

# ── point slots ──────────────────────────────────────────────────────────────
#
# `role` names the reading-writer ROLE_DEFS entry the slot corresponds to, where
# one exists, so the evaluator can join the two vocabularies without a lookup
# table of its own. On a chiller evaporator the water LEAVING is the supply
# (chws) and the water ENTERING is the return (chwr), which is why chws maps to
# `outlet_water_temp` and not the other way round.

SLOTS: dict[str, dict[str, Any]] = {
    "chws": {"dimension": "temperature", "label": "CHW supply (leaving) temperature",
             "role": "outlet_water_temp"},
    "chwr": {"dimension": "temperature", "label": "CHW return (entering) temperature",
             "role": "inlet_water_temp"},
    "cws": {"dimension": "temperature", "label": "Condenser water supply temperature",
            "role": None},
    "cwr": {"dimension": "temperature", "label": "Condenser water return temperature",
            "role": None},
    "kw": {"dimension": "power", "label": "Active power", "role": "active_power"},
    "kwh": {"dimension": "energy", "label": "Lifetime energy register",
            "role": "energy_register"},
    "load": {"dimension": "percent", "label": "Load", "role": None},
    "run_status": {"dimension": "state", "label": "Run status", "role": None},
    "trip": {"dimension": "state", "label": "Trip / common fault", "role": None},
    "speed": {"dimension": "percent", "label": "VFD speed", "role": None},
    "dp": {"dimension": "pressure", "label": "Differential pressure", "role": None},
    "sat": {"dimension": "temperature", "label": "Supply air temperature", "role": None},
    "rat": {"dimension": "temperature", "label": "Return air temperature", "role": None},
    "chw_valve": {"dimension": "percent", "label": "CHW valve position", "role": None},
    "filter_dp": {"dimension": "pressure", "label": "Filter differential pressure",
                  "role": None},
    "duct_static": {"dimension": "pressure", "label": "Duct static pressure", "role": None},
    "co2": {"dimension": "concentration", "label": "CO2", "role": None},
    "room_temp": {"dimension": "temperature", "label": "Room temperature", "role": None},
    "room_temp_setpoint": {"dimension": "temperature", "label": "Room temperature setpoint",
                           "role": None},
    "fuel_level": {"dimension": "percent", "label": "Fuel level", "role": None},
}

# ── design facts ─────────────────────────────────────────────────────────────
#
# `type` is "number" or "text". `unit` is the unit the stored number IS IN — not a
# display preference: `tr` is refrigeration tons and nothing converts it. The ΔT
# band is in kelvin because it is a temperature DIFFERENCE, where one kelvin and
# one degree Celsius are the same size; stating °C would invite someone to add
# 273.15 to it.

DESIGN_FACTS: dict[str, dict[str, Any]] = {
    "make": {"type": "text", "unit": None, "label": "Make"},
    "model": {"type": "text", "unit": None, "label": "Model"},
    "tr": {"type": "number", "unit": "TR", "label": "Rated capacity (refrigeration tons)"},
    "kw_rated": {"type": "number", "unit": "kW", "label": "Rated power"},
    "kva_rated": {"type": "number", "unit": "kVA", "label": "Rated apparent power"},
    "design_dt_min": {"type": "number", "unit": "K",
                      "label": "Design CHW ΔT, lower bound"},
    "design_dt_max": {"type": "number", "unit": "K",
                      "label": "Design CHW ΔT, upper bound"},
}

#: The one pair of facts that is meaningless alone: half a band is not a band.
DT_BAND = ("design_dt_min", "design_dt_max")

TEXT_FACT_MAX = 100

# ── equipment classes ────────────────────────────────────────────────────────

_PUMP_SLOTS = ("run_status", "trip", "speed", "kw", "kwh")
_PUMP_FACTS = ("make", "model", "kw_rated")

EQUIPMENT_CLASSES: dict[str, dict[str, Any]] = {
    "chiller": {
        "label": "Chiller",
        "system_kinds": ("chw_plant",),
        "slots": ("chws", "chwr", "cws", "cwr", "kw", "kwh", "load", "run_status", "trip"),
        "facts": ("make", "model", "tr", "kw_rated", "design_dt_min", "design_dt_max"),
    },
    "cooling_tower": {
        "label": "Cooling tower",
        "system_kinds": ("chw_plant",),
        "slots": ("cws", "cwr", "speed", "kw", "kwh", "run_status", "trip"),
        "facts": ("make", "model", "tr", "kw_rated"),
    },
    "chw_primary_pump": {
        "label": "Primary CHW pump",
        "system_kinds": ("chw_plant",),
        "slots": _PUMP_SLOTS,
        "facts": _PUMP_FACTS,
    },
    "chw_secondary_pump": {
        "label": "Secondary CHW pump",
        "system_kinds": ("chw_plant",),
        "slots": _PUMP_SLOTS,
        "facts": _PUMP_FACTS,
    },
    "condenser_pump": {
        "label": "Condenser water pump",
        "system_kinds": ("chw_plant",),
        "slots": _PUMP_SLOTS,
        "facts": _PUMP_FACTS,
    },
    "chw_header": {
        "label": "CHW header",
        "system_kinds": ("chw_plant",),
        "slots": ("chws", "chwr", "dp"),
        "facts": (),
    },
    "ahu": {
        "label": "Air handling unit",
        "system_kinds": ("air_handling",),
        "slots": ("run_status", "trip", "speed", "sat", "rat", "chw_valve", "filter_dp",
                  "duct_static", "co2", "kw", "kwh"),
        "facts": ("make", "model", "kw_rated"),
    },
    "tfa": {
        "label": "Treated fresh air unit",
        "system_kinds": ("air_handling",),
        "slots": ("run_status", "trip", "speed", "sat", "filter_dp", "duct_static",
                  "kw", "kwh"),
        "facts": ("make", "model", "kw_rated"),
    },
    "fcu": {
        "label": "Fan coil unit",
        "system_kinds": ("air_handling",),
        "slots": ("run_status", "room_temp", "room_temp_setpoint", "chw_valve"),
        "facts": ("make", "model"),
    },
    "energy_meter": {
        "label": "Energy meter",
        "system_kinds": ("power",),
        "slots": ("kw", "kwh"),
        "facts": ("make", "model"),
    },
    "dg_set": {
        "label": "Diesel generator",
        "system_kinds": ("power",),
        "slots": ("run_status", "trip", "kw", "kwh", "fuel_level"),
        "facts": ("make", "model", "kva_rated"),
    },
    "pv_inverter": {
        "label": "PV inverter",
        "system_kinds": ("power",),
        "slots": ("run_status", "trip", "kw", "kwh"),
        "facts": ("make", "model", "kw_rated"),
    },
    "water_pump": {
        "label": "Water pump",
        "system_kinds": ("water",),
        "slots": _PUMP_SLOTS,
        "facts": _PUMP_FACTS,
    },
}


# ── the checks, shared by the API schemas and the schedule importer ──────────
#
# Each raises ValueError with a sentence an operator can act on. Pydantic turns
# that into a 422 on the API; the importer turns it into a skipped row with the
# same sentence. One wording, so the designer screen and the import report never
# disagree about why something was refused.


def check_system_kind(kind: str) -> str:
    if kind not in SYSTEM_KINDS:
        raise ValueError(
            f"unknown system kind {kind!r}; expected one of: {', '.join(sorted(SYSTEM_KINDS))}"
        )
    return kind


def check_equipment_class(equipment_class: str) -> str:
    if equipment_class not in EQUIPMENT_CLASSES:
        raise ValueError(
            f"unknown equipment class {equipment_class!r}; expected one of: "
            f"{', '.join(sorted(EQUIPMENT_CLASSES))}"
        )
    return equipment_class


def check_class_in_kind(equipment_class: str, kind: str) -> None:
    allowed = EQUIPMENT_CLASSES[equipment_class]["system_kinds"]
    if kind not in allowed:
        raise ValueError(
            f"a {equipment_class} cannot sit in a {kind} system; it belongs in: "
            f"{', '.join(allowed)}"
        )


def check_slot(equipment_class: str, slot: str) -> str:
    if slot not in SLOTS:
        raise ValueError(
            f"unknown slot {slot!r}; expected one of: {', '.join(sorted(SLOTS))}"
        )
    allowed = EQUIPMENT_CLASSES[equipment_class]["slots"]
    if slot not in allowed:
        raise ValueError(
            f"a {equipment_class} has no {slot!r} slot; its slots are: {', '.join(allowed)}"
        )
    return slot


def _is_number(v: Any) -> bool:
    # bool is an int subclass; True is not a capacity.
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def check_fact(equipment_class: str, key: str, value: Any) -> Any:
    """One design fact, alone: known, allowed on this class, right type and range.

    Returns the cleaned value. The ΔT BAND is not checked here — its two halves
    are one statement and ``check_design`` checks them together.
    """
    spec = DESIGN_FACTS.get(key)
    if spec is None:
        raise ValueError(
            f"unknown design fact {key!r}; expected one of: {', '.join(sorted(DESIGN_FACTS))}"
        )
    allowed = EQUIPMENT_CLASSES[equipment_class]["facts"]
    if key not in allowed:
        raise ValueError(
            f"a {equipment_class} has no {key!r} design fact; its facts are: "
            f"{', '.join(allowed) or 'none'}"
        )
    if spec["type"] == "number":
        if not _is_number(value) or not math.isfinite(value):
            raise ValueError(f"{key} must be a finite number, got {value!r}")
        if key == "design_dt_min":
            if value < 0:
                raise ValueError("design_dt_min cannot be negative")
        elif value <= 0:
            raise ValueError(f"{key} must be greater than zero")
        return value
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be non-empty text")
    if len(value.strip()) > TEXT_FACT_MAX:
        raise ValueError(f"{key} must be {TEXT_FACT_MAX} characters or fewer")
    return value.strip()


def check_design(equipment_class: str, design: dict[str, Any] | None) -> dict[str, Any]:
    """Validate a design-fact set for one class and return it cleaned.

    A key whose value is None is dropped: absent and null mean the same thing
    here, "not recorded", and storing a null would make every reader test for two
    spellings of one state. Numbers must already BE numbers — the string "150" is
    refused, not parsed, because a spreadsheet cell holding text where a number was
    meant is exactly the row a human should look at.
    """
    if design is None:
        return {}
    if not isinstance(design, dict):
        raise ValueError("design must be an object of design facts")
    out = {
        key: check_fact(equipment_class, key, value)
        for key, value in design.items()
        if value is not None
    }
    lo, hi = (out.get(k) for k in DT_BAND)
    if (lo is None) != (hi is None):
        raise ValueError("design_dt_min and design_dt_max are a band: give both or neither")
    if lo is not None and not lo < hi:
        raise ValueError("design_dt_min must be less than design_dt_max")
    return out


def units_of(design: dict[str, Any]) -> dict[str, str]:
    """The unit of every NUMERIC fact present, for a consumer that must not assume one."""
    return {
        k: DESIGN_FACTS[k]["unit"]
        for k in design
        if k in DESIGN_FACTS and DESIGN_FACTS[k]["unit"] is not None
    }


def as_document() -> dict[str, Any]:
    """The whole vocabulary, as the designer screen reads it."""
    return {
        "system_kinds": [{"key": k, **v} for k, v in SYSTEM_KINDS.items()],
        "equipment_classes": [
            {
                "key": k,
                "label": v["label"],
                "system_kinds": list(v["system_kinds"]),
                "slots": list(v["slots"]),
                "facts": list(v["facts"]),
            }
            for k, v in EQUIPMENT_CLASSES.items()
        ],
        "slots": [{"key": k, **v} for k, v in SLOTS.items()],
        "design_facts": [{"key": k, **v} for k, v in DESIGN_FACTS.items()],
    }
