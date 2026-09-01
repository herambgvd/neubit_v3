"""Site service — CRUD + soft-delete/restore + tree + threat-level, tenant-scoped.

Folds neubit_v2's repository + service into one scope-aware service (the v3 house
style: a service that holds the ``AsyncSession`` and routes every read through
``scoped`` and every by-id fetch through ``assert_owned``). New rows are stamped
with the caller's ``tenant_id``.

Emits domain events on the NATS spine and writes audit entries on every mutation.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.audit import record as audit_record
from ...core.errors import ConflictError, NotFoundError, ValidationError
from ...tenancy.scope import Scope, assert_owned, scoped
from ..events import emit
from ..floor.models import Floor
from ..zone.models import Zone
from .models import Site, SiteEmissionFactor, SiteTariffSlab
from .schemas import (
    Coordinates,
    CreateSiteRequest,
    EmissionFactorPublic,
    EmissionFactorsUpdate,
    GeoPoint,
    SitePublic,
    TariffSlabPublic,
    TariffSlabsUpdate,
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
    def __init__(self, db: AsyncSession, scope: Scope, site_ids: list[str] | None = None) -> None:
        self.db = db
        self.scope = scope
        # Per-user SITE ACCESS SCOPE (from the caller's User.site_ids). EMPTY =
        # unrestricted (every site in the tenant). Non-empty confines reads/lookups
        # to exactly these sites — the same coarse control the token's ``site_ids``
        # claim applies to cameras in the vision service.
        self.site_ids = [str(s) for s in (site_ids or [])]

    def _site_allowed(self, row: Site) -> bool:
        if not self.site_ids:
            return True
        return row is not None and str(row.site_id) in self.site_ids

    # ── internal fetch (scoped) ────────────────────────────────────

    async def _get_row(self, site_id: str) -> Site:
        row = await self.db.get(Site, site_id)
        assert_owned(row, self.scope, message="Site not found")
        # Site scope: a site outside the caller's scope is indistinguishable from a
        # missing one (NOT_FOUND, never FORBIDDEN — no cross-site existence leak).
        if not self._site_allowed(row):
            raise NotFoundError("Site not found")
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
        # Confine a site-scoped caller to their sites (empty list = all sites).
        if self.site_ids:
            stmt = stmt.where(Site.site_id.in_(self.site_ids))
            count_stmt = count_stmt.where(Site.site_id.in_(self.site_ids))
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

    async def set_building_facts(self, site_id: str, body, *, actor) -> SitePublic:
        """Record the operator's assertions about the building itself.

        A SET, not a patch: every one of the four fields is written from the
        request, so an explicit null CLEARS it and the site goes back to "not
        recorded". That state has to be reachable — a rating that divides by a
        wrong area an operator cannot take back is worse than one that says it
        has no area.

        Nothing is inferred here. There is no default area, no assumed currency
        and no fallback tariff; what the operator did not state stays absent.
        """
        row = await self._get_row(site_id)

        if body.energy_tariff_per_kwh is not None and not body.tariff_currency:
            # A bare 8.5 is not a price. Refusing is the honest response;
            # assuming rupees would put a currency on a screen nobody stated.
            raise ValidationError("A tariff needs a currency")

        row.gross_floor_area_sqm = body.gross_floor_area_sqm
        row.energy_tariff_per_kwh = body.energy_tariff_per_kwh
        row.tariff_currency = body.tariff_currency if body.energy_tariff_per_kwh is not None else None
        row.occupancy = body.occupancy

        actor_user_id = str(getattr(actor, "id", "")) or None
        now = _utcnow()
        # Provenance of the ASSERTION, separate from the row's own updated_at —
        # which moves when anyone edits a phone number and so cannot say who
        # stands behind a number a rating divides by.
        row.building_facts_updated_at = now
        row.building_facts_updated_by = actor_user_id
        row.updated_by = actor_user_id
        row.updated_at = now

        await self.db.commit()
        await self.db.refresh(row)
        await self._emit(actor, "building_facts_updated", row, {})
        return SitePublic.from_row(row, floor_count=await self._floor_count(site_id))


    # ── Time-of-Use tariff slabs + emission factors (migration 0019) ──────
    #
    # Both are INPUT PATHS for Building Intelligence: homes for numbers an
    # operator will supply later, never values this code supplies. Both PUTs
    # are FULL REPLACES — the retraction property `set_building_facts`
    # established: an explicit empty list clears the set, because a wrong rate
    # (or factor) an operator cannot take back is worse than none.

    async def _slab_rows(self, site_id: str) -> list[SiteTariffSlab]:
        return list(
            (
                await self.db.execute(
                    select(SiteTariffSlab)
                    .where(SiteTariffSlab.site_id == site_id)
                    .order_by(
                        SiteTariffSlab.effective_from.asc(), SiteTariffSlab.position.asc()
                    )
                )
            )
            .scalars()
            .all()
        )

    async def _factor_rows(self, site_id: str) -> list[SiteEmissionFactor]:
        return list(
            (
                await self.db.execute(
                    select(SiteEmissionFactor)
                    .where(SiteEmissionFactor.site_id == site_id)
                    .order_by(SiteEmissionFactor.effective_from.asc())
                )
            )
            .scalars()
            .all()
        )

    async def get_tariff_slabs(self, site_id: str) -> list[TariffSlabPublic]:
        await self._get_row(site_id)  # scope + existence
        return [TariffSlabPublic.model_validate(r) for r in await self._slab_rows(site_id)]

    async def set_tariff_slabs(
        self, site_id: str, body: TariffSlabsUpdate, *, actor
    ) -> list[TariffSlabPublic]:
        """Replace the site's WHOLE slab list.

        PRECEDENCE (stated once, in code): when any slab with `effective_from`
        on or before the date being priced exists, the slab set overrides the
        scalar `energy_tariff_per_kwh` ENTIRELY for that date; an hour no slab
        covers has NO price — absence, never a fallback into the scalar. The
        scalar applies only when no slab set is in effect.

        Coverage of the 24h cycle is deliberately NOT enforced and no filler
        slab is ever invented: a partial tariff is a partial statement, and the
        UI warns rather than the server completing it.
        """
        row = await self._get_row(site_id)
        actor_user_id = str(getattr(actor, "id", "")) or None

        await self.db.execute(
            sa_delete(SiteTariffSlab).where(SiteTariffSlab.site_id == site_id)
        )
        for idx, slab in enumerate(body.slabs):
            self.db.add(
                SiteTariffSlab(
                    tenant_id=row.tenant_id,
                    site_id=site_id,
                    name=slab.name,
                    start_minute=slab.start_minute,
                    end_minute=slab.end_minute,
                    rate_per_kwh=slab.rate_per_kwh,
                    currency=slab.currency,
                    effective_from=slab.effective_from,
                    position=idx,
                    created_by=actor_user_id,
                )
            )
        await self.db.commit()
        await self._emit(actor, "tariff_slabs_updated", row, {"slab_count": len(body.slabs)})
        return [TariffSlabPublic.model_validate(r) for r in await self._slab_rows(site_id)]

    async def get_emission_factors(self, site_id: str) -> list[EmissionFactorPublic]:
        await self._get_row(site_id)
        return [EmissionFactorPublic.model_validate(r) for r in await self._factor_rows(site_id)]

    async def set_emission_factors(
        self, site_id: str, body: EmissionFactorsUpdate, *, actor
    ) -> list[EmissionFactorPublic]:
        """Replace the site's WHOLE emission-factor list. Every factor carries
        its REQUIRED source (schema-enforced): a number with no citation is an
        invented figure and never reaches this table."""
        row = await self._get_row(site_id)

        dates = [f.effective_from for f in body.factors]
        if len(dates) != len(set(dates)):
            # Two factors from the same date are a contradiction, not a history.
            raise ValidationError("Two emission factors share the same effective-from date")

        actor_user_id = str(getattr(actor, "id", "")) or None
        await self.db.execute(
            sa_delete(SiteEmissionFactor).where(SiteEmissionFactor.site_id == site_id)
        )
        for factor in body.factors:
            self.db.add(
                SiteEmissionFactor(
                    tenant_id=row.tenant_id,
                    site_id=site_id,
                    kg_co2_per_kwh=factor.kg_co2_per_kwh,
                    source=factor.source,
                    effective_from=factor.effective_from,
                    created_by=actor_user_id,
                )
            )
        await self.db.commit()
        await self._emit(
            actor, "emission_factors_updated", row, {"factor_count": len(body.factors)}
        )
        return [EmissionFactorPublic.model_validate(r) for r in await self._factor_rows(site_id)]

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
        # The BUILDING FACTS ride on every site event, read from the row core
        # just committed rather than from the request body. Same rule the device
        # placement events follow (pipeline contract §18): the authority STATES
        # the fact beside the id it owns, instead of a subscriber being told to
        # go and ask. `reading-writer`'s site-facts consumer mirrors these into
        # `neubit_reporting.site_facts` so Building Intelligence can divide by an
        # area without reading a database it is banned from reading.
        #
        # Since migration 0019 the WHOLE fact set rides too — city, tariff
        # slabs, emission factors — read fresh from the rows just committed, so
        # a mirror that misses one message is corrected by the next site edit
        # of any kind and no COALESCE gymnastics are needed on the other side.
        # An empty list is a statement ("no slabs"), not an omission.
        address = row.address if isinstance(row.address, dict) else {}
        city = address.get("city") or None
        slabs = [
            {
                "name": s.name,
                "start_minute": s.start_minute,
                "end_minute": s.end_minute,
                "rate_per_kwh": s.rate_per_kwh,
                "currency": s.currency,
                "effective_from": s.effective_from.isoformat(),
                "position": s.position,
            }
            for s in await self._slab_rows(row.site_id)
        ]
        factors = [
            {
                "kg_co2_per_kwh": f.kg_co2_per_kwh,
                "source": f.source,
                "effective_from": f.effective_from.isoformat(),
            }
            for f in await self._factor_rows(row.site_id)
        ]
        await emit(
            row.tenant_id,
            "site",
            event,
            {
                "site_id": row.site_id,
                "name": row.name,
                "is_active": row.is_active,
                # Human location, resolved server-side from core's own row.
                # Null when the address (or its city) was never recorded — the
                # mirror stores null and BI renders an em dash, never a guess.
                "city": city,
                "gross_floor_area_sqm": row.gross_floor_area_sqm,
                "energy_tariff_per_kwh": row.energy_tariff_per_kwh,
                "tariff_currency": row.tariff_currency,
                "occupancy": row.occupancy,
                "tariff_slabs": slabs,
                "emission_factors": factors,
                "building_facts_updated_at": (
                    row.building_facts_updated_at.isoformat()
                    if row.building_facts_updated_at
                    else None
                ),
                **after,
            },
        )
        await audit_record(
            self.db,
            actor=actor,
            action=f"site.{event}",
            target_type="site",
            target_id=row.site_id,
            meta=after,
        )
