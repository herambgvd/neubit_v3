"""Tasks: the Celery app + a ``@task`` decorator + a sync DB session for workers.

Enqueue background work from anywhere:

    from app.reports.service import run_report_task
    run_report_task.delay(str(job.id), rows, columns)

Define a task:

    from app.tasks import task

    @task
    def do_expensive_thing(): ...

Run a worker:  celery -A app.tasks.app.celery_app worker -l info

NOT for periodic housekeeping — that is ``app/retention.py``, which runs in the
API process's lifespan. See the note in ``app/tasks/app.py``.
"""

from .app import celery_app
from .base import get_sync_session, task

__all__ = ["celery_app", "task", "get_sync_session"]
