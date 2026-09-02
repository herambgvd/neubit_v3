"""Unit algebra — the type system a metric definition is checked against.

WHAT THIS IS FOR
----------------
A formula over point roles is only meaningful if the quantities compose:
`OWT − IWT` is a temperature difference; `kWh − °C` is nothing at all. This
module decides that at DEFINITION time — a spec that cannot type-check is
rejected on insert, not discovered as a wrong number on a screen.

THE RULES, EXACTLY
------------------
* Every unit maps to a DIMENSION (`degC` → temperature). The table below is
  closed and deliberately small: it covers what this estate's points can carry.
  An unknown unit does not type-check, loudly.
* temperature − temperature = temperature_delta. That is a DIFFERENT dimension
  on purpose: a ΔT of 3 K and a water temperature of 3 °C must never average
  together, and the type system is where that is enforced.
* temperature + temperature is REFUSED — the sum of two absolute temperatures
  is not a quantity.
* Same dimension, DIFFERENT unit (°C vs °F) is REFUSED. Conversion is not
  modelled in this iteration, so nothing converts silently; the refusal says so.
  Where a unit is unknown at registration (an input declared by dimension only)
  the check is deferred to the evaluator's `same_unit` guard.
* Multiplication/division compose through a closed table (energy / area,
  anything × dimensionless, X / X → ratio). A product that is not in the table
  is refused with instructions to model it deliberately — never guessed.
"""

from __future__ import annotations

from dataclasses import dataclass

# ── Dimension table ──────────────────────────────────────────────────────────
#
# unit string (as the operator confirms it on /bi/units) → dimension. The empty
# string is a REAL unit here: it is what a power factor confirms as (a ratio).
UNIT_DIMENSION: dict[str, str] = {
    # temperature — absolute
    "degC": "temperature",
    "degF": "temperature",
    "K": "temperature",
    # energy
    "Wh": "energy",
    "kWh": "energy",
    "MWh": "energy",
    "kVAh": "apparent_energy",
    # power
    "W": "power",
    "kW": "power",
    "MW": "power",
    "kVA": "apparent_power",
    # electrical
    "Hz": "frequency",
    "V": "voltage",
    "A": "current",
    # geometry / volume (site facts, water)
    "m2": "area",
    "m3": "volume",
    "L": "volume",
    # ratio — what `_pf` confirms as
    "": "dimensionless",
}

# The delta unit produced by subtracting two absolute temperatures in a given
# unit. A kelvin IS a Celsius-degree of difference; Fahrenheit keeps its own.
_DELTA_UNIT: dict[str, str] = {"degC": "K", "K": "K", "degF": "degF_delta"}
UNIT_DIMENSION["degF_delta"] = "temperature_delta"
# `K` stays "temperature" in the table above (an absolute kelvin reading), but a
# COMPUTED delta carries dimension temperature_delta explicitly via Qty below.

KNOWN_DIMENSIONS = sorted(
    set(UNIT_DIMENSION.values())
    | {"temperature_delta", "energy_per_area", "dimensionless"}
)


class DimensionError(ValueError):
    """A spec that does not type-check. Raised at registration, shown verbatim."""


@dataclass(frozen=True)
class Qty:
    """A quantity in the algebra: a dimension, and a unit when one is known.

    ``unit=None`` means "declared by dimension only" — legal in a definition
    (the exact unit is whatever the operator confirmed on the points), and the
    reason the evaluator re-checks `same_unit` at run time.
    """

    dimension: str
    unit: str | None = None


def qty_of_unit(unit: str) -> Qty:
    dim = UNIT_DIMENSION.get(unit)
    if dim is None:
        raise DimensionError(
            f"unit `{unit}` is not in the dimension table; add it deliberately "
            f"before a definition can use it"
        )
    return Qty(dim, unit)


DIMENSIONLESS = Qty("dimensionless", "")


def _same_unit_or_refuse(a: Qty, b: Qty, op: str) -> str | None:
    """Unit both sides must share, or None when either side is unit-open."""
    if a.unit is None or b.unit is None:
        return a.unit if a.unit is not None else b.unit
    if a.unit != b.unit:
        raise DimensionError(
            f"`{a.unit}` {op} `{b.unit}`: same dimension but different units — "
            f"conversion is not modelled, so this is refused rather than "
            f"converted silently"
        )
    return a.unit


def add_sub(op: str, a: Qty, b: Qty) -> Qty:
    """`a + b` / `a − b`. The temperature rules live here."""
    if a.dimension == "temperature" and b.dimension == "temperature":
        if op == "+":
            raise DimensionError(
                "the sum of two absolute temperatures is not a quantity; "
                "only their DIFFERENCE is"
            )
        unit = _same_unit_or_refuse(a, b, "−")
        return Qty("temperature_delta", _DELTA_UNIT.get(unit) if unit else None)
    # absolute ± delta → absolute (an offset applied to a reading)
    pair = {a.dimension, b.dimension}
    if pair == {"temperature", "temperature_delta"}:
        if op == "-" and a.dimension == "temperature_delta":
            raise DimensionError("a temperature delta minus an absolute temperature is not a quantity")
        return Qty("temperature", a.unit if a.dimension == "temperature" else b.unit)
    if a.dimension != b.dimension:
        raise DimensionError(
            f"cannot {'add' if op == '+' else 'subtract'} `{a.dimension}` and "
            f"`{b.dimension}` — different dimensions"
        )
    unit = _same_unit_or_refuse(a, b, op)
    return Qty(a.dimension, unit)


# Closed product table: (dimension ÷ dimension) → result dimension. Anything not
# here is refused. The evaluator and the registration check both go through it.
_DIV_TABLE: dict[tuple[str, str], str] = {
    ("energy", "area"): "energy_per_area",
}


def mul_div(op: str, a: Qty, b: Qty) -> Qty:
    """`a × b` / `a ÷ b` through the closed table."""
    if b.dimension == "dimensionless":
        return Qty(a.dimension, a.unit)
    if a.dimension == "dimensionless" and op == "*":
        return Qty(b.dimension, b.unit)
    if op == "/":
        if a.dimension == b.dimension:
            # same-dimension ratio; unit sameness enforced when both known
            _same_unit_or_refuse(a, b, "÷")
            return DIMENSIONLESS
        result = _DIV_TABLE.get((a.dimension, b.dimension))
        if result is not None:
            u = f"{a.unit}/{b.unit}" if a.unit and b.unit else None
            return Qty(result, u)
    raise DimensionError(
        f"`{a.dimension}` {'×' if op == '*' else '÷'} `{b.dimension}` is not in "
        f"the dimension product table — model it deliberately before a "
        f"definition can use it"
    )


def compatible(declared: Qty, inferred: Qty) -> bool:
    """Does the formula's inferred quantity satisfy the declared output?"""
    if declared.dimension != inferred.dimension:
        return False
    if declared.unit is not None and inferred.unit is not None:
        return declared.unit == inferred.unit
    return True
