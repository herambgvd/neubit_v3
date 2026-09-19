"""Device-placement service — CRUD + by-floor/by-zone queries, tenant-scoped.

``register`` checks that the referenced floor is visible to the caller (same
tenant, active) and that ``site_id`` matches the floor's site; a supplied
``zone_id`` must belong to that site and floor. Registering an already placed
``device_id`` within the tenant updates it in place.

TWO SURFACES, ONE WRITER
------------------------
``register`` is the FLOOR PLAN's entry point: it starts from a drawing and puts a
device on it at ``{x, y, rotation}``. ``assign`` is the DEVICE's: it starts from a
device and says which building it is in, for the estate that has no drawing and
does not need one (see migration 0031).

They are deliberately two methods on ONE service writing ONE table.
``device_placements`` is the source of truth for where a device is and
``neubit_reporting.device_locations`` is a read-model mirrored from its events;
a second writer anywhere in that chain is how the platform ends up with the same
fact stated twice and no way to notice when the two disagree. That has already
happened once here — the BI-only placement API that ``app/placement_sync.py``'s
header describes — and it is not being repeated.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.audit import record as audit_record
from ...core.errors import ConflictError, NotFoundError
from ...tenancy.scope import Scope, assert_owned, scoped
from ..events import emit
from ..floor.models import Floor
from ..site.models import Site
from ..zone.models import Zone
from .models import DevicePlacement
from .schemas import (
    AssignDevicesRequest,
    AssignDevicesResponse,
    AssignedDevice,
    DevicePlacementPublic,
    RegisterDeviceRequest,
    UpdateDeviceRequest,
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# Which SURFACE a placement was made through, published on the event and stored
# by the reporting mirror in `device_locations.source`. It is not a confidence
# score — nothing here is ever written by a guess — and it is not the provenance
# of the FACT, which is always an operator. It answers "where was this typed",
# which is the question asked when a placement turns out to be wrong.
SOURCE_FLOOR_PLAN = "floor_plan"
SOURCE_DEVICE_ASSIGNMENT = "device_assignment"
SOURCE_BULK_ASSIGNMENT = "bulk_assignment"


class DevicePlacementService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _get_row(self, device_id: str) -> DevicePlacement:
        stmt = scoped(
            select(DevicePlacement).where(DevicePlacement.device_id == device_id),
            DevicePlacement,
            self.scope,
        )
        row = (await self.db.execute(stmt)).scalars().first()
        if row is None:
            raise NotFoundError("Device placement not found")
        assert_owned(row, self.scope, message="Device placement not found")
        return row

    # ── the things a placement names, each checked against the caller's tenant ──
    #
    # A placement joins ids from two places: a device id minted by whichever
    # service owns the device, and a site / floor / zone minted here. Only the
    # second half is ours to verify, and it is verified against the CALLER's
    # scope rather than against the row's, so a tenant cannot place a device onto
    # another tenant's building by quoting its id.

    async def _require_site(self, site_id: str) -> Site:
        site = await self.db.get(Site, site_id)
        if site is None or not site.is_active or (
            not self.scope.is_platform and site.tenant_id != self.scope.tenant_id
        ):
            raise NotFoundError("Site not found or inactive")
        return site

    async def _require_floor(self, floor_id: str, site_id: str) -> Floor:
        floor = await self.db.get(Floor, floor_id)
        if floor is None or not floor.is_active or (
            not self.scope.is_platform and floor.tenant_id != self.scope.tenant_id
        ):
            raise NotFoundError("Floor not found or inactive")
        if floor.site_id != site_id:
            raise ConflictError("site_id does not match the floor's site")
        return floor

    async def _require_zone(self, zone_id: str, site_id: str, floor_id) -> Zone:
        zone = await self.db.get(Zone, zone_id)
        if zone is None or not zone.is_active or (
            not self.scope.is_platform and zone.tenant_id != self.scope.tenant_id
        ):
            raise NotFoundError("Zone not found or inactive")
        if zone.site_id != site_id or zone.floor_id != floor_id:
            raise ConflictError(
                "zone_id does not belong to the provided site_id/floor_id"
            )
        return zone

    async def register(
        self, body: RegisterDeviceRequest, *, actor
    ) -> DevicePlacementPublic:
        if body.floor_id:
            # The floor proves the site: it carries `site_id` and is checked
            # against the caller's tenant, so a separate site lookup would only
            # re-ask a question already answered.
            await self._require_floor(body.floor_id, body.site_id)
        else:
            # No floor to prove it, so the site is checked directly. Without this
            # a site-only placement could name any string and the event would
            # carry a site name of None to a read-model that cannot look one up.
            await self._require_site(body.site_id)

        if body.zone_id:
            await self._require_zone(body.zone_id, body.site_id, body.floor_id)

        actor_user_id = str(getattr(actor, "id", "")) or None

        # Upsert-by-device_id within the tenant (v2 semantics).
        existing = (
            await self.db.execute(
                scoped(
                    select(DevicePlacement).where(
                        DevicePlacement.device_id == body.device_id
                    ),
                    DevicePlacement,
                    self.scope,
                )
            )
        ).scalars().first()

        # A position may be absent with or without a floor; it may never be
        # present WITHOUT one — `ck_device_placements_pin_is_whole`, and the
        # schema's `_pin_is_whole` before it.
        pos = body.floor_position.model_dump() if body.floor_position else None
        if existing is not None:
            existing.device_type = body.device_type
            existing.service = body.service
            existing.site_id = body.site_id
            existing.floor_id = body.floor_id
            existing.zone_id = body.zone_id
            existing.floor_position = pos
            existing.placement_metadata = body.metadata
            existing.updated_by = actor_user_id
            existing.updated_at = _utcnow()
            row = existing
            event = "placement_updated"
        else:
            row = DevicePlacement(
                tenant_id=self.scope.tenant_id,
                device_id=body.device_id,
                device_type=body.device_type,
                service=body.service,
                site_id=body.site_id,
                floor_id=body.floor_id,
                zone_id=body.zone_id,
                floor_position=pos,
                placement_metadata=body.metadata,
                created_by=actor_user_id,
                updated_by=actor_user_id,
            )
            self.db.add(row)
            event = "placed"

        await self.db.commit()
        await self.db.refresh(row)
        await self._emit(
            actor, event, row, {"floor_position": row.floor_position},
            source=SOURCE_FLOOR_PLAN,
        )
        return DevicePlacementPublic.from_row(row)

    # ── the device-first surface ─────────────────────────────────────────────
    #
    # WHY THIS IS HERE AND NOT SOMEWHERE ELSE. The fact being written is "this
    # device is in this building", and that fact already has a home, a table, a
    # tenant scope, an audit action and a domain event: this service. Putting the
    # device-first version anywhere else — an IoT module, the reporting store,
    # a second table keyed the same way — would create a SECOND WRITER of one
    # fact, which is the exact defect `app/placement_sync.py` was written to
    # remove. So the surface is new and the writer is not.
    #
    # WHAT MAKES IT DIFFERENT FROM `register`, which would otherwise do: this one
    # is allowed to leave an existing pin alone. `register` states the WHOLE
    # placement, because the floor-plan editor knows the whole placement — it is
    # holding the drawing. An operator saying "these thirty meters are in Aeon
    # Tower" is not holding thirty drawings and has said nothing about any pin,
    # so the pin is not theirs to erase.
    #
    # There is exactly one case where the pin must go, and it is not a guess: the
    # device moved to ANOTHER site. A `{x, y}` on a floor of a building the
    # device is no longer in is not a stale pin, it is a false one. That is
    # reported back per device as `pin_cleared` rather than done quietly.

    async def assign(
        self, body: AssignDevicesRequest, *, actor
    ) -> AssignDevicesResponse:
        """Assign an EXPLICIT LIST of devices to one site. Nothing is inferred.

        The list is the operator's statement. There is no predicate form of this
        call — no "every unplaced device", no "the only site there is" — because
        a selection made by a filter is the filter's assertion and this platform
        does not let one stand in for a person's.
        """
        site = await self._require_site(body.site_id)

        # Validate every floor and zone BEFORE writing anything. A bulk action
        # that half-applies leaves the operator with no way to know which half,
        # and re-running it is not a repair if the first half moved a pin.
        for item in body.devices:
            if item.floor_id:
                await self._require_floor(item.floor_id, body.site_id)
            if item.zone_id:
                await self._require_zone(item.zone_id, body.site_id, item.floor_id)

        existing = {
            row.device_id: row
            for row in (
                await self.db.execute(
                    scoped(
                        select(DevicePlacement).where(
                            DevicePlacement.device_id.in_(
                                [i.device_id for i in body.devices]
                            )
                        ),
                        DevicePlacement,
                        self.scope,
                    )
                )
            ).scalars().all()
        }

        # The other thing that has to be known before anything is written: a
        # device with no placement yet needs its two identity columns stated, and
        # discovering that halfway down the list would leave the rows already
        # added to the session with nothing sensible to do about them.
        kinds: dict[str, tuple[str, str]] = {}
        for item in body.devices:
            dtype = item.device_type or body.device_type
            svc = item.service or body.service
            if item.device_id not in existing and (not dtype or not svc):
                # Columns on the row, and not derivable from anything here. A
                # default would be this service inventing what kind of thing
                # somebody is placing.
                raise ConflictError(
                    f"{item.device_id} has no placement yet, so device_type "
                    "and service must be given (on the item or the request)"
                )
            kinds[item.device_id] = (dtype, svc)

        actor_user_id = str(getattr(actor, "id", "")) or None
        now = _utcnow()
        # (row, event, created, pin_cleared). Events are published after the single
        # commit — an event for a write that then failed to commit is a read-model
        # told about a placement that does not exist.
        pending: list[tuple[DevicePlacement, str, bool, bool]] = []

        for item in body.devices:
            device_type, service = kinds[item.device_id]
            row = existing.get(item.device_id)
            pin_cleared = False

            if row is None:
                row = DevicePlacement(
                    tenant_id=self.scope.tenant_id,
                    device_id=item.device_id,
                    device_type=device_type,
                    service=service,
                    site_id=body.site_id,
                    floor_id=item.floor_id,
                    zone_id=item.zone_id,
                    floor_position=(
                        item.floor_position.model_dump() if item.floor_position else None
                    ),
                    created_by=actor_user_id,
                    updated_by=actor_user_id,
                )
                self.db.add(row)
                created = True
                event = "placed"
            else:
                created = False
                event = "placement_updated"
                moved = row.site_id != body.site_id
                if device_type:
                    row.device_type = device_type
                if service:
                    row.service = service
                if item.floor_id:
                    # A floor may now be stated without a position (0031), so the
                    # position is not implied by the floor. What happens to an
                    # existing pin depends on whether it is still TRUE:
                    #   * a position was given — it is the pin;
                    #   * same floor, no position — the old pin stays. "It is on
                    #     Level 4" is consistent with a pin on Level 4 and says
                    #     nothing against it, so dropping it would lose a fact
                    #     nobody asked to lose;
                    #   * another floor (or another site), no position — the old
                    #     pin is coordinates on a different drawing, i.e. false.
                    #     It goes, and `pin_cleared` says so.
                    if item.floor_position is not None:
                        row.floor_position = item.floor_position.model_dump()
                    elif moved or item.floor_id != row.floor_id:
                        pin_cleared = row.floor_position is not None
                        row.floor_position = None
                    row.floor_id = item.floor_id
                    row.zone_id = item.zone_id
                elif moved:
                    # The pin belonged to the site it is leaving.
                    pin_cleared = row.floor_id is not None
                    row.floor_id = None
                    row.floor_position = None
                    row.zone_id = None
                row.site_id = body.site_id
                row.updated_by = actor_user_id
                row.updated_at = now

            pending.append((row, event, created, pin_cleared))

        # FLUSH before reading `placement_id` back: it is generated python-side at
        # insert time, so a row that has only been `add`ed still has None for it
        # and the caller would be handed a placement it cannot address.
        await self.db.flush()
        results = [
            AssignedDevice(
                device_id=row.device_id,
                placement_id=row.placement_id,
                site_id=row.site_id,
                floor_id=row.floor_id,
                created=created,
                pin_cleared=pin_cleared,
            )
            for row, _event, created, pin_cleared in pending
        ]
        await self.db.commit()

        # One event per device, because the mirror places devices one at a time
        # and a batched event would make it guess which devices a partial failure
        # had covered.
        source = (
            SOURCE_DEVICE_ASSIGNMENT
            if len(body.devices) == 1
            else SOURCE_BULK_ASSIGNMENT
        )
        for row, event, _created, _pin_cleared in pending:
            await self.db.refresh(row)
            await self._emit(
                actor, event, row, {"site_id": row.site_id}, source=source, audit=False
            )

        # ONE audit row for one operator action, naming exactly what was chosen.
        # The list IS the assertion, so the list is what is kept.
        await audit_record(
            self.db,
            actor=actor,
            action="device_placement.assigned",
            target_type="site",
            target_id=body.site_id,
            meta={
                "site_id": body.site_id,
                "source": source,
                "device_ids": [i.device_id for i in body.devices],
                "count": len(body.devices),
            },
        )
        return AssignDevicesResponse(
            site_id=body.site_id,
            site_name=site.name,
            assigned=len(results),
            items=results,
        )

    async def get(self, device_id: str) -> DevicePlacementPublic:
        row = await self._get_row(device_id)
        return DevicePlacementPublic.from_row(row)

    async def update(
        self, device_id: str, body: UpdateDeviceRequest, *, actor
    ) -> DevicePlacementPublic:
        row = await self._get_row(device_id)

        # If zone_id is being (re)set, validate it belongs to the row's site+floor.
        update = body.model_dump(exclude_unset=True)
        if body.zone_id:
            zone = await self.db.get(Zone, body.zone_id)
            if zone is None or not zone.is_active or (
                not self.scope.is_platform and zone.tenant_id != self.scope.tenant_id
            ):
                raise NotFoundError("Zone not found or inactive")
            if zone.site_id != row.site_id or zone.floor_id != row.floor_id:
                raise ConflictError(
                    "zone_id does not belong to the device's site_id/floor_id"
                )

        if "floor_position" in update and body.floor_position is not None:
            row.floor_position = body.floor_position.model_dump()
        if "zone_id" in update:
            row.zone_id = body.zone_id
        if "metadata" in update:
            row.placement_metadata = body.metadata

        actor_user_id = str(getattr(actor, "id", "")) or None
        if actor_user_id:
            row.updated_by = actor_user_id
        row.updated_at = _utcnow()

        await self.db.commit()
        await self.db.refresh(row)
        await self._emit(
            actor, "placement_updated", row, update, source=SOURCE_FLOOR_PLAN
        )
        return DevicePlacementPublic.from_row(row)

    async def remove(self, device_id: str, *, actor) -> None:
        row = await self._get_row(device_id)
        # Read what the event needs before the delete; afterwards the row is gone
        # and the consumer learns only that some device was unplaced.
        placement_id = row.placement_id
        gone = {
            "device_id": row.device_id,
            "device_type": row.device_type,
            "service": row.service,
            "site_id": row.site_id,
            "floor_id": row.floor_id,
            "zone_id": row.zone_id,
            "tenant_id": row.tenant_id,
        }
        await self.db.execute(
            sa_delete(DevicePlacement).where(
                DevicePlacement.placement_id == placement_id
            )
        )
        await self.db.commit()
        # No source on a removal: the mirror deletes the row whichever surface
        # the placement was originally made through, and claiming the deleting
        # surface as its provenance would overwrite the true one on the way out.
        await self._emit_ids(actor, "placement_removed", **gone, changed={}, source=None)

    async def list_by_floor(
        self, floor_id: str, *, device_type: str | None = None
    ) -> list[DevicePlacementPublic]:
        stmt = scoped(
            select(DevicePlacement).where(DevicePlacement.floor_id == floor_id),
            DevicePlacement,
            self.scope,
        )
        if device_type:
            stmt = stmt.where(DevicePlacement.device_type == device_type)
        stmt = stmt.order_by(DevicePlacement.created_at.desc())
        rows = (await self.db.execute(stmt)).scalars().all()
        return [DevicePlacementPublic.from_row(r) for r in rows]

    async def estate_index(self, *, limit: int = 5000) -> list[dict]:
        """Every placement in the tenant as {device_id, device_type, site_id}.

        The map needs to answer "how many cameras are at this site, and which
        ones" for EVERY site at once. The by-floor/by-zone routes cannot: a
        campus with forty floors is forty round trips, and the caller does not
        know the floors until it has fetched them.

        Deliberately four columns, not the full placement: the map joins on the
        device id and counts by type, and the floor-plan coordinates that make up
        most of a placement row mean nothing on a geographic map.
        """
        stmt = scoped(
            select(
                DevicePlacement.device_id,
                DevicePlacement.device_type,
                DevicePlacement.site_id,
                DevicePlacement.floor_id,
            ),
            DevicePlacement,
            self.scope,
        ).order_by(DevicePlacement.created_at.desc()).limit(limit)
        rows = (await self.db.execute(stmt)).all()
        return [
            {
                "device_id": r.device_id,
                "device_type": r.device_type,
                "site_id": r.site_id,
                "floor_id": r.floor_id,
            }
            for r in rows
        ]

    async def list_by_zone(self, zone_id: str) -> list[DevicePlacementPublic]:
        stmt = scoped(
            select(DevicePlacement).where(DevicePlacement.zone_id == zone_id),
            DevicePlacement,
            self.scope,
        ).order_by(DevicePlacement.created_at.desc())
        rows = (await self.db.execute(stmt)).scalars().all()
        return [DevicePlacementPublic.from_row(r) for r in rows]

    # ── events ───────────────────────────────────────────────────────────────
    #
    # A placement event is all a consumer gets, so it carries the whole fact
    # rather than a diff: which device, of what kind, in which service, and the
    # site / floor / zone it now sits in, ids and names. Names are read from
    # core's own rows here — they come from core, never from the browser.
    #
    # `changed` is the caller's diff, for the audit log only. A consumer reading
    # it instead of the canonical fields breaks as soon as a PATCH touches one
    # field, which is what `update` sends.

    async def _location_names(self, site_id, floor_id, zone_id) -> dict:
        site = await self.db.get(Site, site_id) if site_id else None
        floor = await self.db.get(Floor, floor_id) if floor_id else None
        zone = await self.db.get(Zone, zone_id) if zone_id else None
        return {
            "site_name": getattr(site, "name", None),
            "floor_name": getattr(floor, "name", None),
            "zone_name": getattr(zone, "name", None),
        }

    async def _emit(
        self,
        actor,
        event: str,
        row: DevicePlacement,
        changed: dict,
        *,
        source: str | None,
        audit: bool = True,
    ) -> None:
        await self._emit_ids(
            actor,
            event,
            source=source,
            audit=audit,
            device_id=row.device_id,
            device_type=row.device_type,
            service=row.service,
            site_id=row.site_id,
            floor_id=row.floor_id,
            zone_id=row.zone_id,
            tenant_id=row.tenant_id,
            changed=changed,
        )

    async def _emit_ids(
        self,
        actor,
        event,
        *,
        device_id,
        device_type,
        service,
        site_id,
        floor_id,
        zone_id,
        tenant_id,
        changed,
        source: str | None = None,
        audit: bool = True,
    ) -> None:
        names = await self._location_names(site_id, floor_id, zone_id)
        await emit(
            tenant_id,
            "device_placement",
            event,
            {
                "device_id": device_id,
                "device_type": device_type,
                "service": service,
                "site_id": site_id,
                "floor_id": floor_id,
                "zone_id": zone_id,
                **names,
                # Who asserted it, so a consumer keeping its own copy records the
                # same author rather than an anonymous system write.
                "actor_id": str(getattr(actor, "id", "")) or None,
                # Which surface this was typed on, for the mirror's
                # `device_locations.source`. A consumer that has never heard of
                # the value must fall back rather than store an unknown one.
                "source": source,
                "changed": changed,
            },
        )
        if not audit:
            # A bulk assignment is ONE operator action over an explicit list, and
            # it is recorded as one row naming that list (see `assign`). Writing
            # a row per device would turn one decision into five hundred entries
            # and lose the only thing worth knowing about it: what was selected.
            return
        await audit_record(
            self.db,
            actor=actor,
            action=f"device_placement.{event}",
            target_type="device_placement",
            target_id=device_id,
            meta={"site_id": site_id, **changed},
        )
