"""Clip-export router — permission-gated, tenant-scoped (P4-B).

Mounted under the service api_prefix (``/api/v1``) with the ``/vms`` domain prefix:
  * ``POST /vms/cameras/{id}/export {from, to, format?=mp4}`` → queue an export job.
  * ``GET  /vms/export/{job_id}``            → the job status/result.
  * ``GET  /vms/export/{job_id}/download``   → stream the produced mp4.

All three gate on ``vms.export`` (``*`` wildcard grants it) and run in the caller's
tenant scope. The download is a direct authed stream of the tenant-scoped clip file —
no separate media token needed (unlike the MediaMTX hot path, the file is served by
vision itself behind the same JWT the API uses).

Graceful: a window with no recordings → 404 (clean empty); a not-yet-ready / vanished
clip → 404. The worker (not this router) does the ffmpeg concat.
"""

from __future__ import annotations

import os
from typing import Annotated

from fastapi import APIRouter, Depends, status
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db

from .schemas import ExportJobPublic, ExportStartBody, ExportVerifyResult
from .service import ExportService

PERM_EXPORT = "vms.export"

router = APIRouter(prefix="/vms", tags=["VMS Export"])


async def get_export_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> ExportService:
    return ExportService(db, scope)


@router.post(
    "/cameras/{camera_id}/export",
    response_model=ExportJobPublic,
    status_code=status.HTTP_201_CREATED,
)
async def start_export(
    camera_id: str,
    body: ExportStartBody,
    svc: Annotated[ExportService, Depends(get_export_service)],
    actor: Principal = Depends(require_permission(PERM_EXPORT)),
) -> ExportJobPublic:
    row = await svc.create(
        camera_id, body.from_, body.to, body.format, actor=actor, watermark=body.watermark
    )
    return ExportJobPublic.from_row(row)


@router.get(
    "/export/public-key",
    dependencies=[Depends(require_permission(PERM_EXPORT))],
)
async def export_public_key() -> dict:
    """The Ed25519 PUBLIC key (PEM) + key id used to sign exports — for offline verify.

    Registered BEFORE ``/export/{job_id}`` so the literal path isn't swallowed by the
    ``{job_id}`` catch-all (FastAPI matches in registration order).
    """
    from .signing import signer_key_id, signer_public_pem

    return {"algorithm": "Ed25519", "key_id": signer_key_id(), "public_key": signer_public_pem()}


@router.get(
    "/export/{job_id}",
    response_model=ExportJobPublic,
    dependencies=[Depends(require_permission(PERM_EXPORT))],
)
async def get_export(
    job_id: str,
    svc: Annotated[ExportService, Depends(get_export_service)],
) -> ExportJobPublic:
    return ExportJobPublic.from_row(await svc.get(job_id))


@router.get(
    "/export/{job_id}/download",
    dependencies=[Depends(require_permission(PERM_EXPORT))],
)
async def download_export(
    job_id: str,
    svc: Annotated[ExportService, Depends(get_export_service)],
) -> FileResponse:
    """Stream the produced mp4 (tenant-scoped, gated). 404 until done / if file gone."""
    job, path = await svc.resolve_download(job_id)
    filename = f"export-{job.camera_id}-{job.id}.{job.format or 'mp4'}"
    media_type = "video/mp4" if (job.format or "mp4") == "mp4" else "application/octet-stream"
    return FileResponse(
        path,
        media_type=media_type,
        filename=os.path.basename(filename),
    )


@router.get(
    "/export/{job_id}/manifest",
    dependencies=[Depends(require_permission(PERM_EXPORT))],
)
async def download_manifest(
    job_id: str,
    svc: Annotated[ExportService, Depends(get_export_service)],
) -> FileResponse:
    """Download the tamper-evidence sidecar (``<job>.manifest.json``): hash + signature.

    A verifier downloads this alongside the mp4 and can re-hash + verify the Ed25519
    signature offline against the embedded public key. 404 until done / if gone.
    """
    job, path = await svc.resolve_manifest(job_id)
    return FileResponse(
        path,
        media_type="application/json",
        filename=f"export-{job.id}.manifest.json",
    )


@router.post(
    "/export/{job_id}/verify",
    response_model=ExportVerifyResult,
    dependencies=[Depends(require_permission(PERM_EXPORT))],
)
async def verify_export(
    job_id: str,
    svc: Annotated[ExportService, Depends(get_export_service)],
) -> ExportVerifyResult:
    """Re-hash the produced clip + verify its Ed25519 signature → ``{valid, reason}``.

    A clip altered after signing verifies as ``valid:false, reason:"tampered"``.
    """
    result = await svc.verify(job_id)
    return ExportVerifyResult(**result)
