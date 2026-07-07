"""Site service — CRUD + soft-delete/restore + tree + threat-level, tenant-scoped.

Folds neubit_v2's repository + service into one scope-aware service (the v3 house
style: a service that holds the ``AsyncSession`` and routes every read through
``scoped`` and every by-id fetch through ``assert_owned``). New rows are stamped
with the caller's ``tenant_id``.

Emits domain events on the NATS spine and writes audit entries on every mutation.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.audit import record as audit_record
from ...core.errors import ConflictError
from ...tenancy.scope import Scope, assert_owned, scoped
from ..events import emit
from ..floor.models import Floor
from ..zone.models import Zone
from .models import Site
from .schemas import (
    Coordinates,
    CreateSiteRequest,
    GeoPoint,
    SitePublic,
    UpdateSiteRequest,
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _to_geo_point(coords: Coordinates | None) -> GeoPoint | None:
    if not coords:
        return None
    return GeoPoint(coordinates=[coords.longitude, coords.latitude])


def _dump(value):
    """model_dump a pydantic value; pass dicts/None through unchanged."""
    return value.model_dump() if hasattr(value, "model_dump") else value


class SiteService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    # ── internal fetch (scoped) ────────────────────────────────────

    async def _get_row(self, site_id: str) -> Site:
        row = await self.db.get(Site, site_id)
        assert_owned(row, self.scope, message="Site not found")
        return row

    async def _floor_count(self, site_id: str) -> int:
        return int(
            await self.db.scalar(
                select(func.count())
                .select_from(Floor)
                .where(Floor.site_id == site_id, Floor.is_active.is_(True))
            )
            or 0
        )

    # ── Public ─────────────────────────────────────────────────────

    async def create(
        self, body: CreateSiteRequest, *, actor
    ) -> SitePublic:
        if body.parent_id:
            parent = await self.db.get(Site, body.parent_id)
            # A parent from another tenant is invisible → treated as missing.
            if parent is None or not parent.is_active or (
                not self.scope.is_platform and parent.tenant_id != self.scope.tenant_id
            ):
                raise ConflictError("Parent site does not exist or is inactive")

        actor_user_id = str(getattr(actor, "id", "")) or None
        row = Site(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            location_code=body.location_code,
            description=body.description,
            site_type=body.site_type,
            parent_id=body.parent_id,
            threat_level=body.threat_level,
            address=_dump(body.address),
            coordinates=_dump(body.coordinates),
            geo_location=_dump(_to_geo_point(body.coordinates)),
            contact_person=body.contact_person,
            contact_phone=body.contact_phone,
            email_address=body.email_address,
            image_url=body.image_url,
            created_by=actor_user_id,
            updated_by=actor_user_id,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        await self._emit(actor, "created", row, {"name": row.name, "site_type": row.site_type})
        return SitePublic.from_row(row, floor_count=0)

    async def list_(
        self,
        *,
        skip: int = 0,
        limit: int = 20,
        search: str | None = None,
        is_active: bool | None = None,
    ) -> tuple[list[SitePublic], int]:
        stmt = scoped(select(Site), Site, self.scope)
        count_stmt = scoped(select(func.count()).select_from(Site), Site, self.scope)
        if search:
            term = f"%{search}%"
            stmt = stmt.where(Site.name.ilike(term))
            count_stmt = count_stmt.where(Site.name.ilike(term))
        if is_active is not None:
            stmt = stmt.where(Site.is_active.is_(is_active))
            count_stmt = count_stmt.where(Site.is_active.is_(is_active))
        stmt = stmt.order_by(Site.created_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count_stmt) or 0)
        out = [SitePublic.from_row(r, floor_count=await self._floor_count(r.site_id)) for r in rows]
        return out, total

    async def get(self, site_id: str) -> SitePublic:
        row = await self._get_row(site_id)
        return SitePublic.from_row(row, floor_count=await self._floor_count(site_id))

    async def update(self, site_id: str, body: UpdateSiteRequest, *, actor) -> SitePublic:
        row = await self._get_row(site_id)

        if body.parent_id and body.parent_id != row.parent_id:
            await self._assert_no_cycle(site_id, body.parent_id)

        update = body.model_dump(exclude_none=True)
        if "address" in update:
            update["address"] = _dump(body.address)
        if "coordinates" in update:
            update["coordinates"] = _dump(body.coordinates)
            update["geo_location"] = _dump(_to_geo_point(body.coordinates))

        actor_user_id = str(getattr(actor, "id", "")) or None
        if actor_user_id:
            update["updated_by"] = actor_user_id
        update["updated_at"] = _utcnow()

        for k, v in update.items():
            setattr(row, k, v)
        await self.db.commit()
        await self.db.refresh(row)
        await self._emit(actor, "updated", row, body.model_dump(exclude_none=True))
        return SitePublic.from_row(row, floor_count=await self._floor_count(site_id))

    async def delete(self, site_id: str, *, actor) -> None:
        row = await self._get_row(site_id)
        now = _utcnow()
        row.is_active = False
        row.updated_at = now
        # Soft-delete descendants (floors + zones) of this site.
        await self._cascade_active(site_id, active=False, now=now)
        await self.db.commit()
        await self._emit(actor, "deleted", row, {})

    async def restore(self, site_id: str, *, actor) -> SitePublic:
        row = await self._get_row(site_id)
        actor_user_id = str(getattr(actor, "id", "")) or None
        now = _utcnow()
        row.is_active = True
        row.updated_by = actor_user_id
        row.updated_at = now
        await self._cascade_active(site_id, active=True, now=now)
        await self.db.commit()
        await self.db.refresh(row)
        await self._emit(actor, "restored", row, {})
        return SitePublic.from_row(row, floor_count=await self._floor_count(site_id))

    async def update_threat_level(self, site_id: str, new_level: str, *, actor) -> dict:
        row = await self._get_row(site_id)
        actor_user_id = str(getattr(actor, "id", "")) or None
        now = _utcnow()
        row.threat_level = new_level
        row.threat_level_updated_at = now
        row.updated_by = actor_user_id
        row.updated_at = now
        await self.db.commit()
        await self.db.refresh(row)
        # Distinct event so workflow correlation can match it.
        await self._emit(
            actor,
            "threat_level_changed",
            row,
            {"site_name": row.name, "threat_level": new_level},
        )
        return {"site_id": site_id, "threat_level": new_level}

    async def get_tree(self) -> list[dict]:
        stmt = scoped(
            select(
                Site.site_id,
                Site.name,
                Site.site_type,
                Site.parent_id,
                Site.threat_level,
                Site.location_code,
            ).where(Site.is_active.is_(True)),
            Site,
            self.scope,
        ).order_by(Site.name.asc())
        rows = (await self.db.execute(stmt)).all()
        sites = [
            {
                "id": r.site_id,
                "name": r.name,
                "site_type": r.site_type,
                "parent_id": r.parent_id,
                "threat_level": r.threat_level,
                "location_code": r.location_code,
            }
            for r in rows
        ]
        site_map = {s["id"]: {**s, "children": []} for s in sites}
        roots: list[dict] = []
        for s in sites:
            parent = s.get("parent_id")
            if parent and parent in site_map:
                site_map[parent]["children"].append(site_map[s["id"]])
            else:
                roots.append(site_map[s["id"]])
        return roots

    # ── Helpers ────────────────────────────────────────────────────

    async def _cascade_active(self, site_id: str, *, active: bool, now: datetime) -> None:
        """Flip is_active on all floors and zones of a site (soft delete/restore)."""
        from sqlalchemy import update as sa_update

        await self.db.execute(
            sa_update(Floor)
            .where(Floor.site_id == site_id)
            .values(is_active=active, updated_at=now)
        )
        await self.db.execute(
            sa_update(Zone)
            .where(Zone.site_id == site_id)
            .values(is_active=active, updated_at=now)
        )

    async def _assert_no_cycle(self, site_id: str, new_parent: str) -> None:
        if new_parent == site_id:
            raise ConflictError("Setting this parent would create a cycle")
        seen = {new_parent}
        current = await self.db.get(Site, new_parent)
        while current and current.parent_id:
            if current.parent_id == site_id:
                raise ConflictError("Setting this parent would create a cycle")
            if current.parent_id in seen:
                raise ConflictError("Setting this parent would create a cycle")
            seen.add(current.parent_id)
            current = await self.db.get(Site, current.parent_id)

    async def _emit(self, actor, event: str, row: Site, after: dict) -> None:
        await emit(
            row.tenant_id,
            "site",
            event,
            {"site_id": row.site_id, **after},
        )
        await audit_record(
            self.db,
            actor=actor,
            action=f"site.{event}",
            target_type="site",
            target_id=row.site_id,
            meta=after,
        )
