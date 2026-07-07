"""Celery worker + beat schedule for the workflow service.

A Celery app on the shared Redis broker (VE_REDIS_URL) that drives the workflow
engine's scheduled + async work. The async task bodies live in
``app.workflow.tasks``; each Celery task wraps one via ``asyncio.run``.

Tasks:
  * ``escalation_sweep``       — SLA breach + state-timeout + SOP-rule escalations.
  * ``timeout_sweep``          — auto-cancel stale instances.
  * ``dispatch_notifications`` — drain the notification outbox via connectors.
  * ``run_correlation_consumer`` — the NATS→incident engine (long-running; start it
    once, e.g. ``celery -A app.worker call app.worker.run_correlation_consumer``,
    or run it as a dedicated process alongside the worker).

Beat schedule runs the three sweeps periodically. The correlation consumer is a
blocking long-runner and is NOT on the beat schedule (it would never return).

Run the worker:  celery -A app.worker.celery_app worker --loglevel=info
Run beat:        celery -A app.worker.celery_app beat --loglevel=info
"""

from __future__ import annotations

import asyncio
import logging

from celery import Celery
from celery.schedules import crontab

from kernel.config import get_settings

from app.workflow import tasks as wf_tasks

log = logging.getLogger("workflow.worker")

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


# --- tasks -----------------------------------------------------------------


@celery_app.task(name="app.worker.escalation_sweep")
def escalation_sweep() -> int:
    """SLA breach + state-timeout + SOP escalation-rule sweep."""
    return asyncio.run(wf_tasks.escalation_sweep())


@celery_app.task(name="app.worker.timeout_sweep")
def timeout_sweep() -> int:
    """Auto-cancel instances idle past the global timeout."""
    return asyncio.run(wf_tasks.timeout_sweep())


@celery_app.task(name="app.worker.dispatch_notifications")
def dispatch_notifications() -> int:
    """Drain the notification outbox through the connector registry."""
    return asyncio.run(wf_tasks.dispatch_notifications())


@celery_app.task(name="app.worker.dedup_cleanup")
def dedup_cleanup() -> int:
    """Delete expired correlation-dedup slots."""
    return asyncio.run(wf_tasks.dedup_cleanup())


@celery_app.task(name="app.worker.run_correlation_consumer")
def run_correlation_consumer() -> str:
    """Long-running NATS→incident consumer. Blocks; run as a dedicated worker."""
    asyncio.run(wf_tasks.run_correlation_consumer())
    return "stopped"


@celery_app.task(name="app.worker.ping")
def ping() -> str:
    """Sample on-demand task — proves the worker executes queued jobs."""
    return "pong"
