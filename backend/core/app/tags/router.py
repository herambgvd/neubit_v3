"""Tags routes — permission-gated, tenant-scoped.

Full path mounted by ``create_base_app`` under the api_prefix → ``{prefix}/tags``.

Endpoints:
  * ``GET    /tags``                          list (search + is_active, paginated)
  * ``POST   /tags``                          create
  * ``GET    /tags/{tag_id}``                 read one
  * ``PATCH  /tags/{tag_id}``                 update
  * ``DELETE /tags/{tag_id}``                 delete (+ its links)
  * ``POST   /tags/{tag_id}/assign``          attach to an entity
  * ``POST   /tags/{tag_id}/unassign``        detach from an entity
  * ``GET    /tags/{tag_id}/entities``        entities carrying this tag
  * ``GET    /tags/for/{entity_type}/{id}``   tags on a given entity
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.deps import require_permission
from ..auth.models import User
from ..db.base import get_db
from ..tenancy.scope import get_scope
from .schemas import (
    CreateTagRequest,
    TagAssignRequest,
    TagListResponse,
    TagLinkPublic,
    TagPublic,
    UpdateTagRequest,
)
from .service import TagService

router = APIRouter(prefix="/tags", tags=["Tags"])


async def _service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope=Depends(get_scope),
) -> TagService:
    return TagService(db, scope)


@router.get(
    "",
    response_model=TagListResponse,
    dependencies=[Depends(require_permission("tags.read"))],
)
async def list_tags(
    svc: Annotated[TagService, Depends(_service)],
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    search: Optional[str] = Query(None, max_length=100),
    is_active: Optional[bool] = Query(None),
) -> TagListResponse:
    items, total = await svc.list_(skip=skip, limit=limit, search=search, is_active=is_active)
    return TagListResponse(items=items, total=total, skip=skip, limit=limit)


@router.post(
    "",
    response_model=TagPublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_tag(
    body: CreateTagRequest,
    svc: Annotated[TagService, Depends(_service)],
    actor: User = Depends(require_permission("tags.create")),
) -> TagPublic:
    return await svc.create(body, actor=actor)


@router.get(
    "/for/{entity_type}/{entity_id}",
    response_model=list[TagPublic],
    dependencies=[Depends(require_permission("tags.read"))],
)
async def tags_for_entity(
    entity_type: str,
    entity_id: str,
    svc: Annotated[TagService, Depends(_service)],
) -> list[TagPublic]:
    return await svc.tags_for_entity(entity_type, entity_id)


@router.get(
    "/{tag_id}",
    response_model=TagPublic,
    dependencies=[Depends(require_permission("tags.read"))],
)
async def get_tag(
    tag_id: str,
    svc: Annotated[TagService, Depends(_service)],
) -> TagPublic:
    return await svc.get(tag_id)


@router.patch(
    "/{tag_id}",
    response_model=TagPublic,
)
async def update_tag(
    tag_id: str,
    body: UpdateTagRequest,
    svc: Annotated[TagService, Depends(_service)],
    actor: User = Depends(require_permission("tags.update")),
) -> TagPublic:
    return await svc.update(tag_id, body, actor=actor)


@router.delete(
    "/{tag_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_tag(
    tag_id: str,
    svc: Annotated[TagService, Depends(_service)],
    actor: User = Depends(require_permission("tags.delete")),
) -> Response:
    await svc.delete(tag_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{tag_id}/assign",
    response_model=TagPublic,
)
async def assign_tag(
    tag_id: str,
    body: TagAssignRequest,
    svc: Annotated[TagService, Depends(_service)],
    actor: User = Depends(require_permission("tags.update")),
) -> TagPublic:
    return await svc.assign(tag_id, body, actor=actor)


@router.post(
    "/{tag_id}/unassign",
    response_model=TagPublic,
)
async def unassign_tag(
    tag_id: str,
    body: TagAssignRequest,
    svc: Annotated[TagService, Depends(_service)],
    actor: User = Depends(require_permission("tags.update")),
) -> TagPublic:
    return await svc.unassign(tag_id, body, actor=actor)


@router.get(
    "/{tag_id}/entities",
    response_model=list[TagLinkPublic],
    dependencies=[Depends(require_permission("tags.read"))],
)
async def entities_for_tag(
    tag_id: str,
    svc: Annotated[TagService, Depends(_service)],
) -> list[TagLinkPublic]:
    return await svc.entities_for_tag(tag_id)
