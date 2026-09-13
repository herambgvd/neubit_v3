"""The body of an SSE relay: the loop the four `realtime_*` bridges all run.

`realtime_vms`, `realtime_wall`, `realtime_access` and `realtime_incidents` differ
in what they subscribe to and what a frame looks like; from the queue outwards they
are the same stream, and that sameness is load-bearing rather than incidental. Every
one of them must:

  * stop when the CLIENT goes away, or the subscription outlives its reader;
  * stop when the PROCESS is going down (see `shutdown.next_sse_frame`), or one open
    dashboard wedges the shutdown;
  * and stop when the GUARD refuses, because the 200 went out at connect and ending
    the body is the only refusal left. A relay that skips this keeps pushing live
    door, camera, wall and alarm traffic to a revoked session, a narrowed role, a
    suspended tenant or an expired licence until the token expires — hours.

Four copies of that meant four places to fix and three to forget. It was previously
pinned by a test that grepped each relay for the guard call, which is why the copies
survived: the check could not tell "shares the loop" from "skipped the loop". It is
now `test_a_relay_ends_the_stream_once_the_guard_refuses`, which opens each stream
with a guard that refuses and asserts the body ends — true of a shared loop and
false of a relay that drops it.

The caller keeps the subscription: it opens one, wraps this loop in its own
`try/finally`, and tears the subscription down there. This owns only the frames.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator, Protocol

from .shutdown import SSE_SHUTDOWN_FRAME, next_sse_frame


class Guard(Protocol):
    """What this loop needs of `sse_auth.StreamGuard` — the one question it asks."""

    async def still_allowed(self) -> bool: ...


async def stream_sse_frames(
    request: Any,
    guard: Guard,
    queue: "asyncio.Queue[tuple[str, dict]]",
    keepalive: float,
) -> AsyncIterator[str]:
    """Yield the SSE body for an open relay: queued frames, keepalives, and the end.

    Queue items are `(event_name, payload)` — the name is per-frame rather than
    per-stream because the VMS relay emits events and popups down the same pipe.
    """
    while True:
        if await request.is_disconnected():
            break
        kind, item = await next_sse_frame(queue, keepalive)
        if kind == "shutdown":
            # Going down: end the response instead of looping, or the
            # open stream wedges the shutdown. EventSource reconnects.
            yield SSE_SHUTDOWN_FRAME
            break
        if kind == "keepalive":
            if not await guard.still_allowed():
                # The 200 went out when the stream opened, so ending the
                # body is the only way left to refuse. EventSource
                # reconnects and gets a clean 401/403 then.
                yield "event: revoked\ndata: {}\n\n"
                break
            yield ": keepalive\n\n"
            continue
        name, data = item
        yield f"event: {name}\ndata: {json.dumps(data)}\n\n"
