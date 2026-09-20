"""What a reading MEANS — asked device by device, and only where it is read.

The estate has 494 live points. Nobody should ever be shown 494 of anything: of
those, a handful are read by an effective metric, and the rest are readings the
platform stores and nothing computes with. So this endpoint answers a narrow
question:

    for each DEVICE, which of its readings does some effective metric need a
    role for, what does the tag suggest that role is, and what is the reading
    saying right now?

WHICH roles are read is not a list in this file. It comes from the metric
definitions — an input naming a `role` — with the same visibility and version
rules as the plate facts (`nameplate.effective_rows`): a platform-seeded
definition is every tenant's, a tenant's own overrides it for that key, and only
the highest version of the winner counts. A metric retired tomorrow stops being
asked about, and one seeded tomorrow starts, with no edit here.

Nothing is written. The write is the existing `POST /bi/metrics/roles/confirm`,
with its guard against binding a role to a point that carries no readings — which
is exactly why the live value travels with every question here: an operator can
see the number before they say what it means.
"""

from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..metric_registry.roles import ROLE_DEFS, suggest
from .nameplate import effective_rows
from .queries import LIVE_POINT, RETIRE_AFTER_DAYS, _rows

#: The window the value beside a question is taken from. Longer than the
#: freshness window on purpose: this estate is routinely between ingest runs, and
#: a question with no number beside it is the question that got answered wrong.
DEFAULT_LOOKBACK_HOURS = 48

#: A bound on one answer, far above any estate's point count.
MAX_POINTS = 5000


_DEMANDS_SQL = """
    SELECT d.key, d.version, d.tenant_id, d.applies_to->>'scope' AS scope,
           i.value->>'role' AS role
      FROM metric_definitions d
      JOIN LATERAL jsonb_each(d.inputs) i ON TRUE
     WHERE i.value ? 'role'
       AND (d.tenant_id IS NULL OR CAST(:tenant AS uuid) IS NULL
            OR d.tenant_id = CAST(:tenant AS uuid))
"""


async def demands(db: AsyncSession, tenant: uuid.UUID | None) -> dict[str, set[str]]:
    """`{role: {metric keys}}` for the EFFECTIVE definitions only."""
    rows = _rows(await db.execute(text(_DEMANDS_SQL), {"tenant": str(tenant) if tenant else None}))
    out: dict[str, set[str]] = {}
    for r in effective_rows(rows):
        if r["role"] in ROLE_DEFS:
            out.setdefault(r["role"], set()).add(r["key"])
    return out


_POINTS_SQL = """
    SELECT p.point_id, p.point_tag, p.device_id, p.device_tag, p.type, p.unit,
           p.site_id, p.site_name, p.last_seen_at,
           r.role, r.confirmed_by AS role_confirmed_by, r.confirmed_at AS role_confirmed_at
      FROM points p
      LEFT JOIN point_roles r ON r.point_id = p.point_id
     WHERE (CAST(:tenant AS uuid) IS NULL OR p.tenant_id = CAST(:tenant AS uuid))
       AND (CAST(:site AS uuid) IS NULL OR p.site_id = CAST(:site AS uuid))
       AND {live}
     ORDER BY p.device_tag NULLS LAST, p.point_tag NULLS LAST
     LIMIT :limit
"""

_LATEST_SQL = """
    SELECT DISTINCT ON (r.point_id) r.point_id, r.ts, r.num
      FROM readings r
     WHERE r.point_id = ANY(CAST(:pids AS uuid[]))
       AND (CAST(:tenant AS uuid) IS NULL OR r.tenant_id = CAST(:tenant AS uuid))
       AND r.ts >= now() - make_interval(hours => :hours)
     ORDER BY r.point_id, r.ts DESC
"""


def _label(role: str) -> str:
    return ROLE_DEFS.get(role, {}).get("label", role)


