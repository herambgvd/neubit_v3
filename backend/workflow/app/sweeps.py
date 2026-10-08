"""The workflow engine's periodic sweeps and their cadence.

The one table both drivers read: Celery beat (``app.worker``) and the inline
scheduler (``VE_WORKFLOW_SCHEDULER=inline``, ``app.workflow.runtime.scheduler``).
It lives at the app level because it names features, which ``runtime`` may not.
"""

from __future__ import annotations

from app.workflow.correlation import jobs as correlation_jobs
from app.workflow.instances import jobs as instance_jobs
from app.workflow.notifications import jobs as notification_jobs
from app.workflow.runtime.scheduler import Sweep


def sweeps() -> tuple[Sweep, ...]:
    return (
        Sweep("escalation_sweep", 1, instance_jobs.escalation_sweep),
        Sweep("timeout_sweep", 5, instance_jobs.timeout_sweep),
        Sweep("dispatch_notifications", 1, notification_jobs.dispatch_notifications),
        Sweep("dedup_cleanup", 10, correlation_jobs.dedup_cleanup),
    )
