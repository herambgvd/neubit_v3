"""Celery worker + beat schedule for the workflow service.

A Celery app on the shared Redis broker that drives the engine's scheduled and
async work. Each task wraps one async body via ``asyncio.run``; the bodies live in
the ``jobs`` module of the feature that owns the work, not in a shared module.

Tasks:
  * ``escalation_sweep``       — SLA breach + state-timeout + SOP-rule escalations.
  * ``timeout_sweep``          — auto-cancel stale instances.
  * ``dispatch_notifications`` — drain the notification outbox via connectors.
  * ``run_correlation_consumer`` — the NATS→incident engine (long-running; start it
    once, e.g. ``celery -A app.worker call app.worker.run_correlation_consumer``,
    or run it as a dedicated process alongside the worker).

Beat schedule runs the three sweeps periodically. The correlation consumer is a
blocking long-runner and is NOT on the beat schedule (it would never return).

HEALTH. A wedged Celery worker has no outward symptom, and ``celery inspect ping``
answers pong through it (that is the control consumer on a broadcast queue, not
the task queue). So both processes run a small stdlib probe server on :8000 and
stamp a heartbeat from a Celery signal:

  * the WORKER stamps ``task_postrun`` — a task ran to completion. Beat publishes
    two sweeps a minute forever, so this stays green on an estate with no
    incidents at all.
  * BEAT stamps ``before_task_publish`` — a task was sent. Together they name the
    right container: beat fresh + worker silent is a wedged worker; both silent is
    a dead beat or a dead broker.

See app/probes.py and app/workflow/runtime/heartbeat.py for the windows.

LOGGING. Both processes configure ``kernel.logging`` at import and then claim
Celery's ``setup_logging`` signal, so Celery cannot hijack the root logger. As a
result ``--loglevel`` on the command line is inert; verbosity is ``VE_LOG_LEVEL``.

Run the worker:  celery -A app.worker.celery_app worker
Run beat:        celery -A app.worker.celery_app beat
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys

from celery import Celery
from celery.schedules import crontab
from celery.signals import (
    beat_init,
    before_task_publish,
    setup_logging,
    task_postrun,
    worker_ready,
)

from kernel.config import get_settings
from kernel.logging import configure as configure_logging

from app.probes import ProcessProbeServer
from app.workflow.correlation import jobs as correlation_jobs
from app.workflow.instances import jobs as instance_jobs
from app.workflow.notifications import jobs as notification_jobs
from app.workflow.runtime import heartbeat

log = logging.getLogger("workflow.worker")


def _argv_role() -> str:
    """worker | beat, read off the command line.

    No Celery signal fires early enough. The pool forks its children during worker
    startup and a child keeps the handlers its parent held at the fork, so
    configuring logging from ``worker_ready`` would reconfigure MainProcess only
    and every task line would keep Celery's format. The command line is the
    earliest thing that knows.
    """
    return "beat" if "beat" in sys.argv else "worker"


# Configure at import, before Celery boots anything, so the pool's children fork
# from a process that already has the right root handler.
configure_logging("workflow", _argv_role())


@setup_logging.connect
def _keep_our_logging(**_kw) -> None:
    """Claim Celery's logging setup and do nothing with it.

    Connecting to ``setup_logging`` is Celery's documented way of saying "I
    configure logging myself". The empty body is the point: configuration already
    happened at import, and this stops Celery undoing it.
    """

PROBE_PORT = int(os.getenv("VE_WORKFLOW_PROBE_PORT", "8000"))

settings = get_settings()

celery_app = Celery(
    "workflow",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["app.worker"],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
)

# --- beat schedule ---------------------------------------------------------
celery_app.conf.beat_schedule = {
    "workflow-escalation-sweep": {
        "task": "app.worker.escalation_sweep",
        "schedule": crontab(minute="*"),  # every minute
    },
    "workflow-timeout-sweep": {
        "task": "app.worker.timeout_sweep",
        "schedule": crontab(minute="*/5"),  # every 5 minutes
    },
    "workflow-dispatch-notifications": {
        "task": "app.worker.dispatch_notifications",
        "schedule": crontab(minute="*"),  # every minute
    },
    "workflow-dedup-cleanup": {
        "task": "app.worker.dedup_cleanup",
        "schedule": crontab(minute="*/10"),  # every 10 minutes
    },
}


# --- health signals --------------------------------------------------------
#
# One module, two processes: `celery worker` fires worker_ready/task_postrun and
# `celery beat` fires beat_init/before_task_publish, so each arms only its own half.

_probe: ProcessProbeServer | None = None
_role: str | None = None


def _arm(role: str, silence: float) -> None:
    """Start this process's probe server and reset its heartbeat. MainProcess only."""
    global _probe, _role
    if _probe is not None:
        return
    try:
        _role = role
        heartbeat.arm(role)
        _probe = ProcessProbeServer(role, port=PROBE_PORT, silence_limit=silence)
        _probe.start()
    except Exception as e:  # noqa: BLE001
        # A probe that cannot start must not stop the worker working. It fails
        # loudly and stays absent, which the container healthcheck reports.
        log.exception("probe server failed to start for role=%s: %s", role, e)


