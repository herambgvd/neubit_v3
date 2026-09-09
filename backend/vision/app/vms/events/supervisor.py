"""Event supervisor — pull each RECORDER's event ledger into the estate feed.

Every recorder runs its own ONVIF PullPoint listener for the cameras it owns, stores
what it hears, and serves that ledger over ``GET /estate/events``. This task polls
each registered node and routes what it finds through
``VmsEventService.ingest_device_event`` (normalize → dedupe → persist → publish
``tenant.<id>.vms.camera.<event_type>``) — the same subject family workflow already
consumes, so nothing downstream changes.

── why it polls instead of subscribing ──────────────────────────────────────────

It used to open its OWN PullPoint subscription per camera, decrypting the camera's
credentials to do it. That made two subscribers on one device: this service and the
recorder that owns the camera. Many cameras permit exactly one, and the loser does
not get an error — it gets silence. So the failure mode was an event feed that looked
healthy and was missing events, on a schedule nobody could predict.

Reading the recorder's ledger has the additional property that the events are the
SAME events the recorder acted on: the ones that armed its recording and fired its
own alarms. Two independent subscriptions could legitimately disagree.

── the dedupe is load-bearing ───────────────────────────────────────────────────

``since`` on the node filters ``created_at >= since``, so consecutive polls overlap by
design, and a node reachable again after an outage replays whatever it kept. What
saves that is the dedup key already in ``ingest_device_event``:
``sha256(camera_id : event_type : time-bucket)`` behind a unique index. The bucket is
computed from ``occurred_at``, and ``occurred_at`` is taken from the NODE's own
``started_at`` — the same value every time that event is served — so re-reading it
lands on the identical key and the insert is dropped.

That last detail is why ``started_at`` is used and not the poll time. Stamping the
event when the VMS happened to read it would put re-reads of one alarm in different
buckets, and polling would multiply it by the number of ticks it survived.

Config (env, ``VE_`` prefix):
  * ``VE_EVENT_SUPERVISOR_ENABLED``  — master switch (default "1"; "0" disables).
  * ``VE_EVENT_RESCAN_INTERVAL_SEC`` — seconds between polls (default 30).
  * ``VE_EVENT_SUB_CONCURRENCY``     — how many nodes are polled at once (default 16).
  * ``VE_EVENT_POLL_LIMIT``          — max events fetched per node per tick (default 200).
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kernel.auth import Scope

from app.vms.federation import client as fed
from app.vms.models import MediaNode

from .service import VmsEventService

log = logging.getLogger("vision.event_supervisor")

# A platform scope for the background writer (it authorizes off the node row, not a
# caller — it only ever writes an event under that node's tenant).
_PLATFORM_SCOPE = Scope(tenant_id=None, is_superadmin=True)

# How far back a node is asked for on the FIRST poll after this process starts. Short
# on purpose: the point is to catch what happened during a restart, not to re-import
# history that is already in the table.
# HOW FAR BACK A COLD START ASKS.
#
# This was 15 minutes, with the watermark held in memory only — so a restart asked
# each recorder for the last quarter of an hour and nothing else. On a live estate
# that meant an empty event feed while the recorder held 56 events, the newest of
# them ninety minutes old: the poll succeeded every time and returned nothing.
#
# The watermark is persisted now (media_nodes.events_synced_at), so this only
# applies to a node whose ledger has never been mirrored. A day is the right size
# for that: it is what makes a newly enrolled recorder's existing events show up at
# all, and re-asking is free — the ingest path dedupes on (camera, type,
# time-bucket) behind a UNIQUE constraint.
_COLD_START_LOOKBACK = timedelta(hours=24)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


def supervisor_enabled() -> bool:
    return (os.getenv("VE_EVENT_SUPERVISOR_ENABLED", "1").strip() or "1") != "0"


def rescan_interval_sec() -> int:
    return max(5, _env_int("VE_EVENT_RESCAN_INTERVAL_SEC", 30))


def poll_concurrency() -> int:
    return max(1, _env_int("VE_EVENT_SUB_CONCURRENCY", 16))


def poll_limit() -> int:
    return max(1, min(_env_int("VE_EVENT_POLL_LIMIT", 200), 500))


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse_dt(value) -> datetime | None:
    """RFC3339 → aware datetime, or None. The node emits Z; Python wants +00:00."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class EventSupervisor:
    """Polls every registered recorder's event ledger on a tick."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker
        self._task: asyncio.Task | None = None
        self._stopping = asyncio.Event()
        # node id → the newest ``created_at`` already ingested from it, as a
        # per-process fast path. The DURABLE copy is media_nodes.events_synced_at,
        # which is what a restarted process resumes from.
        self._watermark: dict[str, datetime] = {}

    async def start(self) -> None:
        if not supervisor_enabled():
            log.info("event supervisor disabled (VE_EVENT_SUPERVISOR_ENABLED=0)")
            return
        if self._task is not None:
            return
        self._stopping.clear()
        self._task = asyncio.create_task(self._run(), name="vms-event-supervisor")
        log.info("event supervisor started (poll every %ss)", rescan_interval_sec())

    async def stop(self) -> None:
        self._stopping.set()
        task, self._task = self._task, None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 — shutdown is best-effort
            pass

    async def _run(self) -> None:
        while not self._stopping.is_set():
            try:
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — a bad tick must never end the loop
                log.info("event supervisor tick failed: %s", exc)
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=rescan_interval_sec())
            except asyncio.TimeoutError:
                continue

    async def _tick(self) -> None:
        async with self._sessionmaker() as db:
            nodes = list((await db.execute(select(MediaNode))).scalars().all())
        if not nodes:
            return
        sem = asyncio.Semaphore(poll_concurrency())

        async def _one(node: MediaNode) -> None:
            async with sem:
                await self._poll_node(node)

        # gather(return_exceptions) so one unreachable recorder cannot cancel the poll
        # of every other one.
        await asyncio.gather(*(_one(n) for n in nodes), return_exceptions=True)

    async def _poll_node(self, node: MediaNode) -> None:
        api_url = (getattr(node, "api_url", None) or "").strip()
        if not api_url:
            return
        # In-process watermark, else the one persisted on the node row, else a cold
        # start. The middle term is the one that matters: without it a restart
        # forgets everything the recorder is still holding.
        stored = getattr(node, "events_synced_at", None)
        if stored is not None and stored.tzinfo is None:
            stored = stored.replace(tzinfo=timezone.utc)
        since = self._watermark.get(node.id) or stored or (_utcnow() - _COLD_START_LOOKBACK)
        try:
            payload = await fed.list_events_node(
                api_url,
                since=since.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                limit=poll_limit(),
                credential=getattr(node, "credential", None),
            )
        except fed.NodeUnavailable as exc:
            # An unreachable recorder is normal (rebooting, network). The watermark is
            # NOT advanced, so whatever it kept is picked up when it returns.
            log.info("event poll: node %s unreachable: %s", node.name, exc)
            return

        items = payload.get("items") if isinstance(payload, dict) else None
        if not isinstance(items, list) or not items:
            return

        newest = since
        async with self._sessionmaker() as db:
            svc = VmsEventService(db, _PLATFORM_SCOPE)
            for raw in items:
                if not isinstance(raw, dict):
                    continue
                created = _parse_dt(raw.get("created_at")) or _utcnow()
                if created > newest:
                    newest = created
                await self._ingest(svc, node, raw)
            # The watermark moves ONLY after a batch is ingested, and it is written
            # where a restart can find it. An unreachable recorder never reaches
            # here, so whatever it kept is asked for again when it returns.
            row = await db.get(MediaNode, node.id)
            if row is not None:
                row.events_synced_at = newest
                await db.commit()
        self._watermark[node.id] = newest

    async def _ingest(self, svc: VmsEventService, node: MediaNode, raw: dict) -> None:
        """One node event → one estate event. Never raises: a single malformed row
        must not stop the rest of the batch."""
        try:
            await svc.ingest_device_event(
                tenant_id=node.tenant_id,
                camera_id=raw.get("camera_id"),
                driver_event_type=str(raw.get("type") or "other"),
                severity=str(raw.get("severity") or "info"),
                title=str(raw.get("camera_name") or raw.get("type") or "event"),
                # The recorder's own row, kept whole — its raw ONVIF topic, its
                # payload, and its event id, so an estate event can always be traced
                # back to the recorder row it came from.
                raw={
                    "node_id": str(node.id),
                    "node_event_id": raw.get("id"),
                    "topic": raw.get("topic"),
                    "payload": raw.get("payload"),
                    "stateful": raw.get("stateful"),
                    "started_at": raw.get("started_at"),
                    "ended_at": raw.get("ended_at"),
                },
                source=str(raw.get("source") or "onvif"),
                occurred_at=_parse_dt(raw.get("started_at")) or _parse_dt(raw.get("created_at")),
            )
        except Exception as exc:  # noqa: BLE001
            log.info("event ingest failed for node %s event %s: %s", node.name, raw.get("id"), exc)


__all__ = ["EventSupervisor", "supervisor_enabled", "rescan_interval_sec"]
