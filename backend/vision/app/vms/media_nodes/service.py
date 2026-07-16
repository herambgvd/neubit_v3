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
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ConflictError, ValidationError

from app.vms.common.events import emit_node_failover
from app.vms.common.service_token import mint_service_token
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

# Recording modes whose data-plane is driven IMMEDIATELY (so a DEF-A failover must resume
# them on the new node). Mirrors ``cameras.service._IMMEDIATE_RECORDING_MODES`` +
# ``recording.service._IMMEDIATE_MODES``; schedule/motion/event are (re)opened by the
# recording scheduler / P5 on the new node once it fronts the camera.
_FAILOVER_RESUME_MODES = {"continuous", "manual"}


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


def failover_dead_sec() -> int:
    """Seconds a node must be offline (by ``last_heartbeat`` age) before its cameras are
    failed over to a healthy recorder. Default 90s — long enough to ride out a transient
    network blip / a couple of missed heartbeats, short enough that recording resumes fast.
    """
    return max(0, _env_int("VE_NODE_FAILOVER_DEAD_SEC", 90))


def _is_failover_eligible(node: MediaNode, *, now: datetime, dead_sec: int) -> bool:
    """A node is FAILOVER-ELIGIBLE (its cameras should be moved to a healthy recorder) when
    it is genuinely dead — ``status == 'offline'`` AND its last heartbeat is older than the
    dead threshold. A NULL ``last_heartbeat`` on an offline node is treated as infinitely
    old (eligible immediately). ``draining`` (an intentional operator drain, not a death) and
    api_url-less nodes are NEVER eligible.
    """
    if node.status != "offline":
        return False
    if not (node.api_url or "").strip():
        return False
    last = node.last_heartbeat
    if last is None:
        return True  # offline + never/again heartbeated → age is effectively infinite
    # last_heartbeat may be naive (SQLite drops tz); assume UTC for the age comparison.
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return (now - last) >= timedelta(seconds=dead_sec)


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

            # DEF-A: cross-machine recorder failover. Run AFTER the status refresh (a node
            # that just went offline this cycle is now marked so) but as a bounded, wholly
            # best-effort step — a failover error must never break the heartbeat loop.
            try:
                await self._failover_cycle(db, now=_utcnow())
            except Exception as exc:  # noqa: BLE001 — failover must never kill the loop
                log.warning("node failover step errored (skipped this cycle): %s", exc)
        return len(nodes)

    # ── DEF-A: cross-machine recorder failover ───────────────────────────────
    async def _failover_cycle(self, db: AsyncSession, *, now: datetime) -> int:
        """Reassign the cameras of every DEAD recorder machine to a healthy recorder and
        resume recording there, so recording doesn't stop when a whole node dies.

        Distinct from the Go-side P6-A rebalance (intra-nvr, across MediaMTX nodes of ONE
        nvr): this is cross-INDEPENDENT-nvr failover, orchestrated by vision.

        Idempotent by construction: after a camera is moved off the dead node it no longer
        matches ``media_node_id == dead.id``, so a re-run finds nothing to move — NO
        per-node "already failed over" flag is needed. Returns the number of cameras moved
        (handy for tests/logging).

        NO auto-failback: when the dead node later returns online we do NOT move its cameras
        back (that would thrash the data-plane). Its recovered footage stays playable via
        DEF-B (recordings carry the producing node). Operators can manually reassign the
        cameras back to the recovered recorder from the Recorders UI if they want locality.
        """
        dead_sec = failover_dead_sec()
        nodes = (await db.execute(select(MediaNode))).scalars().all()
        dead = [n for n in nodes if _is_failover_eligible(n, now=now, dead_sec=dead_sec)]
        if not dead:
            return 0

        # Candidate healthy recorders = online nodes with an api_url (never offline/draining).
        healthy = [
            n for n in nodes if n.status == "online" and (n.api_url or "").strip()
        ]
        moved_total = 0
        for node in dead:
            moved = await self._failover_node(db, node, healthy, now=now)
            moved_total += moved
        return moved_total

    async def _failover_node(
        self, db: AsyncSession, dead: MediaNode, healthy: list[MediaNode], *, now: datetime
    ) -> int:
        """Reassign one dead node's cameras onto healthy recorders. Returns cameras moved."""
        cams = (
            await db.execute(select(Camera).where(Camera.media_node_id == dead.id))
        ).scalars().all()
        if not cams:
            return 0

        # Per-node live channel load, so we spread reassigned cameras across recorders
        # (least-loaded first). Seed from ``used_channels`` (the heartbeat-reported count),
        # then increment locally as we place cameras this cycle.
        load: dict[str, int] = {n.id: int(n.used_channels or 0) for n in healthy}

        moved = 0
        for cam in cams:
            target = self._pick_target(cam, healthy, load)
            if target is None:
                # No healthy recorder is tenant-usable for this camera → strand it (leave
                # the assignment on the dead node; recording stays down until a recorder
                # recovers). Alert once per stranded camera batch below.
                continue
            old_node_id = cam.media_node_id
            cam.media_node_id = target.id
            cam.updated_at = _utcnow()
            # Persist the reassignment FIRST (so a resume failure can't lose it), then
            # bump the local load so the next camera balances against this placement.
            await db.commit()
            load[target.id] = load.get(target.id, 0) + 1
            moved += 1

            # Best-effort: resume recording on the new node for immediate-mode cameras.
            await self._resume_recording(db, cam)
            # Operator-visible failover event + core audit trail per reassignment.
            await self._emit_failover(cam, dead, target)

        stranded = [c for c in cams if c.media_node_id == dead.id]
        if stranded:
            # Group the alert by tenant (a node can only hold one tenant's cameras in
            # practice, but be defensive) — one "stranded" event per tenant.
            by_tenant: dict[object, int] = {}
            for c in stranded:
                by_tenant[c.tenant_id] = by_tenant.get(c.tenant_id, 0) + 1
            for tenant_id, count in by_tenant.items():
                reason = (
                    f"node {dead.id} dead, no healthy recorder for tenant "
                    f"{tenant_id} — {count} camera(s) stranded"
                )
                log.warning("failover: %s", reason)
                try:
                    await emit_node_failover(
                        tenant_id,
                        "stranded",
                        {"node_id": dead.id, "stranded_cameras": count, "reason": reason},
                    )
                except Exception as exc:  # noqa: BLE001 — an emit must not break the loop
                    log.info("failover stranded-emit failed for node %s: %s", dead.id, exc)

        if moved:
            log.info(
                "failover: node %s dead → moved %s camera(s) to %s",
                dead.id, moved, sorted({c.media_node_id for c in cams if c.media_node_id != dead.id}),
            )
        return moved

    @staticmethod
    def _pick_target(
        cam: Camera, healthy: list[MediaNode], load: dict[str, int]
    ) -> MediaNode | None:
        """Least-loaded ONLINE recorder that is tenant-usable for ``cam`` (its node tenant is
        NULL/shared OR equals the camera's tenant) — never another tenant's private node, and
        never the dead/draining/offline nodes (``healthy`` is already online-only). ``None``
        when no usable target exists (→ the camera is stranded, an alert is emitted)."""
        usable = [
            n for n in healthy
            if n.tenant_id is None or n.tenant_id == cam.tenant_id
        ]
        if not usable:
            return None
        return min(usable, key=lambda n: load.get(n.id, 0))

    async def _resume_recording(self, db: AsyncSession, cam: Camera) -> None:
        """Best-effort resume recording on the camera's NEW node (immediate modes only).

        The camera row already carries the new ``media_node_id``, so ``_drive_start``
        routes to the new recorder via ``_nvr_for``. Background caller → no request bearer,
        so we mint a service token scoped to the camera's tenant (like the recording
        scheduler). Wrapped so ANY nvr failure is logged and swallowed — the reassignment
        is already persisted; the recording scheduler's continuous self-heal re-asserts the
        start on a later pass if this resume didn't land."""
        if not cam.is_enabled or cam.recording_mode not in _FAILOVER_RESUME_MODES:
            return
        try:
            from app.vms.recording.service import RecordingService

            tenant = str(cam.tenant_id) if cam.tenant_id else None
            token = mint_service_token(tenant_id=tenant)
            scope = Scope(tenant_id=cam.tenant_id, is_superadmin=True)
            rec = RecordingService(db, scope, bearer=token)
            await rec._drive_start(cam, trigger=cam.recording_mode)
            log.info("failover: resumed recording for camera %s on node %s", cam.id, cam.media_node_id)
        except Exception as exc:  # noqa: BLE001 — a resume failure must not break the loop
            log.info("failover: recording resume failed for camera %s: %s", cam.id, exc)

    async def _emit_failover(self, cam: Camera, dead: MediaNode, target: MediaNode) -> None:
        """Emit the per-reassignment failover event + a core audit entry. Best-effort."""
        try:
            await emit_node_failover(
                cam.tenant_id,
                "reassigned",
                {
                    "camera_id": cam.id,
                    "from_node_id": dead.id,
                    "to_node_id": target.id,
                    "node_name": target.name,
                },
            )
        except Exception as exc:  # noqa: BLE001 — an emit must not break the loop
            log.info("failover reassigned-emit failed for camera %s: %s", cam.id, exc)
        # Video/infra audit trail (WHO/WHAT touched recording): the failover is a
        # system-initiated recorder reassignment — record it to core's tamper-evident log
        # for the same operational-forensics reason we audit playback/export.
        try:
            from app.vms.common.core_audit import report_video_audit
            from kernel.auth import Principal

            principal = Principal(
                user_id=None, tenant_id=cam.tenant_id, is_superadmin=True, permissions=["*"]
            )
            await report_video_audit(
                action="vms.recorder.failover",
                camera_id=cam.id,
                principal=principal,
                meta={"from_node_id": dead.id, "to_node_id": target.id, "reason": "node_dead"},
            )
        except Exception as exc:  # noqa: BLE001 — auditing must never break the loop
            log.info("failover audit failed for camera %s: %s", cam.id, exc)


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
