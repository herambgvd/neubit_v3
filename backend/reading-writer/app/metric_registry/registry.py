"""The metric definition store — where a metric is a ROW.

Two rules this module exists to enforce, both at WRITE time:

1. **A definition that cannot type-check does not get in.** The formula is
   parsed against the whitelist grammar, every name it uses must be a declared
   input, and the dimension algebra must produce the declared output. `kWh −
   °C` is rejected HERE, on insert, with the dimension error verbatim — never
   discovered as a wrong number at render.

2. **A formula change is a NEW VERSION.** `(key, version)` is unique and a
   version carries its own `effective_from`. Recomputing yesterday's window
   with today's formula would be silent history rewriting, so the evaluator
   selects the version whose `effective_from` is latest among those ≤ the
   evaluated instant — an old window keeps the formula it was measured under.

Definitions with `tenant_id IS NULL` are PLATFORM definitions (seeded by
migration) and visible to every tenant; a tenant's own definitions shadow
nothing — keys are unique per (tenant, key, version) and a tenant sees the
union.
"""

from __future__ import annotations

import json
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..api.queries import _rows
from . import expr
from .roles import ROLE_DEFS
from .slots import EQUIPMENT_CLASSES, EQUIPMENT_FACT_DEFS, SLOT_DEFS
from .units import DimensionError, Qty, compatible, qty_of_unit

KINDS = ("formula", "composite", "occupancy")

# An `occupancy` metric answers "what fraction of the window was this quantity
# inside its band?" — CCEI methodology spec §3.3, `band% = Σ minutes within band
# / Σ valid minutes`. It is NOT a formula with a different output: the formula is
# evaluated PER BUCKET and the answer is the mean of the resulting ones and
# zeros. Aggregating first and testing the band once would answer a different
# question — an average ΔT can sit inside a band that the instantaneous ΔT was
# outside for half the window.

# Guards a definition may require. Each is mechanized in the evaluator; a guard
# string outside this set is a typo that would silently never fire, so it is
# rejected at registration like everything else.
GUARDS = ("roles_present", "units_confirmed", "same_unit", "non_frozen")

# Site facts a SITE-scope definition may name as inputs (`source: "site_fact"`).
# Closed, like the role vocabulary and for the same reason: an open string
# would let a formula name a column nobody mirrors. Each carries the unit the
# type-checker binds the input to, and WHERE the fact is recorded — the
# evaluator prints that in the refusal when the fact is NULL.
FACT_DEFS: dict[str, dict] = {
    "gross_floor_area_sqm": {
        "unit": "m2",
        "label": "Gross floor area",
        "recorded_at": "Configurations → Sites → Building",
    },
    "occupancy": {
        "unit": "",
        "label": "Occupancy",
        "recorded_at": "Configurations → Sites → Building",
    },
}

# Applies-to scopes. "device" evaluates per device (the §20 shape); "site"
# evaluates per site over the `site_facts` mirror — inputs may then be
# site facts and site-wide role bindings, and a composite fans a device-scope
# component out over the site's devices (contract §21).
#
# "equipment" evaluates per piece of EQUIPMENT in the registry mirror
# (`site_equipment`, fed from core's equipment registry). Its measured inputs are
# the equipment's own SLOTS (`source: "slot"`), resolved to a point by
# `slots.resolve` over the evaluated window, and its facts are the equipment's
# own design facts (`source: "equipment_fact"`) — the same shape a site fact has
# at site scope, one level down. `applies_to.equipment_class` names which class
# it applies to, from the same closed vocabulary core validates against.
SCOPES = ("device", "site", "equipment")


class RegistrationError(ValueError):
    """The definition is rejected, with the reason. Nothing is stored."""


def _qty_from_spec(spec: dict, where: str) -> Qty:
    """`{"unit": "degC"}` or `{"dimension": "temperature"}` → Qty."""
    unit = spec.get("unit")
    dim = spec.get("dimension")
    if unit is not None:
        q = qty_of_unit(unit)
        if dim is not None and dim != q.dimension:
            raise RegistrationError(
                f"{where}: unit `{unit}` is `{q.dimension}`, not the declared `{dim}`"
            )
        return q
    if dim is None:
        raise RegistrationError(f"{where}: needs a `unit` or a `dimension`")
    from .units import KNOWN_DIMENSIONS

    if dim not in KNOWN_DIMENSIONS:
        raise RegistrationError(
            f"{where}: dimension `{dim}` is not in the dimension table ({', '.join(KNOWN_DIMENSIONS)})"
        )
    return Qty(dim, None)