@worker_ready.connect
def _worker_ready(**_kw) -> None:
    _arm("worker", heartbeat.WORKER_SILENCE_SEC)


@beat_init.connect
def _beat_ready(**_kw) -> None:
    _arm("beat", heartbeat.BEAT_SILENCE_SEC)


@task_postrun.connect
def _note_task(task=None, state=None, **_kw) -> None:
    """A task ran to completion. The worker liveness signal.

    Fires in a forked child under the prefork pool, which is why the counters live
    in Redis. The role is spelled literally for the same reason: `_role` is set in
    the parent after the fork, so a child would read None.

    task_postrun, not task_success: a failed task still proves broker reachable,
    queue consumed, pool alive, body executed. Counting only successes would make a
    dead SMTP server look like a dead worker. Failures are counted separately.
    """
    name = getattr(task, "name", "?")
    heartbeat.note("worker", name, failed=(state == "FAILURE"))


@before_task_publish.connect
def _note_publish(sender=None, **_kw) -> None:
    """A task was sent. Beat's liveness signal.

    Guarded on the role because this signal fires in any process that calls
    `.delay()`, and a worker chaining a task must not make a dead beat look alive.
    """
    if _role != "beat":
        return
    heartbeat.note("beat", str(sender))


# --- tasks -----------------------------------------------------------------


@celery_app.task(name="app.worker.escalation_sweep")
def escalation_sweep() -> int:
    """SLA breach + state-timeout + SOP escalation-rule sweep."""
    return asyncio.run(instance_jobs.escalation_sweep())


@celery_app.task(name="app.worker.timeout_sweep")
def timeout_sweep() -> int:
    """Auto-cancel instances idle past the global timeout."""
    return asyncio.run(instance_jobs.timeout_sweep())


@celery_app.task(name="app.worker.dispatch_notifications")
def dispatch_notifications() -> int:
    """Drain the notification outbox through the connector registry."""
    return asyncio.run(notification_jobs.dispatch_notifications())


@celery_app.task(name="app.worker.dedup_cleanup")
def dedup_cleanup() -> int:
    """Delete expired correlation-dedup slots."""
    return asyncio.run(correlation_jobs.dedup_cleanup())


@celery_app.task(name="app.worker.run_correlation_consumer")
def run_correlation_consumer() -> str:
    """Long-running NATS→incident consumer. Blocks; run as a dedicated worker."""
    asyncio.run(correlation_jobs.run_correlation_consumer())
    return "stopped"


@celery_app.task(name="app.worker.run_notify_consumer")
def run_notify_consumer() -> str:
    """Long-running NATS notify.request/vms.popup → outbox consumer. Blocks."""
    asyncio.run(notification_jobs.run_notify_consumer())
    return "stopped"


@celery_app.task(name="app.worker.ping")
def ping() -> str:
    """Sample on-demand task — proves the worker executes queued jobs."""
    return "pong"
