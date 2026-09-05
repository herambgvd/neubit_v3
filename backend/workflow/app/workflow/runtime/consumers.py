"""Whether the JetStream durables this service binds are still consuming.

Both long-lived consumers here — ``correlation.engine.CorrelationEngine`` and
``notifications.consumer.NotifyConsumer`` — are PUSH subscriptions: they hand
``kernel.events.EventBus.subscribe`` a callback and never poll. That shape has a
blind spot with no local symptom whatsoever:

    A push subscription that has stopped receiving looks EXACTLY like a quiet
    hour. No exception is raised, no callback fires, no counter moves, and
    ``EventBus.is_connected()`` keeps returning True because it only asks whether
    an object is non-None.

Three real states live in that gap, and this platform has met the shape before —
see backend/reading-writer/app/metrics.py, where a pull loop's own liveness flag
sat green through a ten-minute wedge because nats-py folds the server's 409
CONFLICT in with NO_MESSAGES and re-raises both as ``TimeoutError``. The push side
is worse, not better: there is no fetch call to raise anything at all.

  * the durable was deleted or replaced out of band. The stream keeps matching
    messages against a consumer that no longer exists, the client keeps a healthy
    TCP session, and nothing on this side notices;
  * the client's subscription is gone (a failed resubscribe after a reconnect,
    a cancelled task) while the durable still exists on the server, so messages
    pile up server-side addressed to nobody;
  * the handler is failing and every message is being redelivered — work is
    arriving and none of it is finishing.

So this asks the SERVER, out of band, on its own timer. Two answers matter and
they are deliberately separate numbers:

  ``num_pending``  the LAG: matched messages the server has not delivered. This
                   is the one that says "behind", and it is 0 both for a consumer
                   that is perfectly caught up and for one that is not consuming
                   at all — which is precisely why it cannot stand alone.
  ``push_bound``   whether the server currently has an ACTIVE delivery binding
                   for this durable. This is the push-side analogue of the
                   reading-writer's second proof: it answers the question a
                   silent callback cannot, namely "is anyone actually attached".
                   False while we believe we are subscribed IS the wedge.

NOT A TRAFFIC GAUGE. A correct, idle, fully-attached consumer reports
``num_pending=0`` and ``push_bound=True`` through an entirely eventless night and
this module says it is fine. The thing that goes red is absence of the BINDING or
of the durable, never absence of events — a probe that reds on a quiet estate is
a probe somebody switches off within the week.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field

from kernel.events import EVENTS_STREAM, EventBus

log = logging.getLogger("workflow.runtime.consumers")

# How often to ask the server. 10s is far below every silence limit that reads
# these numbers, so a single failed call during a NATS blip can never be the
# thing that reds the service — only a sustained streak can.
POLL_INTERVAL_SEC = 10.0


@dataclass
class DurableState:
    """What the last successful ``consumer_info`` said about one durable."""

    durable: str
    pending: int = 0            # THE lag
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

    One instance per logical consumer (the correlation engine has five durables,
    the notify consumer two) so a reader is told WHICH consumer is wedged and not
    merely that something is. ``label`` prefixes every reason string and every
    metric label for exactly that reason.
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
            # Poll once inline first so a scrape that arrives in the second after
            # startup reports real numbers rather than a service that looks
            # unconfirmed because nothing has asked yet.
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
                # This task watches the consumers; it must not be the thing that
                # dies. A watchdog that can crash leaves the wedge it was there
                # to find completely invisible, which is worse than no watchdog.
                log.warning("consumer watch %s: poll loop error: %s", self.label, e)

    # ── the poll ─────────────────────────────────────────────────────────────

    async def poll_once(self) -> None:
        # kernel's EventBus exposes only `is_connected()`, so the JetStream
        # context is read off the private attribute. Deliberately a getattr with a
        # fallback rather than a kernel change: adding a public accessor edits a
        # module five services import, and this is one attribute read that must
        # degrade to "unknown" rather than raise if kernel's internals move.
        js = getattr(self.bus, "_js", None)
        for durable, st in self.states.items():
            if js is None:
                st.missing = "NATS not connected"
                st.checks_failed += 1
                continue
            try:
                info = await js.consumer_info(EVENTS_STREAM, durable)
            except Exception as e:  # noqa: BLE001 — absent, renamed, or NATS down
                # The timestamp is deliberately NOT cleared: one failed API call
                # during a blip must not red the service, and letting the clock
                # run is what makes the silence limit apply to this proof too.
                #
                # `push_bound` IS cleared, and that split is the point. It is the
                # RAW last answer — we could not ask, so we may not keep claiming
                # 1; a gauge that holds its last good value through an outage is
                # the exact trap the reading-writer's `consumer_pending` fell into
                # ("read from a consumer that is no longer there, keeps whatever
                # value it last had"). `confirmed` is the DEBOUNCED verdict and is
                # the one with the silence limit, so a blip moves the raw gauge
                # for one poll and moves nothing else.
                st.push_bound = False
                st.missing = f"{type(e).__name__}: {e}"[:200]
                st.checks_failed += 1
                continue
            st.pending = int(getattr(info, "num_pending", 0) or 0)
            st.ack_pending = int(getattr(info, "num_ack_pending", 0) or 0)
            st.redelivered = int(getattr(info, "num_redelivered", 0) or 0)
            st.delivered = int(getattr(getattr(info, "delivered", None), "consumer_seq", 0) or 0)
            bound = getattr(info, "push_bound", None)
            # `push_bound` is None on a pull consumer and on older servers. Treat
            # None as bound: this must never invent a wedge on a deployment whose
            # server does not report the field, because a probe that cries wolf
            # gets muted and then the real wedge is invisible too.
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
            return False  # never once confirmed since start
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
        """Per-durable series, so a healthy access feed cannot hide a wedged one."""
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