_AGGREGATIONS = ("avg", "last", "first", "min", "max", "sum", "consumption")


def _check_guards(guards: list) -> None:
    """Every guard named must be one this evaluator actually enforces.

    A guard that is only documentation reads, on the screen, exactly like one
    that runs.
    """
    for g in guards:
        if g not in GUARDS:
            raise RegistrationError(f"guard `{g}` is not mechanized; known guards: {', '.join(GUARDS)}")


def _check_occupancy_shape(defn: dict, scope: str, declared: Qty) -> None:
    """The formula must BE the band test.

    Anything else would be scored as a fraction of buckets where an arbitrary
    expression was non-zero, which is not what a reader of "% in band" is
    being told.
    """
    if not (defn.get("formula") or "").strip():
        raise RegistrationError("an occupancy metric needs a formula")
    try:
        tree = expr.parse(defn["formula"])
    except expr.ExprError as exc:
        raise RegistrationError(str(exc)) from exc
    import ast as _ast

    root = tree.body
    if not (isinstance(root, _ast.Call) and isinstance(root.func, _ast.Name)
            and root.func.id == "in_band"):
        raise RegistrationError(
            "an occupancy metric's formula must be a single `in_band(x, lo, hi)` "
            "call — the band is the metric"
        )
    if scope == "site":
        # Honest limit rather than a silent wrong answer: the site-scope
        # evaluator has no per-bucket path yet, so a site-scope occupancy
        # would have to aggregate first, which is the exact mistake this
        # kind exists to avoid. A site rolls these up through a composite,
        # which fans device- and equipment-scope components over the site.
        # (Equipment scope shares the device path's per-bucket machinery —
        # one point per input, bucket-aligned — so it is allowed.)
        raise RegistrationError(
            "occupancy is device-scope only today (or equipment-scope, which "
            "shares the device path's per-bucket series); roll it up to a site "
            "through a composite"
        )
    if declared.dimension != "dimensionless":
        raise RegistrationError(
            f"an occupancy metric outputs a percentage of time and is "
            f"`dimensionless`, not `{declared.dimension}`"
        )


def _check_composite_components(defn: dict) -> None:
    """A composite is components and weights — and nothing else."""
    comps = defn.get("components") or []
    if not comps:
        raise RegistrationError("a composite needs at least one component")
    for c in comps:
        if not c.get("metric") or not isinstance(c.get("weight"), (int, float)):
            raise RegistrationError("each component needs a `metric` key and a numeric `weight`")
    if defn.get("formula"):
        raise RegistrationError("a composite has components and weights, not a formula")


def _site_fact_qty(name: str, spec: dict, scope: str) -> Qty:
    """A fact about the SITE, read from the site_facts mirror — legal only on a
    site-scope definition, because a device has no area."""
    if scope != "site":
        raise RegistrationError(
            f"input `{name}` reads a site fact, which needs applies_to.scope = 'site'"
        )
    fact = spec.get("fact")
    fact_def = FACT_DEFS.get(fact or "")
    if fact_def is None:
        raise RegistrationError(
            f"input `{name}` names site fact `{fact}`, which is not in the "
            f"fact vocabulary ({', '.join(sorted(FACT_DEFS))})"
        )
    q = _qty_from_spec(spec, f"input `{name}`")
    expected = qty_of_unit(fact_def["unit"])
    if q.dimension != expected.dimension:
        raise RegistrationError(
            f"input `{name}`: site fact `{fact}` is `{expected.dimension}`, "
            f"but the input declares `{q.dimension}`"
        )
    if spec.get("aggregation") is not None:
        raise RegistrationError(
            f"input `{name}`: a site fact is a single recorded value; "
            f"it takes no aggregation"
        )
    return q


def _emission_factor_qty(name: str, spec: dict, scope: str) -> Qty:
    """The site's grid emission factor.

    NOT a site fact: it is versioned data with its own citation and effective
    date, mirrored from core into `site_emission_factors`, and the evaluator
    resolves the row effective at the window's end. Modelling it as a fact
    would flatten a dated, sourced series into one editable number.
    """
    if scope != "site":
        raise RegistrationError(
            f"input `{name}` reads the site's emission factor, which "
            f"needs applies_to.scope = 'site'"
        )
    q = _qty_from_spec(spec, f"input `{name}`")
    if q.dimension != "emission_factor":
        raise RegistrationError(
            f"input `{name}`: an emission factor is `emission_factor` "
            f"(kg CO2 per kWh), not `{q.dimension}`"
        )
    if spec.get("aggregation") is not None:
        raise RegistrationError(
            f"input `{name}`: an emission factor is one recorded value "
            f"for the window; it takes no aggregation"
        )
    return q


