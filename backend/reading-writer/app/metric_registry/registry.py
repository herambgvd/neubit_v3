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
from .units import DimensionError, Qty, compatible, qty_of_unit

KINDS = ("formula", "composite")

# Guards a definition may require. Each is mechanized in the evaluator; a guard
# string outside this set is a typo that would silently never fire, so it is
# rejected at registration like everything else.
GUARDS = ("roles_present", "units_confirmed", "same_unit", "non_frozen")


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


_AGGREGATIONS = ("avg", "last", "first", "min", "max", "sum")


def typecheck(defn: dict) -> None:
    """Raise RegistrationError unless the definition is coherent. Pure."""
    kind = defn.get("kind", "formula")
    if kind not in KINDS:
        raise RegistrationError(f"kind must be one of {KINDS}")
    inputs: dict = defn.get("inputs") or {}
    guards = defn.get("guards") or []
    for g in guards:
        if g not in GUARDS:
            raise RegistrationError(f"guard `{g}` is not mechanized; known guards: {', '.join(GUARDS)}")
    output_spec = defn.get("output") or {}
    declared = _qty_from_spec(output_spec, "output")

    if kind == "composite":
        comps = defn.get("components") or []
        if not comps:
            raise RegistrationError("a composite needs at least one component")
        for c in comps:
            if not c.get("metric") or not isinstance(c.get("weight"), (int, float)):
                raise RegistrationError("each component needs a `metric` key and a numeric `weight`")
        if defn.get("formula"):
            raise RegistrationError("a composite has components and weights, not a formula")
        return

    if not inputs:
        raise RegistrationError("a formula metric needs at least one input")
    env: dict[str, Qty] = {}
    for name, spec in inputs.items():
        if not name.isidentifier():
            raise RegistrationError(f"input name `{name}` is not a valid identifier")
        role = spec.get("role")
        if role is not None:
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
        else:
            raise RegistrationError(f"input `{name}` needs a `role` to bind points by")
        agg = spec.get("aggregation", "avg")
        if agg not in _AGGREGATIONS:
            raise RegistrationError(f"input `{name}`: aggregation `{agg}` is not one of {_AGGREGATIONS}")
        env[name] = q

    try:
        tree = expr.parse(defn.get("formula") or "")
    except expr.ExprError as exc:
        raise RegistrationError(str(exc)) from exc
    used = expr.names(tree)
    unused = set(env) - used
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
