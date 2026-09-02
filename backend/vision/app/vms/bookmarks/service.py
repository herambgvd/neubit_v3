"""Bookmark service (G3) — tenant-scoped CRUD + range query over ``bookmarks``.

Mirrors the PTZ / camera services: every camera fetch goes through ``assert_owned``
(cross-tenant → NotFound → 404); every bookmark by-id is fetched via ``scoped`` and
re-verified against a camera the caller owns. Reads/writes are gated at the router by
``vms.playback.view`` (a bookmark is part of the playback/investigation surface).
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import NotFoundError, ValidationError

from app.vms.models import Bookmark, Camera

from .schemas import BookmarkCreate, BookmarkPublic, BookmarkUpdate


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


class BookmarkService:
    """Tenant-scoped bookmark CRUD + camera/time-window list."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    # ── camera resolution ───────────────────────────────────────────────
    async def _camera(self, camera_id: str) -> Camera:
        row = await self.db.get(Camera, camera_id)
        assert_owned(row, self.scope, message="camera not found")
        return row

    async def _row(self, bookmark_id: str) -> Bookmark:
        stmt = scoped(select(Bookmark), Bookmark, self.scope).where(
            Bookmark.id == bookmark_id
        )
        row = await self.db.scalar(stmt)
        if row is None:
            raise NotFoundError("Bookmark not found")
        return row

    # ── list (camera + optional [from, to] window) ──────────────────────
    async def list_(
        self,
        *,
        camera_id: str | None = None,
        from_: datetime | None = None,
        to: datetime | None = None,
        skip: int = 0,
        limit: int = 100,
    ) -> tuple[list[BookmarkPublic], int]:
        stmt = scoped(select(Bookmark), Bookmark, self.scope)
        if camera_id is not None:
            # Verify ownership of the camera when filtering by it (404 on foreign).
            await self._camera(camera_id)
            stmt = stmt.where(Bookmark.camera_id == camera_id)
        # A bookmark [start_ts, end_ts?] OVERLAPS [from, to]: start_ts < to AND
        # (end_ts IS NULL treated as a point at start_ts) end >= from.
        if to is not None:
            stmt = stmt.where(Bookmark.start_ts < to)
        if from_ is not None:
            stmt = stmt.where(
                (Bookmark.end_ts.is_(None) & (Bookmark.start_ts >= from_))
                | (Bookmark.end_ts.isnot(None) & (Bookmark.end_ts > from_))
            )
        rows = list(
            (
                await self.db.execute(
                    stmt.order_by(Bookmark.start_ts.asc()).offset(skip).limit(limit)
                )
            )
            .scalars()
            .all()
        )
        return [BookmarkPublic.from_row(r) for r in rows], len(rows)

    # ── create / update / delete ────────────────────────────────────────
    async def create(self, body: BookmarkCreate, *, actor) -> BookmarkPublic:
        await self._camera(body.camera_id)
        if body.end_ts is not None and body.end_ts <= body.start_ts:
            raise ValidationError("end_ts must be after start_ts")
        row = Bookmark(
            tenant_id=self.scope.tenant_id,
            camera_id=body.camera_id,
            start_ts=body.start_ts,
            end_ts=body.end_ts,
            title=body.title,
            note=body.note,
            tags=list(body.tags or []),
            created_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return BookmarkPublic.from_row(row)

    async def update(self, bookmark_id: str, body: BookmarkUpdate) -> BookmarkPublic:
        row = await self._row(bookmark_id)
        data = body.model_dump(exclude_unset=True)
        if "start_ts" in data and data["start_ts"] is not None:
            row.start_ts = data["start_ts"]
        if "end_ts" in data:
            row.end_ts = data["end_ts"]
        if "title" in data and data["title"] is not None:
            row.title = data["title"]
        if "note" in data:
            row.note = data["note"]
        if "tags" in data and data["tags"] is not None:
            row.tags = list(data["tags"])
        if row.end_ts is not None and row.end_ts <= row.start_ts:
            raise ValidationError("end_ts must be after start_ts")
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return BookmarkPublic.from_row(row)

    async def delete(self, bookmark_id: str) -> None:
        row = await self._row(bookmark_id)
        await self.db.delete(row)
        await self.db.commit()