def _slot_input_qty(name: str, spec: dict, scope: str) -> Qty:
    """A measured input read through one of the equipment's own SLOTS."""
    if scope != "equipment":
        raise RegistrationError(
            f"input `{name}` reads an equipment slot, which needs "
            f"applies_to.scope = 'equipment'"
        )
    slot = spec.get("slot")
    slot_def = SLOT_DEFS.get(slot or "")
    if slot_def is None:
        raise RegistrationError(
            f"input `{name}` names slot `{slot}`, which is not in the slot "
            f"vocabulary ({', '.join(sorted(SLOT_DEFS))})"
        )
    if slot_def["dimension"] is None:
        raise RegistrationError(
            f"input `{name}`: slot `{slot}` ({slot_def['label']}) is not a quantity "
            f"the dimension algebra can compose, so no formula may read it"
        )
    q = _qty_from_spec(spec, f"input `{name}`")
    if q.dimension != slot_def["dimension"]:
        raise RegistrationError(
            f"input `{name}`: slot `{slot}` carries `{slot_def['dimension']}`, "
            f"but the input declares `{q.dimension}`"
        )
    agg = spec.get("aggregation", "avg")
    # One point per slot, so the register-summing `consumption` has nothing to
    # sum — and it exists only on the site path, for the reason given below.
    if agg not in _AGGREGATIONS or agg == "consumption":
        raise RegistrationError(
            f"input `{name}`: aggregation `{agg}` is not available on a slot input"
        )
    return q


def _equipment_fact_qty(name: str, spec: dict, scope: str) -> Qty:
    """A design fact recorded on the equipment itself — its TR, its ΔT band.

    The quantity comes from the fact vocabulary, not from the input: the input
    must DECLARE the dimension it expects and the two must agree, so an author
    who thinks `design_dt_min` is an absolute temperature is told otherwise here
    rather than by a band that never contains anything.
    """
    if scope != "equipment":
        raise RegistrationError(
            f"input `{name}` reads an equipment design fact, which needs "
            f"applies_to.scope = 'equipment'"
        )
    fact = spec.get("fact")
    fact_def = EQUIPMENT_FACT_DEFS.get(fact or "")
    if fact_def is None:
        raise RegistrationError(
            f"input `{name}` names design fact `{fact}`, which is not a numeric "
            f"fact in the vocabulary ({', '.join(sorted(EQUIPMENT_FACT_DEFS))})"
        )
    want = fact_def["qty"]
    declared = spec.get("dimension")
    if declared is None:
        raise RegistrationError(f"input `{name}`: declare the `dimension` the fact must be")
    if declared != want.dimension:
        raise RegistrationError(
            f"input `{name}`: design fact `{fact}` is `{want.dimension}` "
            f"(in `{want.unit}`), but the input declares `{declared}`"
        )
    if spec.get("aggregation") is not None:
        raise RegistrationError(
            f"input `{name}`: a design fact is one recorded value; it takes no aggregation"
        )
    return want


def _role_input_qty(name: str, spec: dict, scope: str) -> Qty:
    """A measured input: the role it binds points by, and what that role carries."""
    role = spec.get("role")
    if role is None:
        raise RegistrationError(f"input `{name}` needs a `role` to bind points by")
    role_def = ROLE_DEFS.get(role)
    if role_def is None:
        raise RegistrationError(
            f"input `{name}` names role `{role}`, which is not in the role vocabulary"
        )
    q = _qty_from_spec(spec, f"input `{name}`")
    if q.dimension != role_def["dimension"]:
        raise RegistrationError(
            f"input `{name}`: role `{role}` carries `{role_def['dimension']}`, "
            f"but the input declares `{q.dimension}`"
        )
    agg = spec.get("aggregation", "avg")
    if agg not in _AGGREGATIONS:
        raise RegistrationError(f"input `{name}`: aggregation `{agg}` is not one of {_AGGREGATIONS}")
    # last − first per register, monotonic-guarded, summed over every
    # point bound to the role in scope. Meaningful only for cumulative
    # ENERGY registers — a consumption of a temperature is nothing.
    if agg == "consumption" and q.dimension != "energy":
        raise RegistrationError(
            f"input `{name}`: aggregation `consumption` is a register "
            f"subtraction and needs dimension `energy`, not `{q.dimension}`"
        )
    # `consumption` exists on the SITE path only: it sums the registers a role
    # binds across a site, which is a different shape from the device path's
    # one-point-per-role binding and is implemented only there. Registered at
    # device scope it type-checked here and then died in the evaluator on a
    # missing aggregate column — an uncaught 500 out of a module whose whole
    # contract is a structured refusal. The definition is refused when it is
    # WRITTEN instead, which is the only moment an author can act on it.
    if agg == "consumption" and scope != "site":
        raise RegistrationError(
            f"input `{name}`: aggregation `consumption` sums the registers "
            f"bound to a role across a site, which needs "
            f"applies_to.scope = 'site'"
        )
    return q


