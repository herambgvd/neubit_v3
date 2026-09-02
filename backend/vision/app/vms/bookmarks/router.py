"""Bookmark router (G3) — perm-gated, tenant-scoped.

Mounted under ``/vms`` (paths ``/api/v1/vms/bookmarks...``). Operators mark moments /
ranges in recorded footage with a note + tags. Both reads and writes gate on
``vms.playback.view`` — a bookmark is part of the playback/investigation surface (the
same permission the recording browse + storage reads use), so any operator who can
review footage can annotate it. The ``*`` wildcard grants it.
"""

from __future__ import annotations

from typing import Annotated

from datetime import datetime

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission

from app.db import get_db

from .schemas import (
    BookmarkCreate,
    BookmarkListResponse,
    BookmarkPublic,
    BookmarkUpdate,
)
from .service import BookmarkService

PERM_VIEW = "vms.playback.view"

router = APIRouter(prefix="/vms", tags=["VMS Bookmarks"])


async def get_bookmark_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
) -> BookmarkService:
    return BookmarkService(db, scope)


@router.get(
    "/bookmarks",
    response_model=BookmarkListResponse,
    dependencies=[Depends(require_permission(PERM_VIEW))],
)
async def list_bookmarks(
    svc: Annotated[BookmarkService, Depends(get_bookmark_service)],
    camera_id: str | None = Query(None, alias="camera_id", max_length=36),
    from_: datetime | None = Query(None, alias="from"),
    to: datetime | None = Query(None, alias="to"),
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
) -> BookmarkListResponse:
    items, total = await svc.list_(
        camera_id=camera_id, from_=from_, to=to, skip=skip, limit=limit
    )
    return BookmarkListResponse(items=items, total=total)


@router.post(
    "/bookmarks",
    response_model=BookmarkPublic,
    status_code=status.HTTP_201_CREATED,
)
async def create_bookmark(
    body: BookmarkCreate,
    svc: Annotated[BookmarkService, Depends(get_bookmark_service)],
    actor: Principal = Depends(require_permission(PERM_VIEW)),
) -> BookmarkPublic:
    return await svc.create(body, actor=actor)


@router.patch("/bookmarks/{bookmark_id}", response_model=BookmarkPublic)
async def update_bookmark(
    bookmark_id: str,
    body: BookmarkUpdate,
    svc: Annotated[BookmarkService, Depends(get_bookmark_service)],
    _actor: Principal = Depends(require_permission(PERM_VIEW)),
) -> BookmarkPublic:
    return await svc.update(bookmark_id, body)


@router.delete("/bookmarks/{bookmark_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_bookmark(
    bookmark_id: str,
    svc: Annotated[BookmarkService, Depends(get_bookmark_service)],
    _actor: Principal = Depends(require_permission(PERM_VIEW)),
) -> Response:
    await svc.delete(bookmark_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
