"""Point roles — what a point IS to a metric, said by a human.

A metric definition names its inputs by ROLE (`inlet_water_temp`), never by
point tag: the tag is a naming convention on one estate's gateway, and the
whole reason the registry generalises is that the next estate spells it
differently. The binding tag → role is therefore an OPERATOR'S assertion,
stored per point in `point_roles` with the same provenance shape as
`points.unit_source` — and this module follows `app/api/units.py` exactly:

* `suggest()` is PURE, computed from the tag at read time, labelled with the
  matched pattern in words, and never called from a write path.
* `confirm_roles()` takes an EXPLICIT list of point ids the operator saw.
  There is no server-side pattern expansion.
* `role=None` CLEARS — the row is deleted and the point is unbound again.
  Retraction has to be reachable: a mis-assigned role an operator cannot take
  back would silently corrupt every metric computed through it.

The ROLE VOCABULARY is closed and lives here, beside the dimension each role is
expected to carry. A role nobody defined cannot be confirmed — an open string
field would grow a folksonomy no definition could name.
"""

from __future__ import annotations

import re
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..api.queries import LIVE_POINT, RETIRE_AFTER_DAYS, _rows

# ── Vocabulary ───────────────────────────────────────────────────────────────
#
# role → (expected dimension, label, what it means). The dimension is what the
# registry type-checks a definition's inputs against; the point's own CONFIRMED
# unit still has to agree at evaluation time (the `units_confirmed` guard).
ROLE_DEFS: dict[str, dict] = {
    "inlet_water_temp": {
        "dimension": "temperature",
        "label": "Entering water temperature",
        "description": "The return/entering water temperature of a hydronic machine (IWT).",
    },
    "outlet_water_temp": {
        "dimension": "temperature",
        "label": "Leaving water temperature",
        "description": "The supply/leaving water temperature of a hydronic machine (OWT).",
    },
    "energy_register": {
        "dimension": "energy",
        "label": "Energy register",
        "description": "A cumulative energy register (the kind a consumption is a last−first over).",
    },
    "active_power": {
        "dimension": "power",
        "label": "Active power",
        "description": "Instantaneous active power (total or per phase).",
    },
}

# ── Suggestions ──────────────────────────────────────────────────────────────
#
# Same discipline as the unit rules: each regex matches the WHOLE tag, each rule
# reflects a convention observed on THIS estate, and a tag with no rule simply
# has no suggestion. A suggestion is never a default and never stored.
_RULES: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(r"^iwt$", re.I), "inlet_water_temp", "the tag is `IWT` — entering water temperature by this estate's convention"),
    (re.compile(r"^owt$", re.I), "outlet_water_temp", "the tag is `OWT` — leaving water temperature by this estate's convention"),
    (re.compile(r"^(.+_)?kwh$", re.I), "energy_register", "the tag names a kWh register"),
    (re.compile(r"^(tot ?kw|kw_l[123])$", re.I), "active_power", "the tag names active power"),
]


def suggest(point_tag: str | None, kind: str | None) -> dict | None:
    """What the TAG appears to mean, as a suggestion — never as a fact."""
    if not point_tag or kind != "num":
        return None
    tag = point_tag.strip()
    for pattern, role, basis in _RULES:
        if pattern.match(tag):
            return {"role": role, "basis": basis}
    return None


# ── Reads ────────────────────────────────────────────────────────────────────

_LIST_SQL = """
    SELECT p.point_id, p.point_tag, p.device_id, p.device_tag, p.category,
           p.device_type, p.type, p.unit, p.unit_source,
           p.site_id, p.site_name, p.last_seen_at,
           r.role, r.role_source, r.confirmed_at AS role_confirmed_at,
           r.confirmed_by AS role_confirmed_by
      FROM points p
      LEFT JOIN point_roles r ON r.point_id = p.point_id
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND {live}
       {filters}
     ORDER BY p.device_tag NULLS LAST, p.point_tag NULLS LAST
     LIMIT :limit OFFSET :offset
"""

_COUNTS_SQL = """
    SELECT count(*)                              AS points,
           count(r.point_id)                     AS confirmed,
           count(*) - count(r.point_id)          AS unconfirmed
      FROM points p
      LEFT JOIN point_roles r ON r.point_id = p.point_id
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND {live}
       {filters}
"""


def _filters(category: str | None, search: str | None, confirmed: str) -> tuple[str, dict]:
    where = ""
    params: dict = {}
    if category is not None:
        if category == "":
            where += " AND p.category IS NULL"
        else:
            where += " AND p.category = :category"
            params["category"] = category
    if search:
        where += " AND (p.device_tag ILIKE :search OR p.point_tag ILIKE :search)"
        params["search"] = f"%{search}%"
    if confirmed == "confirmed":
        where += " AND r.point_id IS NOT NULL"
    elif confirmed == "unconfirmed":
        where += " AND r.point_id IS NULL"
    return where, params


async def list_roles(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    category: str | None = None,
    search: str | None = None,
    confirmed: str = "all",
    limit: int = 300,
    offset: int = 0,
) -> tuple[dict, list[dict]]:
    where, extra = _filters(category, search, confirmed)
    params = {
        "tenant": str(tenant) if tenant else None,
        "retire_days": RETIRE_AFTER_DAYS,
        "limit": limit,
        "offset": offset,
        **extra,
    }
    counts = _rows(
        await db.execute(text(_COUNTS_SQL.format(live=LIVE_POINT, filters=where)), params)
    )[0]
    rows = _rows(await db.execute(text(_LIST_SQL.format(live=LIVE_POINT, filters=where)), params))
    for r in rows:
        # Computed HERE, at read time, from the tag — and never written anywhere.
        r["suggestion"] = suggest(r["point_tag"], r["type"])
    return {k: int(v or 0) for k, v in counts.items()}, rows


# ── The one write ────────────────────────────────────────────────────────────

_UPSERT_SQL = text(
    """
    INSERT INTO point_roles (point_id, tenant_id, role, role_source, confirmed_by, confirmed_at)
    SELECT p.point_id, p.tenant_id, CAST(:role AS varchar), 'operator', CAST(:actor AS varchar), now()
      FROM points p
     WHERE p.point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
    ON CONFLICT (point_id) DO UPDATE
       SET role = excluded.role, role_source = excluded.role_source,
           confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at
    RETURNING point_id
    """
)

_CLEAR_SQL = text(
    """
    DELETE FROM point_roles r
     USING points p
     WHERE r.point_id = p.point_id
       AND r.point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
    RETURNING r.point_id
    """
)


async def confirm_roles(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    point_ids: list[uuid.UUID],
    role: str | None,
    actor: str | None,
) -> list[uuid.UUID]:
    """Record that a HUMAN says these points play this role.

    `role=None` clears. A role outside the vocabulary is a ValidationError at
    the router, not here — this function trusts its caller checked, and the
    router does.
    """
    stmt = _CLEAR_SQL if role is None else _UPSERT_SQL
    params: dict = {
        "pids": [str(p) for p in point_ids],
        "tenant": str(tenant) if tenant else None,
    }
    if role is not None:
        params["role"] = role
        params["actor"] = (actor or "")[:320] or None
    rows = _rows(await db.execute(stmt, params))
    await db.commit()
    return [r["point_id"] for r in rows]
