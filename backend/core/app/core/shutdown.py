"""A process-wide "we are going down" signal, and why an SSE relay needs one.

uvicorn's shutdown waits for connections to close before running the lifespan's
shutdown half. An SSE relay is a `StreamingResponse` over a generator that loops
until the CLIENT goes away, so a single open dashboard wedges the process forever
— and `timeout_graceful_shutdown` defaults to None, so there is no backstop.

Two halves, both needed:

  * The relays cooperate (this module): they wait on their queue OR this event, and
    on the event they emit a final `: server shutting down` comment and return.
    Nothing is cancelled mid-frame.
  * uvicorn gets `--timeout-graceful-shutdown` in the compose command (base AND dev
    override — production `docker compose restart core` hangs the same way). That
    covers what this event cannot: a WebSocket parked on `receive_text()`, a slow
    query, a future relay that forgets to check.

The timeout alone would make every reload cost the full timeout and cut live
streams mid-flight; cooperation alone leaves any other long-lived connection able
to wedge the process.

No client change is needed: ending an SSE response is the protocol's own reconnect
signal, so `EventSource` treats it as a brief network blip.

A signal handler rather than the lifespan, because `lifespan.shutdown()` runs AFTER
the wait for connections — in the hanging case it never runs at all. uvicorn's own
handlers are CHAINED, not replaced, so its exit path is unchanged; if chaining
fails it fails to a no-op and the compose timeout still bounds the shutdown.
"""

from __future__ import annotations

import asyncio
import signal
import threading
from typing import Any

from .logging import get_logger

log = get_logger("edge.shutdown")

# Set once, when the process is asked to exit. Never cleared — a relay that woke on
# it must not be talked back into looping.
shutting_down = asyncio.Event()

# The SSE frame a relay sends on the way out. A comment, not an `event:`: it is for
# the protocol, not the application. Named here so the four relays do not drift.
SSE_SHUTDOWN_FRAME = ": server shutting down\n\n"

_installed = False


def install_signal_handlers() -> None:
    """Chain `shutting_down.set()` onto whatever handles SIGTERM / SIGINT.

    Call from the lifespan's startup half. Idempotent, and a no-op off the main
    thread or on a platform without these signals — the compose-level graceful
    timeout is still the backstop, so failing quietly degrades rather than breaks.
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
            # `call_soon_threadsafe`, not a direct `set()`: a signal handler runs
            # between bytecodes, which is not a safe place to walk a callback list.
            try:
                loop.call_soon_threadsafe(shutting_down.set)
            except RuntimeError:  # pragma: no cover — loop already closed
                pass
            # uvicorn's own handler, unchanged. Dropping it would leave the process
            # noting the signal and then refusing to act on it.
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
        ("shutdown",  None)   — the process is going down; end the response now

    Here so all four relays wait the same way: one that only waited on its queue
    would sleep through the shutdown and hold the process open.
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
            # Checked first so a frame that arrived in the same tick as the signal
            # is still delivered rather than dropped.
            return ("frame", get.result())
        if stop in done:
            return ("shutdown", None)
        return ("keepalive", None)
    finally:
        # Cancel whichever did not win: a pending `queue.get()` stays registered as
        # a getter on a queue nobody reads again.
        for task in (get, stop):
            if not task.done():
                task.cancel()
