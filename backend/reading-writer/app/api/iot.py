"""The IoT fleet read API — Gateways and what is inside them.

The console's Devices section drills Gateways → Connections → Devices → Points.
The bottom two levels are this database; the top two live in conflux, and this
router is the window onto them.

WHY IT PROXIES INSTEAD OF MIRRORING
-----------------------------------
No gateway table exists here, on purpose. Conflux owns the fleet — it mints
enrolment tokens, it decides what is pending and what is approved, and gateways
phone home to IT. Copying that into this database would create a second answer
to "what gateways are there", and the copy is the one that goes stale while
looking authoritative. The same single-ownership rule the VMS applies to
recorder-owned cameras (nothing is onboarded on the aggregator) applies here.

The cost is honest and small: when the fleet server is unreachable this endpoint
says so, in a sentence, with the host it tried. A mirror would instead show a
list that might be weeks old with nothing marking it as such.

WHAT IS JOINED, AND WHERE
-------------------------
Conflux reports each gateway with its connection inventory (id, slug, proto,
device and point counts) — what it has CONFIGURED. This platform holds what has
actually ARRIVED, in `points`. The two are different questions and both are
worth seeing: a connection configured with 40 points that has delivered 3 is a
fault nobody can see from either side alone. So each connection carries the
gateway's own counts AND this database's, side by side, never merged.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from kernel.auth import Scope, get_scope, require_permission
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from reporting.db import get_db

from ..fleet_sync import FleetError

# The permission this API gates on. IoT device management is not Building
# Intelligence — one is the estate's plumbing and the other is its analysis — so
# it gets its own key rather than borrowing `bi.read`. Registered in core's
# permission catalog, or a tenant admin cannot grant it.
PERM_READ = "iot.read"

iot_router = APIRouter(prefix="/iot", tags=["IoT — gateways"])

Db = Annotated[AsyncSession, Depends(get_db)]
Caller = Annotated[Scope, Depends(get_scope)]

# Set by main.py at startup when VE_IOT_FLEET_URL is configured. None means the
# deployment has no conflux, which is a normal state and not an error until
# somebody asks for a gateway.
_client = None
_stats = None


def configure(client, stats) -> None:
    """Wire the fleet client this router reads through. Called once, at startup."""
    global _client, _stats
    _client = client
    _stats = stats


def _require_client():
    if _client is None:
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED,
            detail=(
                "No IoT gateway server is configured. Set VE_IOT_FLEET_URL to a "
                "conflux fleet server to manage gateways from here."
            ),
        )
    return _client


def _tenant(scope: Scope) -> uuid.UUID | None:
    """The tenant every query is filtered by. Never from the request body."""
    if scope.is_platform:
        return None
    if scope.tenant_id is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="token carries no tenant")
    return scope.tenant_id


async def _arrived(db: AsyncSession, tenant: uuid.UUID | None) -> dict[str, dict]:
    """Per connection, what this platform has actually RECEIVED.

    Keyed by conn_id as a string, because that is how conflux spells it on the
    wire and the join happens in Python against its inventory.
    """
    sql = (
        "SELECT conn_id::text AS conn_id, "
        "       COUNT(*)                       AS points, "
        "       COUNT(DISTINCT device_id)      AS devices, "
        "       MAX(last_seen_at)              AS last_seen_at "
        "  FROM points "
        " WHERE conn_id IS NOT NULL "
        + ("   AND tenant_id = :tenant " if tenant else "")
        + " GROUP BY conn_id"
    )
    rows = await db.execute(text(sql), {"tenant": tenant} if tenant else {})
    return {
        r.conn_id: {
            "points": r.points,
            "devices": r.devices,
            "last_seen_at": r.last_seen_at.isoformat() if r.last_seen_at else None,
        }
        for r in rows
    }


def _merge(gateway: dict, arrived: dict[str, dict]) -> dict:
    """One gateway, with each connection carrying both sides' numbers.

    `connections: null` from conflux means the gateway is on a build that cannot
    report an inventory. It is passed through as null rather than as [] — the
    console has to be able to say "unknown", because "this gateway has no
    connections" is a different and much more alarming statement.
    """
    conns = gateway.get("connections")
    if conns is None:
        return {**gateway, "connections": None}
    out = []
    for c in conns:
        if not isinstance(c, dict):
            continue
        seen = arrived.get((c.get("id") or "").strip(), {})
        out.append(
            {
                **c,
                # Deliberately NOT merged into `devices`/`points`: those are what
                # the gateway has configured, these are what reached the
                # platform, and the gap between them is the finding.
                "arrived": {
                    "devices": seen.get("devices", 0),
                    "points": seen.get("points", 0),
                    "last_seen_at": seen.get("last_seen_at"),
                },
            }
        )
    return {**gateway, "connections": out}


@iot_router.get("/gateways", dependencies=[Depends(require_permission(PERM_READ))])
async def list_gateways(db: Db, scope: Caller) -> dict:
    """Every gateway the fleet server knows, with what has reached us from each."""
    client = _require_client()
    try:
        gateways = await client.gateways()
    except FleetError as exc:
        # 502, not 500: this service is fine and the thing it depends on is not,
        # and the console renders the difference.
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    arrived = await _arrived(db, _tenant(scope))
    return {
        "gateways": [_merge(g, arrived) for g in gateways],
        "sync": _stats.as_dict() if _stats else None,
    }


@iot_router.get("/gateways/{gateway_id}", dependencies=[Depends(require_permission(PERM_READ))])
async def get_gateway(gateway_id: str, db: Db, scope: Caller) -> dict:
    """One gateway. 404 when the fleet server does not know it."""
    client = _require_client()
    try:
        gateways = await client.gateways()
    except FleetError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    for g in gateways:
        if (g.get("gatewayId") or "") == gateway_id:
            return _merge(g, await _arrived(db, _tenant(scope)))
    raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no such gateway")


@iot_router.get("/gateways/{gateway_id}/points", dependencies=[Depends(require_permission(PERM_READ))])
async def gateway_points(
    gateway_id: str, db: Db, scope: Caller, limit: int = 200
) -> dict:
    """The points this platform holds for one gateway — the drill-down's floor.

    Reads `points.gateway_id`, which the fleet sync stamps. A gateway whose sync
    has not run yet returns nothing, and that is correct: the platform does not
    know which of its points belong to it, and guessing from `conn_id` without
    the inventory is the kind of inference this schema refuses everywhere else.
    """
    tenant = _tenant(scope)
    sql = (
        "SELECT point_id::text, device_tag, point_tag, unit, category, "
        "       device_type, last_seen_at, retired_at "
        "  FROM points "
        " WHERE gateway_id = CAST(:gw AS uuid) "
        + ("   AND tenant_id = :tenant " if tenant else "")
        + " ORDER BY device_tag, point_tag LIMIT :limit"
    )
    params: dict = {"gw": gateway_id, "limit": max(1, min(limit, 2000))}
    if tenant:
        params["tenant"] = tenant
    rows = (await db.execute(text(sql), params)).mappings().all()
    return {"gateway_id": gateway_id, "points": [dict(r) for r in rows]}
