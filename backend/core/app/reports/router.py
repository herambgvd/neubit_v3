"""Reports API — list/inspect report jobs + fetch a download link.

Reading the job list requires REPORT_READ; creating an export or downloading a
produced file requires REPORT_EXPORT. Actual generation is scenario-specific (the
rows come from a domain query), so ``POST ""`` only registers a pending job as a
stub — scenarios then call ``service.generate_report_now`` / ``run_report_task``
with their own rows/columns.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.deps import require_permission
from ..auth.models import User
from ..auth.permissions import CorePerm
from ..core.errors import ValidationError
from ..core.pagination import Page, PageParams, page_params, paginate
from ..core.config import get_settings
from ..core.storage import get_storage
from ..db.base import get_db
from ..tenancy.scope import assert_owned, scope_of
from . import service
from .models import ReportJob
from .schemas import CreateReportIn, ReportJobOut

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("")
async def list_reports(
    params: PageParams = Depends(page_params),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission(CorePerm.REPORT_READ)),
) -> Page[ReportJobOut]:
    """Paginated list of report jobs, newest first (tenant-scoped)."""
    return await paginate(
        db, service.list_query(scope_of(user)), params, item_model=ReportJobOut
    )


@router.post("", response_model=ReportJobOut, status_code=201)
async def create_report(
    data: CreateReportIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission(CorePerm.REPORT_EXPORT)),
) -> ReportJob:
    """Register a pending report job (stub).

    Generation is deferred to the owning scenario, which supplies the actual rows
    to ``service.generate_report_now`` (inline) or ``run_report_task`` (worker).
    The job is stamped with the requester's tenant so it stays tenant-isolated.
    """
    return await service.create_job(
        db, data.name, data.format, requested_by=user.id, tenant_id=user.tenant_id
    )


@router.get("/{job_id}", response_model=ReportJobOut)
async def get_report(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission(CorePerm.REPORT_READ)),
) -> ReportJob:
    """Fetch a single report job (poll this for its status). Tenant-owned only."""
    job = await db.get(ReportJob, job_id)
    assert_owned(job, scope_of(user), message="report job not found")
    return job


@router.get("/{job_id}/download")
async def download_report(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission(CorePerm.REPORT_EXPORT)),
) -> dict:
    """Return a short-lived, signed URL for a finished report's file.

    A URL (signed local link or presigned S3) rather than bytes streamed through
    the API, so the browser fetches the blob directly and a large export stays off
    the event loop.

    The URL must stay expiring and signed. `/files/...` is served with no auth
    dependency, so a permanent link would gate only the first fetch and anyone who
    later found it — chat, history, proxy log, screenshot — would have the tenant's
    data. The expiry and HMAC are verified by `serve_local_file`
    (`core/storage.py`); the window is `signed_url_ttl_seconds`.

    404 if the job doesn't exist or belongs to another tenant; 422 if not ``done``.
    """
    job = await db.get(ReportJob, job_id)
    assert_owned(job, scope_of(user), message="report job not found")
    if job.status != "done" or not job.result_key:
        raise ValidationError(f"report is not ready (status={job.status})")
    ttl = get_settings().signed_url_ttl_seconds
    url = await get_storage().url(job.result_key, expires=ttl)
    return {"url": url, "expires_in": ttl}
