"""Stopping a NATS consumer, once.

Five consumers in this service start a task, hold a connection and have to put
both down cleanly. Three of them wrote the same eleven lines to do it and two
wrote a multi-task variant of the same eleven — which is the usual cost of
copying, plus one that matters here: the BOUNDED drain. An unbounded
``nc.drain()`` on a pull consumer waits for nothing to flush and can only make a
shutdown hang, and that reasoning lived in a comment in exactly one of the copies.

Errors are suppressed on purpose and only here. A shutdown path that raises turns
"the service is stopping" into "the service crashed while stopping", and a
container that fails to exit cleanly gets SIGKILLed a few seconds later with
whatever it was doing half-done.
"""

from __future__ import annotations

import asyncio
import contextlib

#: A drain that cannot outlast a container's grace period. Pull consumers have
#: nothing buffered to flush, so waiting longer buys nothing and risks the kill.
DRAIN_TIMEOUT = 2.0


async def stop_tasks(*tasks) -> None:
    """Cancel each task and wait for it to finish, ignoring how it ended.

    Cancelled is the expected ending; anything else already logged itself on the
    way out. Both are equally "stopped", which is the only thing the caller needs.
    """
    live = [t for t in tasks if t is not None]
    for t in live:
        t.cancel()
    for t in live:
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await t


async def close_nats(nc) -> None:
    """Drain with a bound, then close. Safe to call on None, or twice."""
    if nc is None:
        return
    with contextlib.suppress(Exception):
        await asyncio.wait_for(nc.drain(), timeout=DRAIN_TIMEOUT)
    with contextlib.suppress(Exception):
        await nc.close()
