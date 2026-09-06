"""Whether the JetStream durables this service binds are still consuming.

Both long-lived consumers here are PUSH subscriptions, and a push subscription
that has stopped receiving looks exactly like a quiet hour: no exception, no
callback, no counter movement, and ``EventBus.is_connected()`` still True. The
durable may have been deleted out of band, the client's subscription may be gone
after a reconnect, or the handler may be failing and redelivering forever.

So this asks the server on its own timer, and keeps two numbers apart:

  ``num_pending``  the lag. 0 both for caught-up and for not-consuming-at-all,
                   which is why it cannot stand alone.
  ``push_bound``   whether the server has an active delivery binding. False while
                   we believe we are subscribed is the wedge.

Not a traffic gauge: an idle, correctly attached consumer reads healthy all night.
What goes red is a missing durable or binding, never an absence of events.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field

from kernel.events import EVENTS_STREAM, EventBus

log = logging.getLogger("workflow.runtime.consumers")

# Far below every silence limit that reads these numbers, so one failed call
# during a blip cannot red the service; only a sustained streak can.
POLL_INTERVAL_SEC = 10.0


@dataclass
class DurableState:
    """What the last successful ``consumer_info`` said about one durable."""

    durable: str
    pending: int = 0            # the lag
    ack_pending: int = 0        # delivered, handler has not returned
    redelivered: int = 0        # handler raised; NAKed and coming back
    delivered: int = 0          # consumer sequence, monotonic — proves motion
    push_bound: bool = False    # the server has an active delivery binding
    last_ok_mono: float | None = None
    missing: str | None = None  # why the last check failed; None = it did not
    checks_failed: int = 0

    def unconfirmed_sec(self) -> float:
        """Seconds since this durable was last confirmed present AND bound."""
        return 0.0 if self.last_ok_mono is None else round(time.monotonic() - self.last_ok_mono, 1)


class ConsumerWatch:
    """Polls ``consumer_info`` for a set of durables on one bus.

    One instance per logical consumer, and ``label`` prefixes every reason string
    and metric label, so a reader is told which consumer is wedged.
    """

    def __init__(
        self,
        bus: EventBus,
        durables: list[str],
        *,
        label: str,
        silence_limit_sec: float,
        lag_warn: int,
        interval_sec: float = POLL_INTERVAL_SEC,
    ) -> None:
        self.bus = bus
        self.label = label
        self.silence_limit_sec = silence_limit_sec
        self.lag_warn = lag_warn
        self.interval_sec = interval_sec
        self.states: dict[str, DurableState] = {d: DurableState(durable=d) for d in durables}
        self._task: asyncio.Task | None = None

    # ── lifecycle ────────────────────────────────────────────────────────────

    async def start(self) -> None:
        if self._task is None:
            # Poll inline once so a scrape right after startup reports real
            # numbers instead of "never confirmed".
            await self.poll_once()
            self._task = asyncio.create_task(self._loop(), name=f"consumer-watch-{self.label}")

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None

    async def _loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(self.interval_sec)
                await self.poll_once()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                # The watchdog must not be the thing that dies: a crashed watch
                # leaves the wedge it exists to find invisible.
                log.warning("consumer watch %s: poll loop error: %s", self.label, e)

    # ── the poll ─────────────────────────────────────────────────────────────

    async def poll_once(self) -> None:
        # kernel's EventBus exposes only `is_connected()`, so read the JetStream
        # context off the private attribute. getattr with a fallback so this
        # degrades to "unknown" rather than raising if kernel's internals move.
        js = getattr(self.bus, "_js", None)
        for durable, st in self.states.items():
            if js is None:
                st.missing = "NATS not connected"
                st.checks_failed += 1
                continue
            try:
                info = await js.consumer_info(EVENTS_STREAM, durable)
            except Exception as e:  # noqa: BLE001 — absent, renamed, or NATS down
                # Leave the timestamp alone so one failed call cannot red the
                # service; the silence limit debounces it. Clear `push_bound`
                # though — it is the raw last answer, and a gauge that holds its
                # last good value through an outage lies.
                st.push_bound = False
                st.missing = f"{type(e).__name__}: {e}"[:200]
                st.checks_failed += 1
                continue
            st.pending = int(getattr(info, "num_pending", 0) or 0)
            st.ack_pending = int(getattr(info, "num_ack_pending", 0) or 0)
            st.redelivered = int(getattr(info, "num_redelivered", 0) or 0)
            st.delivered = int(getattr(getattr(info, "delivered", None), "consumer_seq", 0) or 0)
            bound = getattr(info, "push_bound", None)
            # None on a pull consumer and on older servers. Treat None as bound,
            # so a server that does not report the field cannot invent a wedge.
            st.push_bound = True if bound is None else bool(bound)
            if not st.push_bound:
                st.missing = "durable exists but nothing is bound to it"
                st.checks_failed += 1
                continue
            st.missing = None
            st.last_ok_mono = time.monotonic()

    # ── what it knows ────────────────────────────────────────────────────────

    def confirmed(self, st: DurableState) -> bool:
        if self.silence_limit_sec <= 0:
            return True
        if st.last_ok_mono is None:
            return False  # never confirmed since start
        return st.unconfirmed_sec() < self.silence_limit_sec

    def reasons(self) -> list[str]:
        """Why this consumer is not ready. Empty means it is."""
        out: list[str] = []
        for st in self.states.values():
            if not self.confirmed(st):
                out.append(
                    f"{self.label}: durable {EVENTS_STREAM}/{st.durable} unconfirmed for "
                    f"{st.unconfirmed_sec()}s (limit {self.silence_limit_sec}s): "
                    f"{st.missing or 'never confirmed since startup'}"
                )
            if st.pending > self.lag_warn:
                out.append(
                    f"{self.label}: durable {st.durable} lag {st.pending} > {self.lag_warn}"
                )
        return out

    def snapshot(self) -> dict:
        return {
            st.durable: {
                "pending": st.pending,
                "ack_pending": st.ack_pending,
                "redelivered": st.redelivered,
                "delivered": st.delivered,
                "push_bound": st.push_bound,
                "unconfirmed_sec": st.unconfirmed_sec(),
                "confirmed": self.confirmed(st),
                "missing": st.missing,
                "checks_failed": st.checks_failed,
            }
            for st in self.states.values()
        }

    def prometheus(self, prefix: str = "workflow_") -> str:
        """Per-durable series, so a healthy feed cannot hide a wedged one."""
        lines: list[str] = []
        for st in self.states.values():
            lbl = f'{{consumer="{self.label}",durable="{st.durable}"}}'
            lines.append(f"{prefix}consumer_pending{lbl} {st.pending}")
            lines.append(f"{prefix}consumer_ack_pending{lbl} {st.ack_pending}")
            lines.append(f"{prefix}consumer_redelivered{lbl} {st.redelivered}")
            lines.append(f"{prefix}consumer_delivered_total{lbl} {st.delivered}")
            lines.append(f"{prefix}consumer_bound{lbl} {int(st.push_bound)}")
            lines.append(f"{prefix}consumer_confirmed{lbl} {int(self.confirmed(st))}")
            lines.append(f"{prefix}consumer_unconfirmed_sec{lbl} {st.unconfirmed_sec()}")
            lines.append(f"{prefix}consumer_checks_failed_total{lbl} {st.checks_failed}")
        return "\n".join(lines) + ("\n" if lines else "")


HELP = [
    ("consumer_pending", "gauge",
     "JetStream messages matched but not yet delivered to this durable. THE lag. "
     "0 means caught up OR not consuming at all — read it with consumer_bound."),
    ("consumer_ack_pending", "gauge",
     "Delivered to the handler and not yet acked. A number that only grows is a "
     "handler that never returns."),
    ("consumer_redelivered", "gauge",
     "Messages being redelivered because the handler raised. Non-zero means work "
     "is arriving and failing, which reads identically to idle on every other gauge."),
    ("consumer_delivered_total", "counter",
     "Consumer sequence. The only monotonic proof that messages moved."),
    ("consumer_bound", "gauge",
     "1 when the SERVER has an active push binding for this durable. 0 while we "
     "believe we are subscribed is the wedge a push consumer cannot otherwise see: "
     "no exception is raised and no callback fires, so it is indistinguishable "
     "from a quiet hour on every other number here."),
    ("consumer_confirmed", "gauge",
     "1 while the durable has been confirmed present AND bound within the silence "
     "limit. NOT a traffic gauge — an idle estate reads 1."),
    ("consumer_unconfirmed_sec", "gauge",
     "Seconds since the last successful confirmation."),
    ("consumer_checks_failed_total", "counter",
     "consumer_info calls that found the durable absent, unbound, or unreachable."),
]


def help_block(prefix: str = "workflow_") -> str:
    """HELP/TYPE lines for the series above, emitted once for the whole family."""
    out: list[str] = []
    for name, typ, help_ in HELP:
        out.append(f"# HELP {prefix}{name} {help_}")
        out.append(f"# TYPE {prefix}{name} {typ}")
    return "\n".join(out) + "\n"
