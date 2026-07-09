"""Operational reporting domain (P6-B) — uptime/coverage/storage/event reports.

Self-contained domain package (``schemas`` + ``service`` + ``router``) plus the lifespan
background ``ReportScheduler`` that fires recurring reports via the notify path. Mirrors
the storage/export domains' layout:

  * ``GET /vms/reports/{kind}?from=&to=&camera_id=``          → JSON report (gate
    ``vms.playback.view``). Kinds: camera-uptime, recording-coverage, storage-usage,
    event-stats, health-summary.
  * ``GET /vms/reports/{kind}/export?format=csv|pdf&from=&to=`` → a CSV/PDF download.
  * ReportSchedule CRUD ``/vms/report-schedules`` (gate ``vms.config.manage``) → the
    recurring-report catalog the scheduler drains.

The ``ReportScheduler`` (started in ``app.main`` lifespan) each cycle claims due enabled
schedules, computes the report over the cadence's trailing window in that schedule's
tenant scope, renders it (CSV/PDF/JSON), and publishes ``tenant.<id>.notify.request`` for
the workflow/notifier connector to deliver. Own DB session per cycle; graceful.

Report computations are pure ``(session, scope, from, to, camera?) -> dict`` (in
``computations``); rendering is pure ``dict -> bytes`` (in ``render``) — both cheap to test.
"""

from __future__ import annotations

from .router import router
from .scheduler import ReportScheduler

__all__ = ["router", "ReportScheduler"]
