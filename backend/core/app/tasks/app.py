"""The Celery application — the optional worker path for large report exports.

``reports.service.run_report_task`` is the only task core defines. It is wired but
optional: the default export path is inline and async (``generate_report_now``),
and no core worker runs in the shipped deployment.

Broker AND result backend are both Redis (``settings.redis_url``) — one dependency
for both "here is a job" (broker) and "here is its result/status" (backend).

Run a worker:      celery -A app.tasks.app.celery_app worker -l info

THERE IS NO BEAT SCHEDULE, and adding one here would be a mistake. Core's periodic
housekeeping lives in ``app/retention.py`` and runs in the API process's lifespan;
this app has no worker consuming it, and core's broker is the SAME Redis database
and the SAME default queue as the workflow service's, so a task enqueued here is
picked up by ``workflow-worker``. The previous schedule pointed at an ``edge``
package that has never existed in this repo, which is how nobody noticed that none
of it ran.
"""

from __future__ import annotations

from celery import Celery

from ..core.config import get_settings

_settings = get_settings()

celery_app = Celery(
    "core",
    broker=_settings.redis_url,
    backend=_settings.redis_url,
    # Imported at worker startup so the @task function registers. The module path
    # is real — the previous value named `edge.reports.service`, and a worker
    # started against it died at finalization with ModuleNotFoundError.
    include=["app.reports.service"],
)

# JSON everywhere: human-inspectable payloads and no pickle security surface.
# UTC timestamps so schedules are unambiguous across deployment timezones.
celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
)
