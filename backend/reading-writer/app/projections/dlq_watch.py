"""EVENTS_DLQ finally has a reader — counts, and a log line per dead letter.

WHAT THIS CLOSES
----------------
Every terminal failure on the platform's buses now parks the message in
``EVENTS_DLQ`` (kernel + Go bus refusals, and both IoT pipelines' poison —
contract §4/§18), which bounded the loss but not the SILENCE: the stream had
zero consumers in either language, so a dead letter was recoverable in principle
and invisible in practice. This watch is the visibility half — deliberately NOT
a triage UI:

* a ``log.warning`` the moment a NEW dead letter arrives, carrying the origin
  subject, the refusing consumer, the delivery count and the reason from the
  ``Nbt-Dlq-*`` headers both buses write;
* counters by origin subject and by reason on ``/stats`` (``dlq_*`` keys)
  and ``/metrics``, plus the stream's own message count, so
  "is anything parked?" is one curl.

WHY IT LIVES HERE
-----------------
It rides with the projection consumers because they are the platform's standing
events-spine reader: always deployed, already carrying the ``/stats``-style
surface an operator watches, and language-neutral about what they observe (the
DLQ holds Go refusals as readily as Python ones). The kernel is a library and has
no process; a dedicated service would be a container for one fetch loop — which
is the same argument that folded the projector itself into this one.

WHAT CONSUMING DOES NOT DO
--------------------------
``EVENTS_DLQ`` is a LIMITS-retention stream: acking a delivered message does not
remove it. This durable is a cursor over the stream, nothing more — messages
still age out at the stream's own ``max_age`` (30 days), and replaying or
purging a parked message remains a deliberate operator action (``nats`` CLI),
never something a watcher does implicitly. On its very first bind the durable
starts at the beginning of the stream, so anything ALREADY parked is counted and
logged once — a watch that starts blind to the existing backlog would report "0
dead letters" over a stream holding thirteen.

Its own durable consumer is deliberately separate from every projection worker:
a wedged DLQ watch must never stall a projection, and vice versa. Same reasoning
as the reading-writer's placement/site-facts sidecars, and the same shape — own
connection, connect-retry loop, bounded drain on stop.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time

import nats
from kernel.events import DLQ_STREAM, DLQ_SUBJECT_PREFIX, ensure_dlq_stream
from nats.errors import TimeoutError as NatsTimeoutError
from nats.js.api import AckPolicy, ConsumerConfig

log = logging.getLogger("projector.dlq_watch")

DURABLE = "projector-dlq-watch"
SUBJECT = DLQ_SUBJECT_PREFIX + ">"

# A poison STORM must not turn /stats into a megabyte of one-off subjects. Past
# this many distinct keys, further ones collapse into "…other" — the counts stay
# right, the labels stay bounded, and the stream itself still holds every body.
_MAX_KEYS = 200
_OTHER = "…other"

# How often the stream's own message count is refreshed (a gauge, not a counter:
# it FALLS when parked messages age out or an operator purges fixtures).
_STREAM_POLL_SEC = 15.0


class DlqWatchStats:
    """Counters, so a parked message is a number on /stats instead of a rumour."""

    def __init__(self) -> None:
        self.connected = False
        self.messages_seen = 0                  # dead letters this process observed
        self.by_subject: dict[str, int] = {}    # origin subject → count
        self.by_reason: dict[str, int] = {}     # refusal reason → count
        self.last_seen_at: float | None = None
        self.last_subject: str | None = None
        self.last_reason: str | None = None
        self.stream_messages: int | None = None  # messages currently IN the stream
        self.errors = 0
        self.last_error: str | None = None

    def _bump(self, table: dict[str, int], key: str) -> None:
        if key not in table and len(table) >= _MAX_KEYS:
            key = _OTHER
        table[key] = table.get(key, 0) + 1

    def note(self, subject: str, reason: str) -> None:
        self.messages_seen += 1
        self.last_seen_at = time.time()
        self.last_subject = subject
        self.last_reason = reason
        self._bump(self.by_subject, subject)
        self._bump(self.by_reason, reason)

    def snapshot(self) -> dict:
        return {
            "dlq_watch_connected": self.connected,
            "dlq_messages_seen": self.messages_seen,
            "dlq_by_subject": dict(sorted(self.by_subject.items())),
            "dlq_by_reason": dict(sorted(self.by_reason.items())),
            "dlq_last_seen_at": self.last_seen_at,
            "dlq_last_subject": self.last_subject,
            "dlq_last_reason": self.last_reason,
            "dlq_stream_messages": self.stream_messages,
            "dlq_watch_errors": self.errors,
            "dlq_watch_last_error": self.last_error,
        }

    def prometheus(self) -> str:
        """Appended to the projector's exposition under its own prefix."""
        p = "projector_dlq_"
        lines = [
            f"# HELP {p}messages_seen_total Dead letters observed by this process.",
            f"# TYPE {p}messages_seen_total counter",
            f"{p}messages_seen_total {self.messages_seen}",
            f"# HELP {p}stream_messages Messages currently parked in EVENTS_DLQ.",
            f"# TYPE {p}stream_messages gauge",
            f"{p}stream_messages {self.stream_messages if self.stream_messages is not None else -1}",
            f"# HELP {p}watch_connected 1 when the DLQ watch consumer is bound.",
            f"# TYPE {p}watch_connected gauge",
            f"{p}watch_connected {int(self.connected)}",
        ]
        lines.append(f"# HELP {p}by_reason Dead letters observed, by refusal reason.")
        lines.append(f"# TYPE {p}by_reason counter")
        for reason, count in sorted(self.by_reason.items()):
            safe = reason.replace('"', "").replace("\n", " ")[:120]
            lines.append(f'{p}by_reason{{reason="{safe}"}} {count}')
        return "\n".join(lines) + "\n"


