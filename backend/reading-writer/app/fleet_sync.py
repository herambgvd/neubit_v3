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


def _detail(resp: httpx.Response) -> str:
    """The gateway server's own explanation, when it sent one.

    Its errors are `{"error": "..."}`. Anything else — an HTML error page from
    something in between, an empty body — yields "" so the caller falls back to
    naming the status, rather than quoting a page of markup at an operator.

    Bounded because it is rendered in a toast, and never used for the token
    mint, whose body is a credential.
    """
    try:
        body = resp.json()
    except ValueError:
        return ""
    if isinstance(body, dict):
        msg = body.get("error") or body.get("detail") or ""
        if isinstance(msg, str):
            return msg[:300]
    return ""


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


    async def ack_alert(self, alert_id: str, acked: bool) -> None:
        """Acknowledge or reopen an alert ON THE GATEWAY.

        The gateway owns the alert and its acknowledgement; this platform holds
        a projection of both. So the command goes there, the gateway records it
        and republishes the alert, and the projection updates from that message
        — one write path, and the console's row changes because the gateway said
        so rather than because we assumed it would.

        That also means an acknowledgement made in the gateway's own console
        lands here too, which a local write would never have achieved.
        """
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        verb = "ack" if acked else "unack"
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(
                    f"{self._url}/api/alerts/{alert_id}/{verb}", headers=headers
                )
        except httpx.HTTPError as exc:
            raise FleetError(f"gateway server at {self._url} is unreachable: {exc}") from exc
        if resp.status_code in (401, 403):
            raise FleetError(
                f"gateway server at {self._url} refused the credential "
                f"(HTTP {resp.status_code}) — check VE_IOT_FLEET_TOKEN"
            )
        if resp.status_code == 404:
            raise FleetError("the gateway does not know that alert")
        # 204 is the documented success; anything else 2xx is still a success.
        if resp.status_code >= 300:
            raise FleetError(f"gateway server at {self._url} returned HTTP {resp.status_code}")


    async def _post(self, path: str, *, what: str) -> dict | None:
        """POST to the fleet server and turn every failure into a sentence.

        Shared by every command so they cannot drift into reporting the same
        failure three different ways — the console renders whatever comes back
        here, and "HTTP 502" is not something an operator can act on.
        """
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(f"{self._url}{path}", headers=headers)
        except httpx.HTTPError as exc:
            raise FleetError(f"gateway server at {self._url} is unreachable: {exc}") from exc
        if resp.status_code in (401, 403):
            # 403 here is usually not a broken token but a token that is not
            # allowed to do THIS — EDGE_TOKEN_ROLE narrows what the platform's
            # credential may do, and approving a gateway needs `admin`.
            raise FleetError(
                f"the gateway server refused to {what} (HTTP {resp.status_code}) — "
                f"check VE_IOT_FLEET_TOKEN, and that EDGE_TOKEN_ROLE on the gateway "
                f"server is admin or higher"
            )
        if resp.status_code == 404:
            raise FleetError(f"the gateway server does not know that {what.split()[-1]}")
        if resp.status_code >= 300:
            # Pass the gateway server's OWN sentence through when it wrote one.
            # It knows why it refused and this does not: "HTTP 400" sent an
            # operator looking for a bug, where "this instance is not an
            # enrolled gateway" is the entire answer.
            raise FleetError(_detail(resp) or f"gateway server at {self._url} returned HTTP {resp.status_code}")
        try:
            return resp.json()
        except ValueError:
            # 204 No Content is a documented success for several of these.
            return None

    async def approve_gateway(self, gateway_id: str) -> None:
        """Move a gateway from pending to approved, ON the gateway server.

        A gateway admitted by the shared bootstrap token enrols as PENDING: a
        shared secret can enrol anything, so nothing it admits is trusted until
        somebody says so. This is somebody saying so.
        """
        await self._post(f"/api/fleet/gateways/{gateway_id}/approve", what="approve that gateway")

    async def revoke_gateway(self, gateway_id: str) -> None:
        """Stop accepting a gateway's heartbeats.

        Reversible and non-destructive: the row, its history and everything it
        has already delivered stay exactly where they are. DECOMMISSIONING — the
        DELETE that removes the record — is deliberately not exposed here. It is
        the one action with nothing to undo it, and it belongs where somebody is
        looking at the gateway server itself.
        """
        await self._post(f"/api/fleet/gateways/{gateway_id}/revoke", what="revoke that gateway")

    async def tokens(self) -> list[dict]:
        """Enrolment tokens the gateway server has issued.

        Bookkeeping only — the credential itself is bcrypt-hashed at rest and is
        never returned by this endpoint. There is nothing secret in the reply.
        """
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.get(f"{self._url}/api/fleet/tokens", headers=headers)
        except httpx.HTTPError as exc:
            raise FleetError(f"gateway server at {self._url} is unreachable: {exc}") from exc
        if resp.status_code in (401, 403):
            raise FleetError(
                f"the gateway server refused to list enrolment tokens "
                f"(HTTP {resp.status_code}) — EDGE_TOKEN_ROLE must be admin or higher"
            )
        if resp.status_code != 200:
            raise FleetError(f"gateway server at {self._url} returned HTTP {resp.status_code}")
        try:
            body = resp.json()
        except ValueError as exc:
            raise FleetError("the gateway server returned a non-JSON body") from exc
        if isinstance(body, dict):
            body = body.get("tokens") or []
        return [t for t in body if isinstance(t, dict)] if isinstance(body, list) else []

    async def mint_token(self, name: str) -> dict:
        """Mint an enrolment token. The plaintext comes back ONCE.

        NOTHING here logs the response. The gateway server shows a minted
        credential exactly once because it stores only a hash, so this reply is
        the only copy that will ever exist — and a credential that admits
        gateways into a fleet does not belong in a log line, an exception
        message or a traceback.
        """
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(
                    f"{self._url}/api/fleet/tokens", headers=headers, json={"name": name}
                )
        except httpx.HTTPError as exc:
            raise FleetError(f"gateway server at {self._url} is unreachable: {exc}") from exc
        if resp.status_code in (401, 403):
            raise FleetError(
                f"the gateway server refused to mint a token (HTTP {resp.status_code}) — "
                f"EDGE_TOKEN_ROLE must be admin or higher"
            )
        if resp.status_code >= 300:
            # Deliberately NOT including the body: a failed mint can still echo
            # what was sent, and this is the one call whose body is a secret.
            raise FleetError(f"gateway server at {self._url} returned HTTP {resp.status_code}")
        try:
            return resp.json()
        except ValueError as exc:
            raise FleetError("the gateway server returned a non-JSON body") from exc

    async def revoke_token(self, token_id: str) -> None:
        """Revoke one enrolment token. Gateways it already admitted keep running."""
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.delete(
                    f"{self._url}/api/fleet/tokens/{token_id}", headers=headers
                )
        except httpx.HTTPError as exc:
            raise FleetError(f"gateway server at {self._url} is unreachable: {exc}") from exc
        if resp.status_code in (401, 403):
            raise FleetError(
                f"the gateway server refused to revoke that token (HTTP {resp.status_code}) — "
                f"EDGE_TOKEN_ROLE must be admin or higher"
            )
        if resp.status_code == 404:
            raise FleetError("the gateway server does not know that token")
        if resp.status_code >= 300:
            raise FleetError(f"gateway server at {self._url} returned HTTP {resp.status_code}")


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