def _check_inputs(inputs: dict, scope: str) -> dict[str, Qty]:
    """Every declared input typed, so the formula can be type-checked against them."""
    env: dict[str, Qty] = {}
    for name, spec in inputs.items():
        if not name.isidentifier():
            raise RegistrationError(f"input name `{name}` is not a valid identifier")
        source = spec.get("source", "points")
        if source == "site_fact":
            env[name] = _site_fact_qty(name, spec, scope)
        elif source == "emission_factor":
            env[name] = _emission_factor_qty(name, spec, scope)
        elif source == "slot":
            env[name] = _slot_input_qty(name, spec, scope)
        elif source == "equipment_fact":
            env[name] = _equipment_fact_qty(name, spec, scope)
        elif source == "points":
            if scope == "equipment":
                # An equipment metric reads through the equipment's slots. A role
                # on a device would be a second, disagreeing way to say which
                # point is CH-01's supply temperature.
                raise RegistrationError(
                    f"input `{name}`: an equipment-scope metric reads points through "
                    f"the equipment's slots (`source: \"slot\"`), not by role"
                )
            env[name] = _role_input_qty(name, spec, scope)
        else:
            raise RegistrationError(
                f"input `{name}`: source must be 'points' (default), "
                f"'site_fact', 'emission_factor', 'slot' or 'equipment_fact'"
            )
    return env


_FACT_SOURCES = ("site_fact", "equipment_fact")


def _check_band_bounds(defn: dict, inputs: dict) -> None:
    """A NAMED `in_band` bound must be a recorded FACT, never a measured input.

    A band whose edge is itself a live reading is not a band, it is a
    comparison between two signals — and it would score a chiller "in band"
    whenever its sensors drifted together.
    """
    try:
        tree = expr.parse(defn.get("formula") or "")
    except expr.ExprError:
        return  # the type check that follows names the parse error itself
    for name in sorted(expr.bound_names(tree)):
        source = (inputs.get(name) or {}).get("source", "points")
        if name in inputs and source not in _FACT_SOURCES:
            raise RegistrationError(
                f"in_band(): bound `{name}` is a `{source}` input; a band edge must "
                f"be a literal or a recorded fact ({', '.join(_FACT_SOURCES)})"
            )


def _check_formula_types(defn: dict, env: dict[str, Qty], declared: Qty) -> None:
    """The formula parses, uses what it declares, and produces what it promises."""
    try:
        tree = expr.parse(defn.get("formula") or "")
    except expr.ExprError as exc:
        raise RegistrationError(str(exc)) from exc
    unused = set(env) - expr.names(tree)
    if unused:
        raise RegistrationError(f"declared input(s) never used by the formula: {', '.join(sorted(unused))}")
    try:
        inferred = expr.infer(tree, env)
    except DimensionError as exc:
        raise RegistrationError(f"formula does not type-check: {exc}") from exc
    if not compatible(declared, inferred):
        raise RegistrationError(
            f"formula produces `{inferred.dimension}`"
            + (f" in `{inferred.unit}`" if inferred.unit else "")
            + f", but the output declares `{declared.dimension}`"
            + (f" in `{declared.unit}`" if declared.unit else "")
        )


def typecheck(defn: dict) -> None:
    """Raise RegistrationError unless the definition is coherent. Pure."""
    kind = defn.get("kind", "formula")
    if kind not in KINDS:
        raise RegistrationError(f"kind must be one of {KINDS}")
    scope = (defn.get("applies_to") or {}).get("scope", "device")
    if scope not in SCOPES:
        raise RegistrationError(f"applies_to.scope must be one of {SCOPES}")
    if scope == "equipment":
        cls = (defn.get("applies_to") or {}).get("equipment_class")
        if cls not in EQUIPMENT_CLASSES:
            raise RegistrationError(
                f"an equipment-scope metric names the class it applies to: "
                f"applies_to.equipment_class must be one of "
                f"{', '.join(EQUIPMENT_CLASSES)}"
            )
    _check_guards(defn.get("guards") or [])
    declared = _qty_from_spec(defn.get("output") or {}, "output")

    if kind == "occupancy":
        _check_occupancy_shape(defn, scope, declared)

    if kind == "composite":
        if scope == "equipment":
            # Nothing fans a composite out over one piece of equipment's parts;
            # a site composite already fans equipment-scope components out.
            raise RegistrationError(
                "a composite is device- or site-scope; name equipment-scope "
                "metrics as its components instead"
            )
        _check_composite_components(defn)
        return

    inputs: dict = defn.get("inputs") or {}
    if not inputs:
        raise RegistrationError(f"a {kind} metric needs at least one input")
    typed = _check_inputs(inputs, scope)
    # Before the type check: a measured band edge is the more fundamental
    # mistake, and its dimension clash (if any) would only name the symptom.
    _check_band_bounds(defn, inputs)
    _check_formula_types(defn, typed, declared)


