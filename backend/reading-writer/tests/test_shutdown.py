"""Putting a consumer down without taking the service with it.

Five consumers used to write this themselves, and the copies disagreed about one
thing that matters: the DRAIN BOUND. `nc.drain()` with no timeout waits for a
buffer a pull consumer does not have, so on a bad day it hangs until the runtime
loses patience and SIGKILLs a container mid-write.

The suppression is deliberate and is the other thing worth pinning. A shutdown
path that raises turns "stopping" into "crashed while stopping", and the exit code
is what an orchestrator reads.
"""

from __future__ import annotations

import asyncio

import pytest

from app.shutdown import DRAIN_TIMEOUT, close_nats, stop_tasks

pytestmark = pytest.mark.asyncio


async def test_a_running_task_is_cancelled_and_awaited():
    async def forever():
        await asyncio.sleep(3600)

    t = asyncio.create_task(forever())
    await asyncio.sleep(0)
    await stop_tasks(t)
    assert t.done()


async def test_a_task_that_failed_does_not_fail_the_shutdown():
    # It already logged itself on the way out. Re-raising here would make a
    # stopping service look like a crashing one.
    async def boom():
        raise RuntimeError("already reported")

    t = asyncio.create_task(boom())
    await asyncio.sleep(0)
    await stop_tasks(t)


async def test_none_is_accepted_so_stop_works_before_start():
    await stop_tasks(None, None)


async def test_several_tasks_are_all_cancelled_before_any_is_awaited():
    """Cancel everything first, THEN wait.

    Cancelling and awaiting one at a time serialises the shutdown: each consumer
    gets its full teardown while the others keep running, so a service with four
    of them takes four teardowns to stop. On a container with a grace period that
    is the difference between exiting and being killed.

    Recording both events is what makes this detectable — the ORDER is the whole
    claim. Batched: every "cancel" precedes every "done". Serialised: a's done
    lands before b's cancel, and a test that only checked "all three were
    cancelled" would pass against both.
    """
    events: list[str] = []

    async def worker(name):
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            events.append(f"cancel:{name}")
            # A teardown with an await in it — which is what every real consumer
            # has, and what serialising would make the caller wait for in turn.
            await asyncio.sleep(0)
            events.append(f"done:{name}")
            raise

    ts = [asyncio.create_task(worker(n)) for n in ("a", "b", "c")]
    await asyncio.sleep(0)
    await stop_tasks(*ts)

    cancels = [i for i, e in enumerate(events) if e.startswith("cancel:")]
    dones = [i for i, e in enumerate(events) if e.startswith("done:")]
    assert len(cancels) == len(dones) == 3, events
    assert max(cancels) < min(dones), f"shutdown was serialised: {events}"


class _Nats:
    def __init__(self, hang: bool = False):
        self.hang = hang
        self.drained = False
        self.closed = False

    async def drain(self):
        if self.hang:
            await asyncio.sleep(3600)
        self.drained = True

    async def close(self):
        self.closed = True


async def test_a_connection_is_drained_then_closed():
    nc = _Nats()
    await close_nats(nc)
    assert (nc.drained, nc.closed) == (True, True)


async def test_a_drain_that_hangs_does_not_hang_the_shutdown():
    """The whole reason the bound exists.

    The TEST imposes its own deadline rather than measuring elapsed time, because
    without a bound in the code this call never returns — and a test that HANGS on
    failure is worse than no test: CI reports a timeout with no name attached, and
    a developer runs the suite twice before suspecting it.

    Giving up on the drain is not giving up on the connection: it must still close,
    or the socket is left to the garbage collector.
    """
    nc = _Nats(hang=True)
    await asyncio.wait_for(close_nats(nc), timeout=DRAIN_TIMEOUT + 2)
    assert nc.drained is False
    assert nc.closed is True


async def test_no_connection_is_not_an_error():
    await close_nats(None)
