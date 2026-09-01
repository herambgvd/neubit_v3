"""A process-wide "we are going down" signal, and why an SSE relay needs one.

THE FAILURE THIS EXISTS TO FIX
------------------------------
Every edit under `backend/core/app` used to hang the dev container. uvicorn
logged

    WatchFiles detected changes in 'app/…'. Reloading...
    Shutting down
    Waiting for connections to close. (CTRL+C to force quit)

and never finished. Core then answered NOTHING — not `/auth/login`, not
`/health` — until somebody ran `docker compose restart core`. A reload that
cannot complete is worse than no reload: it turns every edit into an outage.

The cause is in uvicorn's own shutdown, and it is not a bug in uvicorn:

    for connection in list(self.server_state.connections):
        connection.shutdown()          # h11: an in-flight response is left alone
    await asyncio.wait_for(self._wait_tasks_to_complete(),
                           timeout=self.config.timeout_graceful_shutdown)
    if not self.force_exit:
        await self.lifespan.shutdown()

Two things follow from those eight lines, and together they are the whole story:

1. **`connection.shutdown()` tells the APPLICATION nothing.** For a connection
   with a response already in flight, uvicorn's h11 implementation only marks the
   connection non-keep-alive. Our `/api/v1/realtime/…` relays are exactly that: a
   `StreamingResponse` over an async generator that loops forever, emitting a
   keepalive comment every 20 seconds and breaking only when the CLIENT goes
   away. Nobody goes away, so the generator never returns, so the connection
   never closes, so `_wait_tasks_to_complete()` never completes. A browser with a
   dashboard open is enough to wedge the process indefinitely.

2. **`timeout_graceful_shutdown` defaults to `None`**, which `asyncio.wait_for`
   reads as "wait forever". So there is no backstop either.

WHAT WAS CHOSEN, AND WHY BOTH HALVES
------------------------------------
**The relays cooperate** (this module). They now wait on the queue OR on this
event, and when it is set they emit a final `: server shutting down` comment and
RETURN. The generator ends, the `finally` unsubscribes from NATS, the connection
closes, and uvicorn's wait completes in milliseconds. Nothing is forced and
nothing is cancelled mid-frame.

**uvicorn also gets `--timeout-graceful-shutdown`** (in the compose command, both
the base and the dev override — the hang is not a dev-only property; a production
`docker compose restart core` hangs the same way, it is just noticed less). That
covers what this event cannot: a WebSocket parked on `receive_text()`, a request
wedged on a slow query, or a future relay that forgets to check. A bounded
timeout is what guarantees the worker ALWAYS dies; cooperation is what makes the
common case fast and clean instead of a cancelled task and an error log.

Neither half alone is enough. The timeout alone would make every edit cost the
full timeout and cancel live streams mid-flight; cooperation alone would leave
any other long-lived connection able to wedge the process again.

NO CLIENT CHANGE IS NEEDED
--------------------------
Ending an SSE response is the protocol's own reconnect signal: `EventSource`
reconnects on its own after its retry interval. A relay that closes on shutdown
is therefore indistinguishable, from the browser's side, from a brief network
blip — which is what a reload is.

WHY A SIGNAL HANDLER AND NOT THE LIFESPAN
-----------------------------------------
Because of the ORDER in the code quoted above: `lifespan.shutdown()` runs AFTER
the wait for connections. Setting this event in the lifespan's shutdown half
would be code that, in the hanging case, never runs at all — the deadlock happens
strictly before it. The signal is the only thing that arrives early enough.

uvicorn installs its own SIGTERM/SIGINT handlers (`Server.capture_signals`, which
runs before the lifespan starts, so ours is installed second and wins). We do not
replace them, we CHAIN them: this event is set, then uvicorn's handler is invoked
unchanged, so uvicorn's exit path is exactly what it was. If anything about that
fails, it fails to a no-op and the compose timeout still bounds the shutdown.
"""

from __future__ import annotations

import asyncio
import signal
import threading
from typing import Any

from .logging import get_logger

log = get_logger("edge.shutdown")

# Set once, when the process is asked to exit. Never cleared: a process that has
# begun shutting down does not un-begin, and a relay that woke on it must not be
# talked back into looping.
shutting_down = asyncio.Event()

# The SSE frame a relay sends on the way out. A comment, not an `event:`, because
# it is addressed to the protocol rather than to the application: EventSource
# ignores comments and reconnects when the stream ends, which is precisely the
# behaviour wanted. Naming it here keeps the four relays from drifting.
SSE_SHUTDOWN_FRAME = ": server shutting down\n\n"

_installed = False


def install_signal_handlers() -> None:
    """Chain `shutting_down.set()` onto whatever handles SIGTERM / SIGINT.

    Call from the lifespan's STARTUP half. Idempotent, and a no-op off the main
    thread (where `signal.signal` raises) or on a platform without these signals —
    in every one of those cases the compose-level graceful timeout is still the
    backstop, so failing quietly here degrades rather than breaks.
    """
    global _installed
    if _installed:
        return
    if threading.current_thread() is not threading.main_thread():
        return

    loop = asyncio.get_running_loop()

    def _chain(sig: signal.Signals) -> None:
        try:
            previous = signal.getsignal(sig)
        except (ValueError, OSError):  # pragma: no cover — platform without it
            return

        def _handler(signum: int, frame: Any) -> None:
            # `call_soon_threadsafe` rather than `shutting_down.set()` directly:
            # a signal handler runs between bytecodes on the main thread, which is
            # not a safe place to walk a future's callback list.
            try:
                loop.call_soon_threadsafe(shutting_down.set)
            except RuntimeError:  # pragma: no cover — loop already closed
                pass
            # uvicorn's own handler, unchanged. Dropping it would mean the process
            # noted the signal and then refused to act on it.
            if callable(previous):
                previous(signum, frame)

        try:
            signal.signal(sig, _handler)
        except (ValueError, OSError):  # pragma: no cover
            return

    for sig in (signal.SIGTERM, signal.SIGINT):
        _chain(sig)
    _installed = True
    log.debug("shutdown signal handlers chained (SIGTERM, SIGINT)")


async def next_sse_frame(queue: "asyncio.Queue[Any]", keepalive: float) -> tuple[str, Any]:
    """Wait for the next thing an SSE relay should do.

    Returns one of:

        ("frame",     item)   — something to send, taken off the relay's queue
        ("keepalive", None)   — `keepalive` seconds passed with nothing to send
        ("shutdown",  None)   — the process is going down; end the response NOW

    The point of doing this in one place is that all four relays wait the same
    way. A relay that only waited on its queue would sleep through the shutdown
    and hold the process open for up to `keepalive` seconds at best, and forever
    in the case that actually happened.
    """
    if shutting_down.is_set():
        return ("shutdown", None)

    get = asyncio.ensure_future(queue.get())
    stop = asyncio.ensure_future(shutting_down.wait())
    try:
        done, _ = await asyncio.wait(
            {get, stop}, timeout=keepalive, return_when=asyncio.FIRST_COMPLETED
        )
        if get in done:
            # Taken off the queue and about to be sent. Checked FIRST so a frame
            # that arrived in the same tick as the signal is still delivered
            # rather than dropped on the floor.
            return ("frame", get.result())
        if stop in done:
            return ("shutdown", None)
        return ("keepalive", None)
    finally:
        # Cancel whichever did not win. A `queue.get()` left pending would stay
        # registered as a getter on a queue nobody reads again.
        for task in (get, stop):
            if not task.done():
                task.cancel()