# ── Reads ────────────────────────────────────────────────────────────────────

_LIST_SQL = """
    SELECT id, tenant_id, key, version, effective_from, kind, applies_to,
           inputs, formula, components, output, guards, display,
           created_by, created_at
      FROM metric_definitions
     WHERE (tenant_id IS NULL OR CAST(:tenant AS uuid) IS NULL OR tenant_id = CAST(:tenant AS uuid))
     ORDER BY key, version DESC
"""

_EFFECTIVE_SQL = """
    SELECT id, tenant_id, key, version, effective_from, kind, applies_to,
           inputs, formula, components, output, guards, display,
           created_by, created_at
      FROM metric_definitions
     WHERE key = :key
       AND (tenant_id IS NULL OR CAST(:tenant AS uuid) IS NULL OR tenant_id = CAST(:tenant AS uuid))
       AND effective_from <= CAST(:at AS timestamptz)
     ORDER BY effective_from DESC, version DESC
     LIMIT 1
"""


async def list_definitions(db: AsyncSession, tenant: uuid.UUID | None) -> list[dict]:
    return _rows(await db.execute(text(_LIST_SQL), {"tenant": str(tenant) if tenant else None}))


async def effective(db: AsyncSession, tenant: uuid.UUID | None, key: str, at) -> dict | None:
    """The version in force AT the evaluated instant — never a later one."""
    rows = _rows(
        await db.execute(
            text(_EFFECTIVE_SQL),
            {"key": key, "tenant": str(tenant) if tenant else None, "at": at},
        )
    )
    return rows[0] if rows else None


# ── The one write ────────────────────────────────────────────────────────────

_INSERT_SQL = text(
    """
    INSERT INTO metric_definitions
        (id, tenant_id, key, version, effective_from, kind, applies_to, inputs,
         formula, components, output, guards, display, created_by, created_at)
    VALUES
        (gen_random_uuid(), CAST(:tenant AS uuid), CAST(:key AS varchar),
         COALESCE((SELECT max(version) FROM metric_definitions
                    WHERE key = CAST(:key AS varchar)
                      AND tenant_id IS NOT DISTINCT FROM CAST(:tenant AS uuid)), 0) + 1,
         COALESCE(CAST(:effective_from AS timestamptz), now()),
         :kind, CAST(:applies_to AS jsonb), CAST(:inputs AS jsonb),
         :formula, CAST(:components AS jsonb), CAST(:output AS jsonb),
         CAST(:guards AS jsonb), CAST(:display AS jsonb), :actor, now())
    RETURNING id, key, version, effective_from
    """
)


async def register(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    defn: dict,
    *,
    actor: str | None,
) -> dict:
    """Type-check, then insert as the NEXT version of its key.

    The check runs FIRST and a failure stores nothing — the whole point of
    checking at registration is that a broken spec never exists to be rendered.
    """
    key = (defn.get("key") or "").strip()
    if not key or not key.replace("_", "").isalnum():
        raise RegistrationError("key must be a snake_case identifier")
    typecheck(defn)
    rows = _rows(
        await db.execute(
            _INSERT_SQL,
            {
                "tenant": str(tenant) if tenant else None,
                "key": key,
                "effective_from": defn.get("effective_from"),
                "kind": defn.get("kind", "formula"),
                "applies_to": json.dumps(defn.get("applies_to") or {}),
                "inputs": json.dumps(defn.get("inputs") or {}),
                "formula": defn.get("formula"),
                "components": json.dumps(defn["components"]) if defn.get("components") else None,
                "output": json.dumps(defn.get("output") or {}),
                "guards": json.dumps(defn.get("guards") or []),
                "display": json.dumps(defn.get("display") or {}),
                "actor": (actor or "")[:320] or None,
            },
        )
    )
    await db.commit()
    return rows[0]
