"""How the workflow engine's periodic sweeps are driven.

The table of sweeps is ``app/sweeps.py`` (it names features, which ``runtime``
may not import). ONE table, read by both drivers, so a cadence cannot drift:

  * ``celery`` (default; the Docker stack): Celery beat publishes each sweep on
    its cadence and the worker runs it (``app.worker``).
  * ``inline`` (``VE_WORKFLOW_SCHEDULER=inline``; the native Windows appliance):
    the API process runs them itself, the way core, ingest and access already run
    their sweeps. That appliance has no Redis (no first-party Windows build) and
    Celery's prefork pool does not run on Windows; nothing else in the stack calls
    ``.delay()`` on the workflow app, so the beat schedule is all Celery was for.

Every sweep is idempotent and claims its rows with SKIP LOCKED, so a second
driver running by mistake double-polls rather than double-acts.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable

log = logging.getLogger("workflow.sweeps")


@dataclass(frozen=True)
class Sweep:
    name: str  # the Celery task name's last part, e.g. "escalation_sweep"
    every_min: int
    run: Callable[[], Awaitable[int]]


def scheduler_mode() -> str:
    """``celery`` or ``inline``. Anything else is a configuration error, said aloud."""
    mode = os.getenv("VE_WORKFLOW_SCHEDULER", "celery").strip().lower() or "celery"
    if mode not in ("celery", "inline"):
        raise RuntimeError(f"VE_WORKFLOW_SCHEDULER={mode!r}: use 'celery' or 'inline'")
    return mode


def crontab_minute(every_min: int) -> str:
    """The Celery crontab minute field for a cadence."""
    return "*" if every_min == 1 else f"*/{every_min}"


@dataclass
class SweepState:
    runs: int = 0
    failures: int = 0
    last_started: float | None = None
    last_finished: float | None = None
    last_error: str | None = None
    last_result: int | None = None


@dataclass
class InlineScheduler:
    """Runs each sweep on its cadence inside the API's event loop.

    One loop per sweep, so a slow escalation sweep never delays the outbox. A
    sweep never overlaps itself: the next wait starts when the run ends. A failed
    run is logged and counted, and the loop carries on — a dead SMTP server must
    not stop escalations.
    """

    sweeps: tuple[Sweep, ...] = ()
    # The first run waits this long, so a restart loop cannot hammer the database
    # and the API is serving before the first sweep competes with it.
    first_delay_sec: float = 15.0
    state: dict[str, SweepState] = field(default_factory=dict)
    _tasks: list[asyncio.Task] = field(default_factory=list)
    clock: Callable[[], float] = time.time

    def start(self) -> None:
        for s in self.sweeps:
            self.state.setdefault(s.name, SweepState())
            self._tasks.append(asyncio.create_task(self._loop(s), name=f"sweep:{s.name}"))
        log.info(
            "inline scheduler started: %s",
            ", ".join(f"{s.name}/{s.every_min}m" for s in self.sweeps),
        )

    async def run_once(self, s: Sweep) -> None:
        st = self.state.setdefault(s.name, SweepState())
        st.last_started = self.clock()
        try:
            st.last_result = await s.run()
            st.last_error = None
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — one failed run must not end the loop
            st.failures += 1
            st.last_error = f"{type(e).__name__}: {e}"[:300]
            log.exception("sweep %s failed", s.name)
        finally:
            st.runs += 1
            st.last_finished = self.clock()

    async def _loop(self, s: Sweep) -> None:
        await asyncio.sleep(self.first_delay_sec)
        while True:
            await self.run_once(s)
            await asyncio.sleep(s.every_min * 60)

    async def close(self) -> None:
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._tasks.clear()

    def snapshot(self) -> dict:
        now = self.clock()
        out = {}
        for s in self.sweeps:
            st = self.state.get(s.name, SweepState())
            out[s.name] = {
                "every_min": s.every_min,
                "runs": st.runs,
                "failures": st.failures,
                "last_run_age_sec": (
                    round(now - st.last_finished, 1) if st.last_finished else None
                ),
                "last_error": st.last_error,
            }
        return out

    def prometheus(self) -> str:
        lines = [
            "# HELP workflow_sweep_runs_total Sweeps the inline scheduler has run.",
            "# TYPE workflow_sweep_runs_total counter",
            "# HELP workflow_sweep_failures_total Sweeps that raised.",
            "# TYPE workflow_sweep_failures_total counter",
            "# HELP workflow_sweep_last_run_age_sec Seconds since the sweep last finished.",
            "# TYPE workflow_sweep_last_run_age_sec gauge",
        ]
        now = self.clock()
        for s in self.sweeps:
            st = self.state.get(s.name, SweepState())
            lines.append(f'workflow_sweep_runs_total{{sweep="{s.name}"}} {st.runs}')
            lines.append(f'workflow_sweep_failures_total{{sweep="{s.name}"}} {st.failures}')
            if st.last_finished:
                lines.append(
                    f'workflow_sweep_last_run_age_sec{{sweep="{s.name}"}} '
                    f"{round(now - st.last_finished, 1)}"
                )
        return "\n".join(lines)
