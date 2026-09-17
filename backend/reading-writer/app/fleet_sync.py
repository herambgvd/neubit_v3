"""The IoT fleet channel — read conflux, stamp `points.gateway_id`.

WHAT THIS IS FOR
----------------
The console's IoT drill-down is Gateways → Connections → Devices → Points.
Levels three and four are `neubit_reporting.points`, which this platform has
held all along. Levels one and two exist only inside conflux, and nothing on
this side had ever asked it anything: the coupling between the two systems was
one NATS stream, gateway → platform, with (by design) no path back
(`edge/internal/publish/nats.go`).

This module is that path back, and it is deliberately thin:

* **conflux owns the fleet.** It mints enrolment tokens, it decides what is
  pending and what is approved, and gateways phone home to IT. This platform
  reads. It keeps no gateway table, because a mirror is a second copy that can
  disagree, and a console that shows a disagreement it cannot resolve is worse
  than one that says "the gateway server is unreachable".
* **The one thing it does write is `points.gateway_id`**, because that is the
  join levels one and two need into levels three and four, and it has to live
  in this database for the query to be a query rather than a fan-out.

WHY A POLL AND NOT AN EVENT
---------------------------
The mapping being synced is connection → gateway. It changes when somebody adds
or moves a connection, which is a human action measured in days. A five-minute
poll is the right instrument for that, and it needs no new subject, no stream
and no consumer on either side.

ENRICH ONLY — IT NEVER CLEARS AND NEVER RETIRES
-----------------------------------------------
The sync sets a gateway where it learns one. It does not NULL a gateway it
stopped hearing about, and it does not retire points whose connection has
vanished from the inventory, even though both are easy.

That restraint is the lesson of this deployment's own history. "conflux did not
mention this connection" and "the machine running conflux was switched off" look
identical from here — and the second is what actually happened, for six days.
Retirement already has a mechanism built for exactly that ambiguity (0006): a
query-time HORIZON on `last_seen_at` that needs no operator and self-heals the
moment a reading arrives. A sync that wrote `retired_at` would be an
authoritative answer to a question this module cannot answer.
"""

from __future__ import annotations

import asyncio
import logging

import httpx
from sqlalchemy import text

from reporting.db import database

log = logging.getLogger("reading-writer.fleet-sync")


class FleetError(RuntimeError):
    """The fleet server could not be read. Carries a sentence for the console."""


class FleetStats:
    """Counters, so a sync that is doing nothing is visibly doing nothing."""

    def __init__(self) -> None:
        self.syncs = 0
        self.failures = 0
        self.gateways = 0
        self.connections = 0
        self.points_stamped = 0
        self.last_error = ""

    def as_dict(self) -> dict:
        return {
            "syncs": self.syncs,
            "failures": self.failures,
            "gateways": self.gateways,
            "connections": self.connections,
            "points_stamped": self.points_stamped,
            "last_error": self.last_error,
        }


class FleetClient:
    """A read-only client for conflux's fleet API."""

    def __init__(self, url: str, token: str, timeout_sec: float) -> None:
        self._url = url.rstrip("/")
        self._token = token
        self._timeout = timeout_sec

    async def gateways(self) -> list[dict]:
        """Every gateway the fleet server knows, each with its connections.

        Returns conflux's own shape unchanged. Translating it here would mean
        two definitions of a gateway, and the one nobody maintains is the one a
        console renders.
        """
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.get(f"{self._url}/api/fleet/gateways", headers=headers)
        except httpx.HTTPError as exc:
            # The URL is in the message and the token is not, deliberately: an
            # operator debugging this needs to see which host was tried.
            raise FleetError(f"gateway server at {self._url} is unreachable: {exc}") from exc
        if resp.status_code == 401 or resp.status_code == 403:
            raise FleetError(
                f"gateway server at {self._url} refused the credential "
                f"(HTTP {resp.status_code}) — check VE_IOT_FLEET_TOKEN"
            )
        if resp.status_code != 200:
            raise FleetError(f"gateway server at {self._url} returned HTTP {resp.status_code}")
        try:
            body = resp.json()
        except ValueError as exc:
            raise FleetError(f"gateway server at {self._url} returned a non-JSON body") from exc
        # conflux serves either a bare list or {"gateways": [...]}, depending on
        # the route. Accept both rather than depending on which one it is today.
        if isinstance(body, dict):
            body = body.get("gateways") or []
        if not isinstance(body, list):
            raise FleetError(f"gateway server at {self._url} returned an unexpected body")
        return [g for g in body if isinstance(g, dict)]


