"""Media-node registry service + background heartbeat monitor (MN-1a).

Two collaborators, mirroring the ``nvr`` CRUD service + the ``health`` sampler:

  * ``MediaNodeService`` (tenant-scoped) — CRUD over ``media_nodes``. Every read goes
    through ``kernel.auth.scoped``; every by-id fetch through ``assert_owned``; new rows
    are stamped with the caller's ``tenant_id`` (the exact discipline of ``NvrService`` /
    ``CameraService``). Register onboards an INDEPENDENT recorder machine — its Go ``nvr``
    ``api_url`` (the routing/heartbeat target) + optional MediaMTX media bases + a label.
    On create it probes reachability (``<api_url>/api/v1/nvr/status``, short timeout) and
    marks the node online/offline WITHOUT hard-failing the create (an unreachable recorder
    is still stored, marked offline, and the response carries a ``warning``). Delete is
    BLOCKED while any camera references the node (``Camera.media_node_id``).

  * ``NodeHeartbeatMonitor`` (estate-wide, NOT tenant-scoped) — the background loop. Every
    ``VE_NODE_HEARTBEAT_INTERVAL_SEC`` (default 20) it pings each node's health path and
    refreshes ``status`` + ``last_heartbeat`` (+ ``used_channels`` when the node's status
    payload exposes a channel/stream count). ``draining`` nodes are LEFT as the operator
    set them (a graceful drain must not flip back to online). Own DB session per cycle;
    bounded concurrency; graceful-on-unreachable (a down node → ``offline``, never an
    exception; one bad cycle backs off, never kills the loop). Started in ``app.main``
    lifespan alongside the other monitors.

Config (env, ``VE_`` prefix — read directly, matching the health sampler):
  * ``VE_NODE_HEARTBEAT_INTERVAL_SEC``  — seconds between heartbeat cycles (default 20).
  * ``VE_NODE_HEARTBEAT_CONCURRENCY``   — max concurrent probes per cycle (default 16).
  * ``VE_NODE_HEARTBEAT_TIMEOUT_SEC``   — per-probe HTTP timeout (default 3.0).

Health path: the Go ``nvr`` exposes ``GET /api/v1/nvr/status`` (see
``app.vms.common.nvr_client.NvrClient.status``) — the reachability + self-report endpoint.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ConflictError, ValidationError

from app.vms.models import Camera, MediaNode

from .schemas import (
    NODE_STATUSES,
    MediaNodeCreate,
    MediaNodeListResponse,
    MediaNodePublic,
    MediaNodeUpdate,
)

log = logging.getLogger("vision.media_nodes")

# The Go ``nvr`` health/self-report path (relative to a node's ``api_url``).
NODE_HEALTH_PATH = "/api/v1/nvr/status"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


def heartbeat_interval_sec() -> int:
    return max(5, _env_int("VE_NODE_HEARTBEAT_INTERVAL_SEC", 20))


def heartbeat_concurrency() -> int:
    return max(1, _env_int("VE_NODE_HEARTBEAT_CONCURRENCY", 16))


def heartbeat_timeout_sec() -> float:
    return max(0.5, _env_float("VE_NODE_HEARTBEAT_TIMEOUT_SEC", 3.0))


def _health_url(api_url: str) -> str:
    return f"{api_url.rstrip('/')}{NODE_HEALTH_PATH}"


def _host_of(api_url: str) -> str:
    """Best cosmetic host label off a node's api_url (never raises)."""
    try:
        parsed = urlparse(api_url if "://" in api_url else f"//{api_url}")
        return parsed.hostname or api_url
    except Exception:  # noqa: BLE001
        return api_url


def _used_channels_from_status(payload: dict) -> int | None:
    """Best-effort channel/stream count out of a Go-nvr ``/status`` payload.

    The nvr self-report shape is ``{service, plane, nats, streaming, recording,
    resilience, node}``; the streaming/recording sections may be a bool (no count) or a
    dict/int that exposes a count. We read the first count-like shape we find and return
    ``None`` when none is present (leave ``used_channels`` unchanged rather than zeroing a
    live node whose payload simply omits the count).
    """
    for key in ("used_channels", "active_streams", "streams", "channels"):
        val = payload.get(key)
        if isinstance(val, bool):
            continue
        if isinstance(val, int):
            return max(0, val)
        if isinstance(val, (list, tuple)):
            return len(val)
    streaming = payload.get("streaming")
    if isinstance(streaming, dict):
        for key in ("count", "active", "used_channels", "streams"):
            val = streaming.get(key)
            if isinstance(val, bool):
                continue
            if isinstance(val, int):
                return max(0, val)
            if isinstance(val, (list, tuple)):
                return len(val)
    return None


