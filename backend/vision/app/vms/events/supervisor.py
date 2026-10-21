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

── a backlog drains oldest first (SCRUM-333) ─────────────────────────────────────

The node used to answer newest first only, and the watermark then moved to the
newest row of the page. Whenever more than one page had built up since the
watermark (an outage, a first poll's day of history, a busy recorder), the page was
the TOP of the backlog and everything below it was skipped for good, without a log
line. So it asks ``order=asc`` now, moves the watermark after every page, and keeps
reading while pages come back full, up to a cap per tick; the next tick carries on.

A recorder too old to know ``order`` answers newest first and does not echo it. It
gets the old behaviour, plus a warning whenever a full page means rows were skipped.
It sends no ``server_time`` either, so its events are not aged (below).

── a backlog is history, not alarms ──────────────────────────────────────────────

Every ingested row used to be published, and the console's pop-up and siren,
workflow incidents and linkage actions all act on a publish. Nothing looked at the
event's age, so a catch-up would ring yesterday's motion as alarms now. An event
older than the live window is stored and NOT published. Its age is taken on the
recorder's own clock (``server_time - created_at``), so neither this server's
offset from the recorder nor a camera's skewed clock moves an event across the
line.

Config (env, ``VE_`` prefix):
  * ``VE_EVENT_SUPERVISOR_ENABLED``  — master switch (default "1"; "0" disables).
  * ``VE_EVENT_RESCAN_INTERVAL_SEC`` — seconds between polls (default 5, floor 2). An
    alarm or a plate read that reaches the operator half a minute late has missed the
    vehicle; each poll asks only for rows newer than the watermark, so it is cheap.
  * ``VE_EVENT_SUB_CONCURRENCY``     — how many nodes are polled at once (default 16).
  * ``VE_EVENT_POLL_LIMIT``          — events per page (default 200, max 500).
  * ``VE_EVENT_POLL_MAX_PAGES``      — pages read from one node in one tick (default 10).
  * ``VE_EVENT_LIVE_WINDOW_SEC``     — an event older than this is stored as history
    and not published (default 300; 0 publishes nothing that was not caught live).
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
    return max(2, _env_int("VE_EVENT_RESCAN_INTERVAL_SEC", 5))


def poll_concurrency() -> int:
    return max(1, _env_int("VE_EVENT_SUB_CONCURRENCY", 16))


def poll_limit() -> int:
    return max(1, min(_env_int("VE_EVENT_POLL_LIMIT", 200), 500))


def poll_max_pages() -> int:
    return max(1, _env_int("VE_EVENT_POLL_MAX_PAGES", 10))


def live_window() -> timedelta:
    return timedelta(seconds=max(0, _env_int("VE_EVENT_LIVE_WINDOW_SEC", 300)))


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
        limit = poll_limit()
        for _ in range(poll_max_pages()):
            try:
                payload = await fed.list_events_node(
                    api_url,
                    since=since.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                    limit=limit,
                    order="asc",
                    credential=getattr(node, "credential", None),
                )
            except fed.NodeUnavailable as exc:
                # An unreachable recorder is normal (rebooting, network). The watermark
                # is NOT advanced, so whatever it kept is picked up when it returns.
                log.info("event poll: node %s unreachable: %s", node.name, exc)
                return

            items = payload.get("items") if isinstance(payload, dict) else None
            if not isinstance(items, list) or not items:
                return
            newest = await self._ingest_page(node, items, since, payload)
            full = len(items) >= limit
            if payload.get("order") != "asc":
                # A recorder that predates order=asc served the NEWEST page, and the
                # watermark has just moved past whatever sat below it.
                if full:
                    log.warning(
                        "event poll: node %s served newest first (no order=asc); more than "
                        "%d events since %s, so the older ones were skipped. Update the "
                        "recorder.", node.name, limit, since.isoformat(),
                    )
                return
            # A short page is the end of the backlog. A full page that did not move the
            # watermark (every row on the boundary instant) would only repeat itself.
            if not full or newest <= since:
                return
            since = newest

    async def _ingest_page(
        self, node: MediaNode, items: list, since: datetime, payload: dict
    ) -> datetime:
        """Ingest one page and persist the watermark. Returns the new watermark."""
        # The recorder's clock, so an event's age never depends on ours. A recorder
        # that does not send it is not aged at all: judged on OUR clock, a recorder
        # running a few minutes off would have its live alarms filed silently as
        # history, and a missed alarm is the worse failure.
        node_now = _parse_dt(payload.get("server_time"))
        window = live_window()
        newest = since
        history = 0
        async with self._sessionmaker() as db:
            svc = VmsEventService(db, _PLATFORM_SCOPE)
            for raw in items:
                if not isinstance(raw, dict):
                    continue
                created = _parse_dt(raw.get("created_at"))
                # A row with no created_at must not move the watermark: "now" would
                # jump it past the rest of the backlog.
                if created is not None and created > newest:
                    newest = created
                live = node_now is None or created is None or node_now - created <= window
                if not live:
                    history += 1
                await self._ingest(svc, node, raw, publish=live)
            # The watermark moves ONLY after a batch is ingested, and it is written
            # where a restart can find it. An unreachable recorder never reaches
            # here, so whatever it kept is asked for again when it returns.
            row = await db.get(MediaNode, node.id)
            if row is not None:
                row.events_synced_at = newest
                await db.commit()
        self._watermark[node.id] = newest
        if history:
            log.info(
                "event poll: node %s: %d of %d events older than %ss stored as history, "
                "not raised as alarms", node.name, history, len(items),
                int(window.total_seconds()),
            )
        return newest

    async def _ingest(
        self, svc: VmsEventService, node: MediaNode, raw: dict, *, publish: bool = True
    ) -> None:
        """One node event → one estate event. Never raises: a single malformed row
        must not stop the rest of the batch."""
        try:
            await svc.ingest_device_event(
                tenant_id=node.tenant_id,
                camera_id=raw.get("camera_id"),
                driver_event_type=str(raw.get("type") or "other"),
                severity=str(raw.get("severity") or "info"),
                title=_event_title(raw),
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
                publish=publish,
            )
        except Exception as exc:  # noqa: BLE001
            log.info("event ingest failed for node %s event %s: %s", node.name, raw.get("id"), exc)


def _event_title(raw: dict) -> str:
    """The line an operator reads first. A plate read leads with its plate (SCRUM-324):
    at a gate the plate IS the alert, and the camera name alone says nothing."""
    camera = str(raw.get("camera_name") or "")
    if raw.get("type") == "anpr":
        anpr = ((raw.get("payload") or {}).get("anpr") or {}) if isinstance(raw.get("payload"), dict) else {}
        plate = str(anpr.get("plate") or "").strip()
        head = f"Plate {plate}" if plate else "Vehicle without a plate"
        return f"{head} · {camera}" if camera else head
    return camera or str(raw.get("type") or "event")


__all__ = ["EventSupervisor", "supervisor_enabled", "rescan_interval_sec"]