def _pairs(gateways: list[dict]) -> list[tuple[str, str]]:
    """(gateway_id, conn_id) for every connection reported by every gateway.

    A gateway on an older build reports `connections: null`, which means "cannot
    tell me" — it contributes no pairs and its points keep whatever they have.
    A gateway reporting `[]` genuinely has none and also contributes no pairs;
    the two are the same here and differ only in what the console says.
    """
    out: list[tuple[str, str]] = []
    for g in gateways:
        gid = (g.get("gatewayId") or "").strip()
        if not gid:
            continue
        for c in g.get("connections") or []:
            cid = (c.get("id") or "").strip() if isinstance(c, dict) else ""
            if cid:
                out.append((gid, cid))
    return out


async def stamp_points(pairs: list[tuple[str, str]]) -> int:
    """Set `points.gateway_id` for each (gateway, connection). Returns rows changed.

    `IS DISTINCT FROM` rather than a bare inequality: `gateway_id` is NULL on
    every row until the first sync, and `NULL <> :gw` is NULL, not true — the
    first run would update nothing at all and the counter would report zero
    forever while the column stayed empty.

    A bad id from the wire is skipped, not fatal: one malformed connection must
    not stop the other gateways being stamped.
    """
    if not pairs:
        return 0
    changed = 0
    sessionmaker = database.get_sessionmaker()
    async with sessionmaker() as session:
        for gateway_id, conn_id in pairs:
            try:
                result = await session.execute(
                    text(
                        "UPDATE points SET gateway_id = CAST(:gw AS uuid) "
                        " WHERE conn_id = CAST(:conn AS uuid) "
                        "   AND gateway_id IS DISTINCT FROM CAST(:gw AS uuid)"
                    ),
                    {"gw": gateway_id, "conn": conn_id},
                )
                changed += result.rowcount or 0
            except Exception as exc:  # noqa: BLE001 — one bad pair is not a failed sync
                log.warning("fleet sync: skipping %s/%s: %s", gateway_id, conn_id, exc)
        await session.commit()
    return changed


class FleetSync:
    """Polls the fleet server and stamps the points dimension."""

    def __init__(self, client: FleetClient, every_sec: int, stats: FleetStats) -> None:
        self._client = client
        self._every = max(30, every_sec)
        self.stats = stats
        self._task: asyncio.Task | None = None
        self._running = False

    async def start(self) -> None:
        self._running = True
        self._task = asyncio.create_task(self._run(), name="iot-fleet-sync")

    async def stop(self) -> None:
        self._running = False
        from .shutdown import stop_tasks

        await stop_tasks(self._task)
        self._task = None

    async def once(self) -> int:
        """One pass. Raises FleetError; the loop below is what swallows it."""
        gateways = await self._client.gateways()
        pairs = _pairs(gateways)
        changed = await stamp_points(pairs)
        self.stats.syncs += 1
        self.stats.gateways = len(gateways)
        self.stats.connections = len(pairs)
        self.stats.points_stamped += changed
        self.stats.last_error = ""
        return changed

    async def _run(self) -> None:
        # Run immediately: a service restarted after a connection was added
        # should not wait a full interval to learn about it.
        while self._running:
            try:
                changed = await self.once()
                if changed:
                    log.info(
                        "fleet sync: %s gateways, %s connections, %s points stamped",
                        self.stats.gateways, self.stats.connections, changed,
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — never let the loop die
                self.stats.failures += 1
                self.stats.last_error = str(exc)
                log.warning("fleet sync failed: %s", exc)
            try:
                await asyncio.sleep(self._every)
            except asyncio.CancelledError:
                raise
