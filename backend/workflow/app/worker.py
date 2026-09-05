"""Celery worker + beat schedule for the workflow service.

A Celery app on the shared Redis broker (VE_REDIS_URL) that drives the workflow
engine's scheduled + async work. Each Celery task below wraps one async body via
``asyncio.run``; the bodies live in the ``jobs`` module of the feature that OWNS
the work, not in a shared task module. Three imports instead of one is the point:
it says on the import line which part of the domain each sweep belongs to.

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

from app.workflow.correlation import jobs as correlation_jobs
from app.workflow.instances import jobs as instance_jobs
from app.workflow.notifications import jobs as notification_jobs

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
