"""Floor routes — JSON CRUD plus multipart floorplan upload.

The upload endpoints accept PDF / DXF / image files, run them through
``floorplan_converter`` (PDF → PNG, DXF → SVG, images passthrough), and store the
converted artefact under a tenant-namespaced key via the platform storage backend.

Full path mounted under the api_prefix → ``{prefix}/floors``.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Query,
    Response,
    UploadFile,
    status,
)
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.deps import require_permission
from ...auth.models import User
from ...core.errors import ValidationError
from ...core.storage import get_storage
from ...db.base import get_db
from ...tenancy.scope import Scope, get_scope
from .floorplan_converter import MAX_FILE_SIZE, convert_floorplan, is_supported_format
from .schemas import (
    CreateFloorRequest,
    FloorListResponse,
    FloorPublic,
    UpdateFloorRequest,
)
from .service import FloorService

router = APIRouter(prefix="/floors", tags=["Floors"])


async def _service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope=Depends(get_scope),
) -> FloorService:
    return FloorService(db, scope)


@router.get(
    "",
    response_model=FloorListResponse,
    dependencies=[Depends(require_permission("floors.read"))],
)
async def list_floors(
    svc: Annotated[FloorService, Depends(_service)],
    site_id: Optional[str] = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    search: Optional[str] = Query(None, max_length=100),
    is_active: Optional[bool] = Query(None),
) -> FloorListResponse:
    items, total = await svc.list_(
        site_id=site_id, skip=skip, limit=limit, search=search, is_active=is_active
    )
    return FloorListResponse(items=items, total=total, skip=skip, limit=limit)


@router.post(
    "",
    response_model=FloorPublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_floor(
    body: CreateFloorRequest,
    svc: Annotated[FloorService, Depends(_service)],
    actor: User = Depends(require_permission("floors.create")),
) -> FloorPublic:
    return await svc.create(body, actor=actor)


@router.post(
    "/upload",
    response_model=FloorPublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_floor_with_upload(
    svc: Annotated[FloorService, Depends(_service)],
    scope: Annotated[Scope, Depends(get_scope)],
    site_id: Annotated[str, Form()],
    name: Annotated[str, Form()],
    file: Annotated[UploadFile, File()],
    floor_number: Annotated[Optional[int], Form()] = None,
    description: Annotated[Optional[str], Form()] = None,
    total_area: Annotated[Optional[float], Form()] = None,
    actor: User = Depends(require_permission("floors.create")),
) -> FloorPublic:
    floorplan_url = await _process_upload(file, scope=scope, site_id=site_id)
    body = CreateFloorRequest(
        site_id=site_id,
        name=name,
        floor_number=floor_number,
        description=description,
        total_area=total_area,
        floorplan_url=floorplan_url,
    )
    return await svc.create(body, actor=actor)


@router.get(
    "/{floor_id}",
    response_model=FloorPublic,
    dependencies=[Depends(require_permission("floors.read"))],
)
async def get_floor(
    floor_id: str,
    svc: Annotated[FloorService, Depends(_service)],
) -> FloorPublic:
    return await svc.get(floor_id)


@router.patch(
    "/{floor_id}",
    response_model=FloorPublic,
)
async def update_floor(
    floor_id: str,
    body: UpdateFloorRequest,
    svc: Annotated[FloorService, Depends(_service)],
    actor: User = Depends(require_permission("floors.update")),
) -> FloorPublic:
    return await svc.update(floor_id, body, actor=actor)


@router.delete(
    "/{floor_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_floor(
    floor_id: str,
    svc: Annotated[FloorService, Depends(_service)],
    actor: User = Depends(require_permission("floors.delete")),
) -> Response:
    await svc.delete(floor_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{floor_id}/floorplan",
    response_model=FloorPublic,
)
async def replace_floorplan(
    floor_id: str,
    svc: Annotated[FloorService, Depends(_service)],
    scope: Annotated[Scope, Depends(get_scope)],
    file: Annotated[UploadFile, File()],
    actor: User = Depends(require_permission("floors.update")),
) -> FloorPublic:
    existing = await svc.get(floor_id)  # 404s (scoped) if not the caller's floor
    floorplan_url = await _process_upload(file, scope=scope, site_id=existing.site_id)
    return await svc.update(floor_id, UpdateFloorRequest(floorplan_url=floorplan_url), actor=actor)


@router.post(
    "/{floor_id}/restore",
    response_model=FloorPublic,
)
async def restore_floor(
    floor_id: str,
    svc: Annotated[FloorService, Depends(_service)],
    actor: User = Depends(require_permission("floors.update")),
) -> FloorPublic:
    return await svc.restore(floor_id, actor=actor)


async def _process_upload(file: UploadFile, *, scope: Scope, site_id: str) -> str:
    if not is_supported_format(file.content_type):
        raise ValidationError(
            f"Unsupported file type: {file.content_type}",
            code="UNSUPPORTED_FILE_TYPE",
            status_code=400,
        )
    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise ValidationError(
            f"File exceeds {MAX_FILE_SIZE // (1024 * 1024)}MB limit",
            code="FILE_TOO_LARGE",
            status_code=413,
        )
    namespace = str(scope.tenant_id) if scope.tenant_id is not None else "platform"
    try:
        result = await convert_floorplan(
            content=content,
            content_type=file.content_type or "application/octet-stream",
            filename=file.filename or "floorplan",
            namespace=namespace,
            site_id=site_id,
        )
    except ValueError as exc:
        # Missing optional dep (pdf2image/ezdxf/matplotlib) or a bad file → 422.
        raise ValidationError(str(exc), code="CONVERSION_FAILED", status_code=422) from exc
    await get_storage().put(
        result.storage_path, result.converted_content, result.converted_type
    )
    return await get_storage().url(result.storage_path)