async def probe_node(api_url: str, *, timeout: float | None = None) -> tuple[bool, dict]:
    """Ping ``<api_url>/api/v1/nvr/status``. Returns ``(reachable, payload)``.

    Never raises — an unreachable recorder / a non-2xx / a non-JSON body all yield
    ``(False, {})``. This is the shared reachability primitive used by both the CREATE
    validation and the background heartbeat monitor (no JWT: node onboarding is an
    infrastructure probe, not a tenant-scoped media call — a plain reachability check).
    """
    t = timeout if timeout is not None else heartbeat_timeout_sec()
    url = _health_url(api_url)
    try:
        async with httpx.AsyncClient(timeout=t) as client:
            resp = await client.get(url)
    except httpx.HTTPError as exc:
        log.debug("media-node probe unreachable (%s): %s", url, exc)
        return False, {}
    if resp.status_code >= 400:
        log.debug("media-node probe %s → %s", url, resp.status_code)
        return False, {}
    try:
        payload = resp.json()
    except ValueError:
        return True, {}
    return True, payload if isinstance(payload, dict) else {}


class MediaNodeService:
    """Tenant-scoped CRUD over ``media_nodes`` (recorder-machine registry)."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _row(self, node_id: str) -> MediaNode:
        row = await self.db.get(MediaNode, node_id)
        assert_owned(row, self.scope, message="Media node not found")
        return row

    async def _assigned_camera_count(self, node_id: str) -> int:
        return int(
            await self.db.scalar(
                scoped(select(func.count()).select_from(Camera), Camera, self.scope).where(
                    Camera.media_node_id == node_id
                )
            )
            or 0
        )

    # ── CRUD ────────────────────────────────────────────────────────────
    async def create(self, body: MediaNodeCreate, *, probe: bool = True) -> MediaNodePublic:
        # Name is unique within the caller's tenant (like NVR/camera/instance names).
        dup = await self.db.scalar(
            scoped(select(MediaNode), MediaNode, self.scope).where(MediaNode.name == body.name)
        )
        if dup is not None:
            raise ConflictError("a media node with this name already exists")

        row = MediaNode(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            host=body.host or _host_of(body.api_url),
            api_url=body.api_url,
            hls_base=body.hls_base,
            webrtc_base=body.webrtc_base,
            rtsp_base=body.rtsp_base,
            label=body.label,
            capacity_channels=body.capacity_channels,
            used_channels=0,
            status="unknown",
        )

        warning: str | None = None
        # Validate reachability, but NEVER hard-fail the create — an unreachable recorder
        # is still onboarded (marked offline) so the operator can fix networking + it comes
        # up on the next heartbeat.
        if probe:
            reachable, payload = await probe_node(body.api_url)
            if reachable:
                row.status = "online"
                row.last_heartbeat = _utcnow()
                used = _used_channels_from_status(payload)
                if used is not None:
                    row.used_channels = used
            else:
                row.status = "offline"
                warning = (
                    f"media node registered but its recorder was unreachable at "
                    f"{_health_url(body.api_url)} — it will come online on the next heartbeat"
                )

        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return MediaNodePublic.from_row(row, warning=warning)

    async def list_(
        self,
        *,
        skip: int = 0,
        limit: int = 50,
        status: str | None = None,
        q: str | None = None,
    ) -> MediaNodeListResponse:
        stmt = scoped(select(MediaNode), MediaNode, self.scope)
        count_stmt = scoped(select(func.count()).select_from(MediaNode), MediaNode, self.scope)

        def _filters(s):
            if status:
                s = s.where(MediaNode.status == status)
            if q:
                term = f"%{q}%"
                s = s.where(
                    (MediaNode.name.ilike(term))
                    | (MediaNode.host.ilike(term))
                    | (MediaNode.label.ilike(term))
                )
            return s

        stmt = _filters(stmt).order_by(MediaNode.name).offset(skip).limit(limit)
        count_stmt = _filters(count_stmt)

        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count_stmt) or 0)
        return MediaNodeListResponse(
            items=[MediaNodePublic.from_row(r) for r in rows],
            total=total,
            skip=skip,
            limit=limit,
        )

    async def get(self, node_id: str) -> MediaNodePublic:
        return MediaNodePublic.from_row(await self._row(node_id))

    async def update(self, node_id: str, body: MediaNodeUpdate) -> MediaNodePublic:
        row = await self._row(node_id)
        data = body.model_dump(exclude_unset=True)

        if "name" in data and data["name"] is not None and data["name"] != row.name:
            dup = await self.db.scalar(
                scoped(select(MediaNode), MediaNode, self.scope).where(
                    MediaNode.name == data["name"], MediaNode.id != row.id
                )
            )
            if dup is not None:
                raise ConflictError("a media node with this name already exists")

        if "status" in data and data["status"] is not None:
            if data["status"] not in NODE_STATUSES:
                raise ValidationError(
                    f"invalid status '{data['status']}' — one of {sorted(NODE_STATUSES)}"
                )

        for k in (
            "name",
            "api_url",
            "hls_base",
            "webrtc_base",
            "rtsp_base",
            "label",
            "host",
            "capacity_channels",
            "status",
        ):
            if k in data and data[k] is not None:
                setattr(row, k, data[k])

        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return MediaNodePublic.from_row(row)

    async def delete(self, node_id: str) -> None:
        """Remove a node — BLOCKED while any camera references it (``media_node_id``).

        Cameras carry a soft ``media_node_id`` (String, no DB FK), so a blind delete would
        orphan live placements. We check first and raise a clear ``ConflictError`` naming
        the count so the operator re-homes the cameras before removing the recorder.
        """
        row = await self._row(node_id)
        assigned = await self._assigned_camera_count(node_id)
        if assigned:
            raise ConflictError(
                f"cannot delete media node — {assigned} camera(s) are still assigned to it; "
                "reassign or remove them first"
            )
        await self.db.delete(row)
        await self.db.commit()


# ── background heartbeat monitor (all tenants) ───────────────────────────────────
class NodeHeartbeatMonitor:
    """Estate-wide background heartbeat loop over ``media_nodes`` (all tenants).

    Started in ``app.main`` lifespan (like the ``HealthSampler``). Runs its own DB session
    per cycle (NOT request-scoped). Bounded concurrency via a semaphore; a per-cycle
    transient-DB backoff so a DB blip doesn't hot-loop. ``stop()`` cancels cleanly.
    """

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker
        self._task: asyncio.Task | None = None
        self._running = False

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        log.info(
            "media-node heartbeat monitor started (interval=%ss concurrency=%s timeout=%ss)",
            heartbeat_interval_sec(), heartbeat_concurrency(), heartbeat_timeout_sec(),
        )

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        log.info("media-node heartbeat monitor stopped")

    async def _loop(self) -> None:
        # Small settle before the first cycle (let NATS/DB finish warming up).
        try:
            await asyncio.sleep(min(8, heartbeat_interval_sec()))
        except asyncio.CancelledError:
            return
        backoff = heartbeat_interval_sec()
        while self._running:
            try:
                await self.run_cycle()
                backoff = heartbeat_interval_sec()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — one bad cycle must not kill the loop
                backoff = min(backoff * 2, 300)
                log.warning("node heartbeat cycle error (%s) — backing off %ss", exc, backoff)
            try:
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                return

    async def run_cycle(self) -> int:
        """One full pass: heartbeat every node with an ``api_url``. Returns the count
        pinged (handy for tests + logging)."""
        timeout = heartbeat_timeout_sec()
        sem = asyncio.Semaphore(heartbeat_concurrency())
        async with self._sessionmaker() as db:
            nodes = (
                await db.execute(select(MediaNode).where(MediaNode.api_url.isnot(None)))
            ).scalars().all()

            async def _guarded(node: MediaNode) -> None:
                async with sem:
                    try:
                        await _heartbeat_one(node, timeout=timeout)
                    except Exception as exc:  # noqa: BLE001 — a probe must never break the loop
                        log.debug("node heartbeat failed for %s: %s", node.id, exc)

            if nodes:
                await asyncio.gather(*(_guarded(n) for n in nodes))
            await db.commit()
        return len(nodes)


async def _heartbeat_one(node: MediaNode, *, timeout: float | None = None) -> None:
    """Probe ONE node + mutate its row (does NOT commit — the caller owns the txn).

    A ``draining`` node is LEFT alone (a graceful operator drain must not be flipped back
    to online by a heartbeat). Otherwise reachable → ``online`` + fresh ``last_heartbeat``
    (+ ``used_channels`` when the payload reports a count); unreachable → ``offline``.
    Never raises.
    """
    if node.status == "draining":
        return
    reachable, payload = await probe_node(node.api_url or "", timeout=timeout)
    now = _utcnow()
    if reachable:
        node.status = "online"
        node.last_heartbeat = now
        used = _used_channels_from_status(payload)
        if used is not None:
            node.used_channels = used
    else:
        node.status = "offline"
    node.updated_at = now
