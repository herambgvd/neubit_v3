"""In-process POS line pub/sub hub — bounded ring buffer + live fan-out.

Ingest publishes each POS transaction line into the hub keyed by
``(tenant, terminal)``; every open SSE stream for that key gets it pushed onto its
queue. A bounded per-key ring buffer keeps the most-recent lines so a stream that
connects AFTER a line arrived still shows recent context (replayed on connect).

Single-process, in-memory — which is exactly right for the vision service today
(ingest + stream run in the same process). It ALSO best-effort mirrors each line
onto the NATS spine (``tenant.<id>.vms.pos``) so other services/observability can
see the feed, but the browser stream does NOT depend on NATS being up — the push
path works out of the box with zero external infra. If vision is ever scaled to
multiple worker processes, the NATS mirror is the seam to bridge cross-worker.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict, deque

# Most-recent lines retained per (tenant, terminal) for replay-on-connect.
RING_SIZE = 50
# Per-subscriber queue bound — a slow browser can't make ingest block; oldest are
# dropped for that one stream if it falls this far behind.
SUB_QUEUE_MAX = 200


def hub_key(tenant_id: str | None, terminal: str) -> tuple[str, str]:
    """Normalise (tenant, terminal) into the hub dict key (NULL tenant → ``__none__``)."""
    return (str(tenant_id) if tenant_id else "__none__", terminal)


class PosHub:
    """Process-wide POS line hub: bounded ring buffer + per-key subscriber queues."""

    def __init__(self, ring_size: int = RING_SIZE) -> None:
        self._ring_size = ring_size
        self._ring: dict[tuple[str, str], deque] = defaultdict(
            lambda: deque(maxlen=self._ring_size)
        )
        self._subs: dict[tuple[str, str], set[asyncio.Queue]] = defaultdict(set)

    def publish(self, key: tuple[str, str], line: dict) -> int:
        """Append ``line`` to the ring and fan it out. Returns the live-subscriber count."""
        self._ring[key].append(line)
        subs = self._subs.get(key)
        if not subs:
            return 0
        for q in list(subs):
            try:
                q.put_nowait(line)
            except asyncio.QueueFull:
                # This one stream is behind — drop its oldest to make room (live feed).
                try:
                    q.get_nowait()
                    q.put_nowait(line)
                except Exception:  # noqa: BLE001 — best-effort, never break ingest
                    pass
        return len(subs)

    def recent(self, key: tuple[str, str]) -> list[dict]:
        """Snapshot of the retained ring buffer for ``key`` (oldest → newest)."""
        return list(self._ring.get(key, ()))

    def subscribe(self, key: tuple[str, str]) -> asyncio.Queue:
        """Register a live subscriber; returns its queue (unsubscribe when done)."""
        q: asyncio.Queue = asyncio.Queue(maxsize=SUB_QUEUE_MAX)
        self._subs[key].add(q)
        return q

    def unsubscribe(self, key: tuple[str, str], q: asyncio.Queue) -> None:
        """Detach a subscriber queue (idempotent)."""
        subs = self._subs.get(key)
        if subs:
            subs.discard(q)
            if not subs:
                self._subs.pop(key, None)


# Process-wide singleton — imported by the router (ingest publishes, stream subscribes).
hub = PosHub()
