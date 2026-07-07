"""Celery worker + beat schedule stub for the workflow service.

Bootable but minimal: a Celery app pointed at the shared Redis broker
(VE_REDIS_URL), one sample task, and a beat schedule with one periodic entry.
Real SOP/automation tasks are added here later.

Run the worker:  celery -A app.worker.celery_app worker --loglevel=info
Run beat:        celery -A app.worker.celery_app beat --loglevel=info
"""

from __future__ import annotations

import logging

from celery import Celery
from celery.schedules import crontab

from kernel.config import get_settings

log = logging.getLogger("workflow.worker")

settings = get_settings()

celery_app = Celery(
    "workflow",
    broker=settings.redis_url,
    backend=settings.redis_url,
)

# Sensible defaults; tune per deployment.
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
)

# --- beat schedule stub ----------------------------------------------------
# One periodic entry so `celery beat` boots with a valid schedule. Replace/extend
# with the real SOP timers (escalations, retries, digests) as they are ported.
celery_app.conf.beat_schedule = {
    "workflow-heartbeat": {
        "task": "app.worker.heartbeat",
        "schedule": crontab(minute="*/5"),  # every 5 minutes
    },
}


@celery_app.task(name="app.worker.heartbeat")
def heartbeat() -> str:
    """Sample periodic task — proves worker + beat are wired. No-op payload."""
    log.info("workflow heartbeat")
    return "ok"


@celery_app.task(name="app.worker.ping")
def ping() -> str:
    """Sample on-demand task — proves the worker executes queued jobs."""
    return "pong"
