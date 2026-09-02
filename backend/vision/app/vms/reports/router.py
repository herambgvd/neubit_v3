"""Reports router — permission-gated, tenant-scoped (P6-B).

Mounted under the service api_prefix (``/api/v1``) with the ``/vms`` domain prefix:
  * ``GET  /vms/reports/{kind}?from=&to=&camera_id=``          → JSON report.
  * ``GET  /vms/reports/{kind}/export?format=csv|pdf&from=&to=`` → a CSV/PDF download.
  * ReportSchedule CRUD ``/vms/report-schedules`` (+ ``/{id}``).

Report READS gate on ``vms.playback.view`` (a report is part of the playback/browse
surface — the same permission the recording/storage browse uses). Schedule WRITES gate on
``vms.config.manage`` (the config-admin permission). ``*`` wildcard grants either.

Graceful: an unknown ``kind`` → 422; an empty window → 422; PDF when reportlab is absent
→ 503 (CSV/JSON still work). All run in the caller's tenant scope.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Response, status
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission
from kernel.errors import AppError

from app.db import get_db

from .computations import REPORT_KINDS
from .render import PdfUnavailable, to_csv, to_pdf
from .schemas import (
    ReportRunList,
    ReportRunPublic,
    ReportScheduleCreate,
    ReportScheduleList,
    ReportSchedulePublic,
    ReportScheduleUpdate,
)
from .service import ReportService

PERM_VIEW = "vms.playback.view"
PERM_MANAGE = "vms.config.manage"

router = APIRouter(prefix="/vms", tags=["VMS Reports"])


async def get_report_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> ReportService:
    return ReportService(db, scope)


# ── ReportSchedule CRUD (registered BEFORE /reports/{kind} so literals win) ──


@router.get(
    "/report-schedules",
    response_model=ReportScheduleList,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def list_schedules(
    svc: Annotated[ReportService, Depends(get_report_service)],
) -> ReportScheduleList:
    rows = await svc.list_schedules()
    return ReportScheduleList(
        items=[ReportSchedulePublic.from_row(r) for r in rows], total=len(rows)
    )


@router.post(
    "/report-schedules",
    response_model=ReportSchedulePublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_schedule(
    body: ReportScheduleCreate,
    svc: Annotated[ReportService, Depends(get_report_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> ReportSchedulePublic:
    return ReportSchedulePublic.from_row(await svc.create_schedule(body, actor=actor))


@router.get(
    "/report-schedules/{sid}",
    response_model=ReportSchedulePublic,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def get_schedule(
    sid: str,
    svc: Annotated[ReportService, Depends(get_report_service)],
) -> ReportSchedulePublic:
    return ReportSchedulePublic.from_row(await svc.get_schedule(sid))


@router.patch("/report-schedules/{sid}", response_model=ReportSchedulePublic)
async def update_schedule(
    sid: str,
    body: ReportScheduleUpdate,
    svc: Annotated[ReportService, Depends(get_report_service)],
    actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> ReportSchedulePublic:
    return ReportSchedulePublic.from_row(await svc.update_schedule(sid, body, actor=actor))


@router.delete("/report-schedules/{sid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_schedule(
    sid: str,
    svc: Annotated[ReportService, Depends(get_report_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> Response:
    await svc.delete_schedule(sid)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── ReportRun history + download + run-now ───────────────────────────────


@router.get(
    "/report-schedules/{schedule_id}/runs",
    response_model=ReportRunList,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def list_schedule_runs(
    schedule_id: str,
    svc: Annotated[ReportService, Depends(get_report_service)],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ReportRunList:
    """This schedule's run history, newest-first (tenant-scoped; 404 if not owned)."""
    rows = await svc.list_runs(schedule_id, limit=limit, offset=offset)
    return ReportRunList(items=[ReportRunPublic.from_row(r) for r in rows], total=len(rows))


@router.get(
    "/report-schedules/{schedule_id}/runs/{run_id}/download",
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def download_schedule_run(
    schedule_id: str,
    run_id: str,
    svc: Annotated[ReportService, Depends(get_report_service)],
) -> FileResponse:
    """Stream a persisted run's rendered artefact (csv/pdf/json). 404 if gone / not owned.

    Mirrors the clip-export download: the service resolves the tenant-scoped path (404 on
    missing/other-tenant/absent-file), and we return the file with the right media type +
    a ``<name>-<kind>-<date>.<ext>`` download filename.
    """
    path, media_type, filename = await svc.resolve_run_download(schedule_id, run_id)
    return FileResponse(path, media_type=media_type, filename=filename)


@router.post(
    "/report-schedules/{schedule_id}/run-now",
    response_model=ReportRunPublic,
    status_code=status.HTTP_201_CREATED,
)
async def run_schedule_now_endpoint(
    schedule_id: str,
    svc: Annotated[ReportService, Depends(get_report_service)],
    _actor: Principal = Depends(require_permission(PERM_MANAGE)),
) -> ReportRunPublic:
    """Fire a schedule IMMEDIATELY → its created ReportRun. Does NOT touch ``next_run_at``.

    Delegates to the same reusable entrypoint the scheduler loop uses. A compute failure
    still persists an ``error`` ReportRun (surfaced as the 201 body so the caller sees why);
    only a total persist failure (no run at all) is a clean 500.
    """
    run = await svc.run_now(schedule_id)
    if run is None:
        # Even the error-row persist failed (very rare) — a clean 500, not a 404 (the
        # schedule was found; producing/recording the run is what failed).
        raise AppError(
            "report run could not be produced",
            code="REPORT_RUN_FAILED",
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )
    return ReportRunPublic.from_row(run)


# ── ad-hoc report reads ──────────────────────────────────────────────────


@router.get(
    "/reports",
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def list_report_kinds() -> dict:
    """The available report kinds (for the Reports page kind picker). Includes the G8
    ``operator-activity`` + ``alarm-response`` kinds alongside the operational ones."""
    return {"kinds": list(REPORT_KINDS)}


@router.get(
    "/reports/{kind}/export",
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def export_report(
    kind: str,
    svc: Annotated[ReportService, Depends(get_report_service)],
    from_: Annotated[datetime, Query(alias="from")],
    to: Annotated[datetime, Query()],
    fmt: Annotated[str, Query(alias="format")] = "csv",
    camera_id: Optional[str] = None,
) -> Response:
    """Compute ``kind`` over [from, to] → a CSV or PDF download (``format=csv|pdf``)."""
    report = await svc.report(kind, from_, to, camera_id)
    if fmt == "pdf":
        try:
            body = to_pdf(report)
        except PdfUnavailable:
            return Response(
                content='{"error":"pdf export unavailable (reportlab not installed)"}',
                media_type="application/json",
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        media_type = "application/pdf"
        ext = "pdf"
    else:
        body = to_csv(report)
        media_type = "text/csv"
        ext = "csv"
    filename = f"{kind}-report.{ext}"
    return Response(
        content=body,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get(
    "/reports/{kind}",
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def get_report(
    kind: str,
    svc: Annotated[ReportService, Depends(get_report_service)],
    from_: Annotated[datetime, Query(alias="from")],
    to: Annotated[datetime, Query()],
    camera_id: Optional[str] = None,
) -> dict:
    """Compute ``kind`` over [from, to] (optional ``camera_id``) → the JSON report."""
    return await svc.report(kind, from_, to, camera_id)