class DlqWatch:
    def __init__(self, stats: DlqWatchStats) -> None:
        self.stats = stats
        self._nc = None
        self._js = None
        self._sub = None
        self._task: asyncio.Task | None = None
        self._running = False

    async def start(self, nats_url: str) -> None:
        if not nats_url:
            log.info("VE_NATS_URL unset — dead letters will not be watched")
            return
        self._running = True
        self._task = asyncio.create_task(self._run(nats_url), name="pj-dlq-watch")

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None
        if self._nc is not None:
            # Bounded drain, then close — a pull consumer has nothing buffered
            # to flush, so an unbounded drain() can only make a shutdown hang.
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._nc.drain(), timeout=2.0)
            with contextlib.suppress(Exception):
                await self._nc.close()
            self._nc = None
        self.stats.connected = False

    # ── loop ─────────────────────────────────────────────────────────────────
    async def _run(self, nats_url: str) -> None:
        while self._running:
            try:
                await self._connect(nats_url)
                await self._consume()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — never let the loop die
                self.stats.connected = False
                self.stats.errors += 1
                self.stats.last_error = f"{type(exc).__name__}: {exc}"
                log.warning("DLQ watch loop restarting after: %s", exc)
                await asyncio.sleep(5.0)

    async def _connect(self, nats_url: str) -> None:
        if self._nc is None or not self._nc.is_connected:
            self._nc = await nats.connect(
                nats_url, name="neubit-projector-dlq-watch",
                max_reconnect_attempts=-1,
            )
            self._js = self._nc.jetstream()
        # The stream is normally created by whichever bus client connects first;
        # ensure it here too so the watch can bind on a fresh deployment instead
        # of retrying until something else dead-letters. Never raises.
        await ensure_dlq_stream(self._js)
        cfg = ConsumerConfig(
            durable_name=DURABLE,
            filter_subject=SUBJECT,
            ack_policy=AckPolicy.EXPLICIT,
            ack_wait=60.0,
            # Observing must never discard: there is no "give up" on a counter
            # bump, and the loop below acks unconditionally after counting.
            max_deliver=-1,
        )
        self._sub = await self._js.pull_subscribe(
            SUBJECT, durable=DURABLE, stream=DLQ_STREAM, config=cfg
        )
        self.stats.connected = True
        log.info("bound durable pull consumer %s on %s (filter=%s)", DURABLE, DLQ_STREAM, SUBJECT)

    async def _consume(self) -> None:
        last_poll = 0.0
        while self._running:
            now = time.monotonic()
            if now - last_poll >= _STREAM_POLL_SEC:
                last_poll = now
                with contextlib.suppress(Exception):
                    info = await self._js.stream_info(DLQ_STREAM)
                    self.stats.stream_messages = int(info.state.messages)
            try:
                msgs = await self._sub.fetch(64, timeout=5.0)
            except (NatsTimeoutError, asyncio.TimeoutError):
                continue  # an empty DLQ is the healthy case
            for msg in msgs:
                self._observe(msg)
                with contextlib.suppress(Exception):
                    await msg.ack()

    # ── one dead letter ──────────────────────────────────────────────────────
    def _observe(self, msg) -> None:
        """Count + log one dead letter. Never raises — observation must not wedge."""
        headers = msg.headers or {}
        origin = headers.get("Nbt-Dlq-Origin-Subject") or (
            msg.subject[len(DLQ_SUBJECT_PREFIX):] if msg.subject.startswith(DLQ_SUBJECT_PREFIX)
            else msg.subject
        )
        reason = headers.get("Nbt-Dlq-Reason") or "(no reason header)"
        consumer = headers.get("Nbt-Dlq-Consumer") or "?"
        deliveries = headers.get("Nbt-Dlq-Deliveries") or "?"
        self.stats.note(origin, reason)
        log.warning(
            "DEAD LETTER: %s refused by %s after %s deliveries: %s",
            origin, consumer, deliveries, reason,
        )
