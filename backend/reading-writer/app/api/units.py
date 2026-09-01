"""Units — the one thing on this platform that turns a number into a quantity.

THE PROBLEM, EXACTLY
--------------------
`points.unit` is NULL for all 314 points on this deployment and that is not a bug
(contract §11/§12): the source MQTT payloads carry no `env.u`. It costs nothing
for a trend chart — the axis shows the numbers as measured — and it is fatal for a
RATING, because `kWh / m² / year` is a statement about units. Without one, a sum
of `KWH_kwh` registers is a sum of numbers nobody has said are kilowatt-hours.

THE TRAP, AND THE RULE
----------------------
The unit is frequently VISIBLE in the tag: `KWH_kwh`, `Freq_Hz`, `VoltL1_V`,
`CurrL1_A`, `PF_pf`, `TOTKW_kw`. It is very tempting to parse that and store it.

**That is forbidden.** It is the same mistake the contract already records about
floor prefixes (§17): `4F_Solar_Panel01` looks like it names a floor until
`4F-3F AC DB` names two, and a floor-wise chart that is silently wrong for one
floor in five is worse than one that says "unplaced". A tag is a naming
convention. A convention is evidence of nothing.

So this module does exactly one thing with a tag: it OFFERS the reading as a
SUGGESTION, labelled with the pattern it matched, for a human to confirm — one
point at a time or in bulk over a set the human can see before they act. The
operator asserting it is fine; the platform asserting it is not. What nobody
confirms keeps a NULL unit and is counted as UNCONFIRMED.

`suggest()` is therefore pure and is never called from a write path. Grep for it:
the only caller is the list endpoint.
"""

from __future__ import annotations

import datetime as dt
import re
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .queries import LIVE_POINT, RETIRE_AFTER_DAYS, _rows


# ── Suggestions ──────────────────────────────────────────────────────────────
#
# Ordered rules. Each is (regex over the tag, unit, how to say why in words).
# The regex is matched against the WHOLE tag, case-insensitively, so a rule
# fires on a shape rather than on a substring that could appear anywhere.
#
# The list is deliberately short and deliberately conservative:
#   * every rule below reflects a convention observed on THIS estate's tags;
#   * where two readings are possible the rule is OMITTED rather than guessed —
#     e.g. a bare `KW_L1` is offered as kW because that is what the leading token
#     says, while something like `Total` alone gets nothing at all;
#   * a suggestion is never a default. A point with no matching rule simply has
#     no suggestion and stays unconfirmed, which is a perfectly good outcome.
_RULES: list[tuple[re.Pattern[str], str, str]] = [
    # --- suffix conventions: the unit is spelled after the last underscore ---
    (re.compile(r"^.+_kwh$", re.I), "kWh", "the tag ends in `_kwh`"),
    (re.compile(r"^.+_kvah$", re.I), "kVAh", "the tag ends in `_kvah`"),
    (re.compile(r"^.+_kva$", re.I), "kVA", "the tag ends in `_kva`"),
    (re.compile(r"^.+_kw$", re.I), "kW", "the tag ends in `_kw`"),
    (re.compile(r"^.+_pf$", re.I), "", "the tag ends in `_pf` — power factor is a ratio and has no unit"),
    (re.compile(r"^.+_hz$", re.I), "Hz", "the tag ends in `_Hz`"),
    (re.compile(r"^.+_v$", re.I), "V", "the tag ends in `_V`"),
    (re.compile(r"^.+_a$", re.I), "A", "the tag ends in `_A`"),
    # --- whole-tag conventions used by this estate's older device profiles ---
    (re.compile(r"^kwh$", re.I), "kWh", "the tag is `KWH`"),
    (re.compile(r"^pf$", re.I), "", "the tag is `PF` — power factor is a ratio and has no unit"),
    (re.compile(r"^(tot ?kw|kw_l[123])$", re.I), "kW", "the tag names active power in kW"),
    (re.compile(r"^(iwt|owt|amb ?temp)$", re.I), "degC", "the tag names a water or air temperature"),
]


def suggest(point_tag: str | None, kind: str | None) -> dict | None:
    """What the TAG appears to say, as a suggestion — never as a fact.

    Returns ``{"unit": ..., "basis": ...}`` or ``None``. The ``basis`` is shown
    to the operator verbatim, so they are confirming a stated reason rather than
    a value that appeared from nowhere.

    Text points get nothing: a unit on a string is meaningless, and `On Off STS`
    is a state, not a quantity.
    """
    if not point_tag or kind != "num":
        return None
    tag = point_tag.strip()
    for pattern, unit, basis in _RULES:
        if pattern.match(tag):
            return {"unit": unit, "basis": basis}
    return None


# ── Reads ────────────────────────────────────────────────────────────────────

_LIST_SQL = """
    SELECT p.point_id, p.point_tag, p.device_id, p.device_tag, p.category,
           p.device_type, p.type, p.unit, p.unit_source, p.unit_confirmed_at,
           p.unit_confirmed_by, p.site_id, p.site_name, p.last_seen_at
      FROM points p
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND {live}
       {filters}
     ORDER BY p.device_tag NULLS LAST, p.point_tag NULLS LAST
     LIMIT :limit OFFSET :offset
"""

_COUNTS_SQL = """
    SELECT count(*)                                                  AS points,
           count(*) FILTER (WHERE p.unit_source = 'operator')         AS confirmed,
           count(*) FILTER (WHERE p.unit_source IS DISTINCT FROM 'operator') AS unconfirmed
      FROM points p
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
        where += " AND p.unit_source = 'operator'"
    elif confirmed == "unconfirmed":
        where += " AND p.unit_source IS DISTINCT FROM 'operator'"
    return where, params


async def list_units(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    category: str | None = None,
    search: str | None = None,
    confirmed: str = "all",
    limit: int = 200,
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

_CONFIRM_SQL = text(
    """
    UPDATE points p
       SET unit              = CAST(:unit AS varchar),
           unit_source       = CASE WHEN :clear THEN NULL ELSE 'operator' END,
           unit_confirmed_at = CASE WHEN :clear THEN NULL ELSE now() END,
           unit_confirmed_by = CASE WHEN :clear THEN NULL ELSE CAST(:actor AS varchar) END
     WHERE p.point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
    RETURNING p.point_id
    """
)


async def confirm_units(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    point_ids: list[uuid.UUID],
    unit: str | None,
    actor: str | None,
) -> list[uuid.UUID]:
    """Record that a HUMAN says these points are in this unit.

    The ids are EXPLICIT, always. A bulk confirmation is a list of point ids the
    operator saw before they pressed the button — never a pattern the server
    expands on its own, because "apply to everything matching `_kw`" evaluated
    server-side is a guess wearing a human's authority.

    `unit=None` CLEARS: the unit, the source and the provenance all go back to
    NULL and the point returns to UNCONFIRMED. That has to be reachable — a
    mis-typed unit an operator cannot take back would silently corrupt every
    rating computed from it.

    A tenant-scoped caller cannot touch another tenant's point: the statement
    carries the same `:tenant` bind every other read does.
    """
    rows = _rows(
        await db.execute(
            _CONFIRM_SQL,
            {
                "pids": [str(p) for p in point_ids],
                "tenant": str(tenant) if tenant else None,
                "unit": unit,
                "clear": unit is None,
                "actor": (actor or "")[:320] or None,
            },
        )
    )
    await db.commit()
    return [r["point_id"] for r in rows]


# Re-exported so the router can stamp a response without importing datetime.
def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)