def question_of(point: dict, wanted: dict[str, set[str]], latest: dict | None) -> dict | None:
    """One reading as a question, or None when nothing computed reads it.

    A point already carrying a demanded role comes back ANSWERED — so it can be
    seen and taken back — and one whose tag suggests a demanded role comes back
    as a question. A suggestion for a role no effective metric reads is not a
    question: nothing would change by answering it.
    """
    confirmed = point.get("role")
    proposed = suggest(point.get("point_tag"), point.get("type"))
    if confirmed in wanted:
        return {
            "point_id": str(point["point_id"]),
            "point_tag": point["point_tag"],
            "answered": True,
            "role": confirmed,
            "role_label": _label(confirmed),
            "confirmed_by": point.get("role_confirmed_by"),
            "confirmed_at": point.get("role_confirmed_at"),
            "needed_by": sorted(wanted[confirmed]),
            "value": (latest or {}).get("num"),
            "at": (latest or {}).get("ts"),
            "unit": point.get("unit"),
        }
    if confirmed is not None or proposed is None or proposed["role"] not in wanted:
        return None
    return {
        "point_id": str(point["point_id"]),
        "point_tag": point["point_tag"],
        "answered": False,
        "role": proposed["role"],
        "role_label": _label(proposed["role"]),
        "basis": proposed["basis"],
        "needed_by": sorted(wanted[proposed["role"]]),
        "value": (latest or {}).get("num"),
        "at": (latest or {}).get("ts"),
        "unit": point.get("unit"),
        # False: the guard on confirm will challenge this one, so the screen can
        # say so before the press rather than after the 422.
        "reporting": latest is not None,
    }


async def role_asks(
    db: AsyncSession,
    tenant: uuid.UUID | None,
    *,
    site_id: uuid.UUID | None = None,
    hours: int = DEFAULT_LOOKBACK_HOURS,
) -> dict:
    """Every device with something to answer, and what it already answered."""
    wanted = await demands(db, tenant)
    if not wanted:
        # No effective metric reads a role at all: there is nothing to ask, and
        # saying so is the honest answer, not an empty table.
        return {"lookback_hours": hours, "roles_read": [], "devices": [],
                "totals": {"points": 0, "devices": 0, "asks": 0, "answered": 0}}

    points = _rows(
        await db.execute(
            text(_POINTS_SQL.format(live=LIVE_POINT)),
            {
                "tenant": str(tenant) if tenant else None,
                "site": str(site_id) if site_id else None,
                "retire_days": RETIRE_AFTER_DAYS,
                "limit": MAX_POINTS,
            },
        )
    )
    # Only the points a question could be about are worth a reading lookup.
    of_interest = [p for p in points if question_of(p, wanted, None) is not None]
    latest: dict[str, dict] = {}
    if of_interest:
        latest = {
            str(r["point_id"]): dict(r)
            for r in _rows(
                await db.execute(
                    text(_LATEST_SQL),
                    {
                        "pids": [str(p["point_id"]) for p in of_interest],
                        "tenant": str(tenant) if tenant else None,
                        "hours": hours,
                    },
                )
            )
        }

    by_device: dict[str, dict] = {}
    asks = answered = 0
    for p in of_interest:
        q = question_of(p, wanted, latest.get(str(p["point_id"])))
        if q is None:  # pragma: no cover - of_interest is exactly the non-None set
            continue
        key = p["device_tag"] or ""
        d = by_device.setdefault(
            key,
            {
                "device_id": str(p["device_id"]) if p["device_id"] else None,
                "device_tag": p["device_tag"],
                "site_id": str(p["site_id"]) if p["site_id"] else None,
                "site_name": p["site_name"],
                "asks": [],
                "answered": [],
            },
        )
        if q["answered"]:
            d["answered"].append(q)
            answered += 1
        else:
            d["asks"].append(q)
            asks += 1

    # Two traps the live estate walked into, said on the question itself.
    for d in by_device.values():
        answered_roles: dict[str, list[str]] = {}
        for q in d["answered"]:
            answered_roles.setdefault(q["role"], []).append(q["point_tag"])
        by_role: dict[str, list[dict]] = {}
        for q in d["asks"]:
            by_role.setdefault(q["role"], []).append(q)
        for role, qs in by_role.items():
            for q in qs:
                # The device already answers this role on ANOTHER reading: a
                # second one is a generation of the same sensor (`IWT` beside
                # `4FKC2_IWT` after a rename), and binding both counts it twice.
                q["same_role_answered"] = sorted(answered_roles.get(role, []))
                # Several unanswered readings claim the same role on one device —
                # 2F York Chiller01 publishes three kWh registers, two of them
                # older generations. One of them is the answer, not all three.
                q["same_role_others"] = sorted(o["point_tag"] for o in qs if o is not q)

    devices = sorted(
        by_device.values(),
        # Devices with something to answer first, then by name — the rail is a
        # worklist, not an inventory.
        key=lambda d: (not d["asks"], (d["device_tag"] or "").lower()),
    )
    return {
        "lookback_hours": hours,
        "roles_read": [
            {"role": r, "label": _label(r), "needed_by": sorted(m)} for r, m in sorted(wanted.items())
        ],
        "devices": devices,
        "totals": {
            "points": len(points),
            "devices": len(devices),
            "asks": asks,
            "answered": answered,
        },
    }
