"""Infrastructure service — a site's systems, equipment and point slots.

Tenant-scoped the way every sites service is: rows are stamped with the caller's
``tenant_id``, by-id fetches go through ``assert_owned``, and a row from another
tenant is reported missing rather than forbidden. On top of that, every call
starts from the SITE in the URL and resolves it through ``SiteService._get_row``,
so a user confined to some sites (``User.site_ids``) cannot read or edit the
registry of one they cannot see, and the confinement rule lives in one place.

WHAT IS PUBLISHED
-----------------
Every write publishes on the sites spine (``events.py``), after commit:

  * ``tenant.<t>.sites.site_system.<created|updated|deleted>``
  * ``tenant.<t>.sites.equipment.<created|updated|design_updated|slot_set|
    slot_removed|deleted>``

An equipment event other than ``deleted`` carries the WHOLE equipment — its
system, class, design facts with their units, and every slot with its binding —
read back from the rows just committed. That is ``site_facts_sync``'s rule: a
mirror that misses one message is corrected by the next edit of any kind, so it
can treat every non-delete as an upsert and never has to replay a diff. Deleting
a system publishes ``equipment.deleted`` for each piece of equipment it held
before its own ``site_system.deleted``, so a mirror that only listens to
equipment still removes them.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete as sa_delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.audit import record as audit_record
from ...core.errors import ConflictError, NotFoundError, ValidationError
from ...tenancy.scope import Scope, assert_owned
from ..events import emit
from ..mutation import apply_update
from ..site.models import Site
from ..site.service import SiteService
from . import vocabulary as vocab
from .models import EquipmentPointSlot, SiteEquipment, SiteSystem
from .schemas import (
    CreateEquipmentRequest,
    CreateSystemRequest,
    DesignUpdate,
    EquipmentPublic,
    InfrastructureTree,
    PointBinding,
    SlotPublic,
    SystemPublic,
    SystemWithEquipment,
    UpdateEquipmentRequest,
    UpdateSystemRequest,
)

#: Which surface a write came through, carried on every equipment event. Not a
#: confidence — both are a human's statement — but the question asked first when
#: a registry entry turns out wrong is "who typed this, and where".
SOURCE_DESIGNER = "designer"
SOURCE_SCHEDULE_IMPORT = "schedule_import"
#: A restatement, not a write. Core does not store which door each write came
#: through — `source` is provenance of the MESSAGE — so a republished equipment
#: says what it truthfully is rather than guessing at the original surface.
SOURCE_RESYNC = "resync"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    return str(getattr(actor, "id", "")) or None


class InfrastructureService:
    def __init__(self, db: AsyncSession, scope: Scope, site_ids: list[str] | None = None) -> None:
        self.db = db
        self.scope = scope
        self._sites = SiteService(db, scope, site_ids=site_ids)

    # ── resolution: site → system → equipment, each checked ──────────────────

    async def site(self, site_id: str, *, for_write: bool = False) -> Site:
        """The site in the URL, through SiteService's tenant AND site-scope check.

        A write also needs the site to be active: equipment added to a
        soft-deleted building would reappear, unasked, when it is restored.
        """
        row = await self._sites._get_row(site_id)
        if for_write and not row.is_active:
            raise NotFoundError("Site not found or inactive")
        return row

    async def _system(self, site_id: str, system_id: str) -> SiteSystem:
        row = await self.db.get(SiteSystem, system_id)
        assert_owned(row, self.scope, message="System not found")
        if row.site_id != site_id:
            raise NotFoundError("System not found")
        return row

    async def _equipment(self, site_id: str, equipment_id: str) -> SiteEquipment:
        row = await self.db.get(SiteEquipment, equipment_id)
        assert_owned(row, self.scope, message="Equipment not found")
        if row.site_id != site_id:
            raise NotFoundError("Equipment not found")
        return row

    #: A chain deeper than this is not a building's power distribution; it is a
    #: loop that the walk below would otherwise follow for ever.
    FEED_DEPTH_MAX = 32

    async def _check_feed(self, site_id: str, equipment_id: str | None, fed_by_id: str) -> None:
        """Refuse a parent that would make the power chain a lie.

        The parent must be equipment on THIS site (another site's incomer does
        not feed this building's board, and another tenant's is not even
        visible), must not be the equipment itself, and must not sit BELOW it —
        A fed by B fed by A is a loop no single-line can draw.
        """
        if equipment_id is not None and fed_by_id == equipment_id:
            raise ValidationError("A piece of equipment cannot feed itself")
        parent = await self.db.get(SiteEquipment, fed_by_id)
        if parent is None or parent.site_id != site_id or (
            self.scope.tenant_id is not None and parent.tenant_id != self.scope.tenant_id
        ):
            raise ValidationError("The equipment named as its feed is not on this site")
        if equipment_id is None:
            return  # a new row has no children yet, so it cannot close a loop
        seen: set[str] = set()
        cur: SiteEquipment | None = parent
        for _ in range(self.FEED_DEPTH_MAX):
            if cur is None or cur.fed_by_id is None:
                return
            if cur.fed_by_id == equipment_id:
                raise ValidationError(
                    f"{parent.tag} is already fed, further up, by this equipment — "
                    "that would make a loop"
                )
            if cur.fed_by_id in seen:
                return  # an existing loop elsewhere is not this write's to report
            seen.add(cur.fed_by_id)
            cur = await self.db.get(SiteEquipment, cur.fed_by_id)
        raise ValidationError("The feed chain above this equipment is too deep to follow")

    async def _unhook_children(self, parent_ids: list[str]) -> list[SiteEquipment]:
        """Clear `fed_by_id` on everything fed by these, and return what changed.

        The foreign key would SET NULL on its own, but silently: no event, so the
        reporting mirror would keep boards pointing at a feeder that no longer
        exists and the single-line would draw a ghost. Clearing it HERE, in the
        same transaction, lets the caller publish each board it unhooked.
        Equipment that is itself being deleted is left out — it is published as
        deleted, not as unhooked.
        """
        if not parent_ids:
            return []
        rows = (
            await self.db.execute(
                select(SiteEquipment).where(
                    SiteEquipment.fed_by_id.in_(parent_ids),
                    SiteEquipment.equipment_id.not_in(parent_ids),
                )
            )
        ).scalars().all()
        for r in rows:
            r.fed_by_id = None
            r.updated_at = _utcnow()
        return list(rows)

    async def _slots(self, equipment_id: str) -> list[EquipmentPointSlot]:
        return list(
            (
                await self.db.execute(
                    select(EquipmentPointSlot)
                    .where(EquipmentPointSlot.equipment_id == equipment_id)
                    .order_by(EquipmentPointSlot.slot.asc())
                )
            )
            .scalars()
            .all()
        )

    async def _public(self, row: SiteEquipment) -> EquipmentPublic:
        design = dict(row.design or {})
        return EquipmentPublic(
            equipment_id=row.equipment_id,
            site_id=row.site_id,
            system_id=row.system_id,
            tag=row.tag,
            name=row.name,
            equipment_class=row.equipment_class,
            fed_by_id=row.fed_by_id,
            design=design,
            design_units=vocab.units_of(design),
            slots=[SlotPublic.from_row(s) for s in await self._slots(row.equipment_id)],
            created_at=row.created_at,
            updated_at=row.updated_at,
        )

    # ── the uniqueness a human would otherwise discover in a traceback ──────

    async def _require_free_system_name(self, site_id: str, name: str, *, but: str | None = None):
        stmt = select(SiteSystem.system_id).where(
            SiteSystem.site_id == site_id, SiteSystem.name == name
        )
        found = (await self.db.execute(stmt)).scalars().first()
        if found is not None and found != but:
            raise ConflictError(f"this site already has a system named {name!r}")

    async def _require_free_tag(self, site_id: str, tag: str, *, but: str | None = None):
        stmt = select(SiteEquipment.equipment_id).where(
            SiteEquipment.site_id == site_id, SiteEquipment.tag == tag
        )
        found = (await self.db.execute(stmt)).scalars().first()
        if found is not None and found != but:
            raise ConflictError(f"this site already has equipment tagged {tag!r}")

    async def binding_owner(
        self, tenant_id, device_tag: str, point_tag: str
    ) -> tuple[str, str, str] | None:
        """(equipment_id, equipment tag, slot) already holding this point, if any.

        Scoped by the tenant the ROW will carry, which is the tenant the unique
        constraint is scoped by — another tenant may well have a gateway that
        spells its tags the same way.
        """
        stmt = (
            select(EquipmentPointSlot.equipment_id, SiteEquipment.tag, EquipmentPointSlot.slot)
            .join(SiteEquipment, SiteEquipment.equipment_id == EquipmentPointSlot.equipment_id)
            .where(
                EquipmentPointSlot.device_tag == device_tag,
                EquipmentPointSlot.point_tag == point_tag,
            )
        )
        stmt = stmt.where(
            EquipmentPointSlot.tenant_id.is_(None)
            if tenant_id is None
            else EquipmentPointSlot.tenant_id == tenant_id
        )
        row = (await self.db.execute(stmt)).first()
        return (row[0], row[1], row[2]) if row else None

    async def _require_free_binding(
        self, tenant_id, binding: PointBinding, *, equipment_id: str, slot: str
    ) -> None:
        if binding.device_tag is None:
            return
        owner = await self.binding_owner(tenant_id, binding.device_tag, binding.point_tag)
        if owner is not None and (owner[0], owner[2]) != (equipment_id, slot):
            raise ConflictError(
                f"point {binding.device_tag} / {binding.point_tag} is already bound to "
                f"{owner[1]}.{owner[2]}; a point feeds one slot, or it is counted twice"
            )

    async def _commit(self) -> None:
        """Commit, turning a lost race on a unique constraint into a 409.

        The explicit checks above answer every sequential case with a sentence;
        this is only the two-requests-at-once case, and it must not be a 500.
        """
        try:
            await self.db.commit()
        except IntegrityError as exc:
            await self.db.rollback()
            raise ConflictError(
                "the registry changed underneath this request; reload and retry"
            ) from exc

    # ── read ────────────────────────────────────────────────────────────────

    async def tree(self, site_id: str) -> InfrastructureTree:
        await self.site(site_id)
        systems = (
            await self.db.execute(
                select(SiteSystem)
                .where(SiteSystem.site_id == site_id)
                .order_by(SiteSystem.name.asc())
            )
        ).scalars().all()
        equipment = (
            await self.db.execute(
                select(SiteEquipment)
                .where(SiteEquipment.site_id == site_id)
                .order_by(SiteEquipment.tag.asc())
            )
        ).scalars().all()
        by_system: dict[str, list[EquipmentPublic]] = {}
        for e in equipment:
            by_system.setdefault(e.system_id, []).append(await self._public(e))
        return InfrastructureTree(
            site_id=site_id,
            systems=[
                SystemWithEquipment(
                    **SystemPublic.from_row(s).model_dump(),
                    equipment=by_system.get(s.system_id, []),
                )
                for s in systems
            ],
        )

    async def get_equipment(self, site_id: str, equipment_id: str) -> EquipmentPublic:
        await self.site(site_id)
        return await self._public(await self._equipment(site_id, equipment_id))

    # ── systems ─────────────────────────────────────────────────────────────

    async def create_system(self, site_id: str, body: CreateSystemRequest, *, actor) -> SystemPublic:
        site = await self.site(site_id, for_write=True)
        await self._require_free_system_name(site_id, body.name)
        who = _actor_id(actor)
        row = SiteSystem(
            tenant_id=site.tenant_id,
            site_id=site_id,
            name=body.name,
            kind=body.kind,
            description=body.description,
            created_by=who,
            updated_by=who,
        )
        self.db.add(row)
        await self._commit()
        await self.db.refresh(row)
        await self._emit_system(actor, "created", row)
        return SystemPublic.from_row(row)

    async def update_system(
        self, site_id: str, system_id: str, body: UpdateSystemRequest, *, actor
    ) -> SystemPublic:
        await self.site(site_id, for_write=True)
        row = await self._system(site_id, system_id)
        update = body.model_dump(exclude_none=True)
        if "name" in update:
            await self._require_free_system_name(site_id, update["name"], but=system_id)
        update["updated_by"] = _actor_id(actor)
        update["updated_at"] = _utcnow()
        apply_update(row, update)
        await self._commit()
        await self.db.refresh(row)
        await self._emit_system(actor, "updated", row)
        return SystemPublic.from_row(row)

    async def delete_system(self, site_id: str, system_id: str, *, actor) -> None:
        """Delete a system AND everything in it.

        Not refused when non-empty: the designer's "delete Plant B" means the plant,
        and making the operator empty it first is a chore, not a safeguard. What
        keeps it honest is that every piece of equipment removed is published and
        named in the audit entry.
        """
        await self.site(site_id, for_write=True)
        row = await self._system(site_id, system_id)
        doomed = (
            await self.db.execute(
                select(SiteEquipment).where(SiteEquipment.system_id == system_id)
            )
        ).scalars().all()
        gone = [(e.equipment_id, e.tag) for e in doomed]
        ids = [e for e, _ in gone]
        orphans = await self._unhook_children(ids)
        if ids:
            await self.db.execute(
                sa_delete(EquipmentPointSlot).where(EquipmentPointSlot.equipment_id.in_(ids))
            )
            await self.db.execute(
                sa_delete(SiteEquipment).where(SiteEquipment.equipment_id.in_(ids))
            )
        tenant_id, name, kind = row.tenant_id, row.name, row.kind
        await self.db.execute(sa_delete(SiteSystem).where(SiteSystem.system_id == system_id))
        await self._commit()
        # Boards in OTHER systems that hung off something in this one.
        for child in orphans:
            await self.db.refresh(child)
            await self._emit_equipment(actor, "updated", child)
        for equipment_id, tag in gone:
            await emit(
                tenant_id,
                "equipment",
                "deleted",
                {"site_id": site_id, "system_id": system_id,
                 "equipment_id": equipment_id, "tag": tag},
            )
        await emit(
            tenant_id,
            "site_system",
            "deleted",
            {"site_id": site_id, "system_id": system_id, "name": name, "kind": kind,
             "equipment_ids": ids},
        )
        await audit_record(
            self.db, actor=actor, action="site_system.deleted", target_type="site_system",
            target_id=system_id,
            meta={"site_id": site_id, "name": name, "equipment_tags": [t for _, t in gone]},
        )

    # ── equipment ───────────────────────────────────────────────────────────

    async def create_equipment(
        self, site_id: str, body: CreateEquipmentRequest, *, actor
    ) -> EquipmentPublic:
        site = await self.site(site_id, for_write=True)
        system = await self._system(site_id, body.system_id)
        try:
            vocab.check_class_in_kind(body.equipment_class, system.kind)
        except ValueError as exc:
            raise ValidationError(str(exc)) from exc
        await self._require_free_tag(site_id, body.tag)
        if body.fed_by_id:
            await self._check_feed(site_id, None, body.fed_by_id)

        who = _actor_id(actor)
        row = SiteEquipment(
            tenant_id=site.tenant_id,
            site_id=site_id,
            system_id=system.system_id,
            tag=body.tag,
            name=body.name,
            equipment_class=body.equipment_class,
            fed_by_id=body.fed_by_id or None,
            design=body.design,
            created_by=who,
            updated_by=who,
        )
        self.db.add(row)
        await self.db.flush()
        for s in body.slots:
            await self._require_free_binding(
                site.tenant_id, s, equipment_id=row.equipment_id, slot=s.slot
            )
            self.db.add(
                EquipmentPointSlot(
                    tenant_id=site.tenant_id,
                    site_id=site_id,
                    equipment_id=row.equipment_id,
                    slot=s.slot,
                    device_tag=s.device_tag,
                    point_tag=s.point_tag,
                    created_by=who,
                    updated_by=who,
                )
            )
        await self._commit()
        await self.db.refresh(row)
        return await self._emit_equipment(actor, "created", row, system)

    async def update_equipment(
        self, site_id: str, equipment_id: str, body: UpdateEquipmentRequest, *, actor
    ) -> EquipmentPublic:
        await self.site(site_id, for_write=True)
        row = await self._equipment(site_id, equipment_id)
        update = body.model_dump(exclude_none=True)
        # `fed_by_id: null` is an instruction ("unhook it"), so it is read from the
        # fields that were SENT, not from the ones that happen to be non-null.
        update.pop("fed_by_id", None)
        if "fed_by_id" in body.model_fields_set:
            if body.fed_by_id:
                await self._check_feed(site_id, equipment_id, body.fed_by_id)
            update["fed_by_id"] = body.fed_by_id or None
        if "tag" in update:
            await self._require_free_tag(site_id, update["tag"], but=equipment_id)
        allow: frozenset[str] = frozenset()
        if "system_id" in update and update["system_id"] != row.system_id:
            # A move, vetted here: same site (``_system`` 404s otherwise), and a
            # kind the class is allowed in. `system_id` is re-permitted to
            # apply_update only after both hold.
            target = await self._system(site_id, update["system_id"])
            try:
                vocab.check_class_in_kind(row.equipment_class, target.kind)
            except ValueError as exc:
                raise ValidationError(str(exc)) from exc
            allow = frozenset({"system_id"})
        else:
            update.pop("system_id", None)
        update["updated_by"] = _actor_id(actor)
        update["updated_at"] = _utcnow()
        apply_update(row, update, allow=allow)
        await self._commit()
        await self.db.refresh(row)
        return await self._emit_equipment(actor, "updated", row)

    async def set_design(
        self, site_id: str, equipment_id: str, body: DesignUpdate, *, actor
    ) -> EquipmentPublic:
        await self.site(site_id, for_write=True)
        row = await self._equipment(site_id, equipment_id)
        try:
            design = vocab.check_design(row.equipment_class, body.design)
        except ValueError as exc:
            raise ValidationError(str(exc)) from exc
        row.design = design
        row.updated_by = _actor_id(actor)
        row.updated_at = _utcnow()
        await self._commit()
        await self.db.refresh(row)
        return await self._emit_equipment(actor, "design_updated", row)

    async def set_slot(
        self, site_id: str, equipment_id: str, slot: str, body: PointBinding, *, actor
    ) -> EquipmentPublic:
        """Create the slot if it is not there, and bind it — or unbind it, when
        both tags are null. An unbound slot is a real statement: the schedule
        says this chiller has a CHWS sensor, and nobody has said which point it is."""
        await self.site(site_id, for_write=True)
        row = await self._equipment(site_id, equipment_id)
        try:
            vocab.check_slot(row.equipment_class, slot)
        except ValueError as exc:
            raise ValidationError(str(exc)) from exc
        await self._require_free_binding(
            row.tenant_id, body, equipment_id=equipment_id, slot=slot
        )
        who = _actor_id(actor)
        existing = (
            await self.db.execute(
                select(EquipmentPointSlot).where(
                    EquipmentPointSlot.equipment_id == equipment_id,
                    EquipmentPointSlot.slot == slot,
                )
            )
        ).scalars().first()
        if existing is None:
            self.db.add(
                EquipmentPointSlot(
                    tenant_id=row.tenant_id,
                    site_id=site_id,
                    equipment_id=equipment_id,
                    slot=slot,
                    device_tag=body.device_tag,
                    point_tag=body.point_tag,
                    created_by=who,
                    updated_by=who,
                )
            )
        else:
            existing.device_tag = body.device_tag
            existing.point_tag = body.point_tag
            existing.updated_by = who
            existing.updated_at = _utcnow()
        row.updated_at = _utcnow()
        await self._commit()
        await self.db.refresh(row)
        return await self._emit_equipment(actor, "slot_set", row, extra={"slot": slot})

    async def remove_slot(
        self, site_id: str, equipment_id: str, slot: str, *, actor
    ) -> EquipmentPublic:
        await self.site(site_id, for_write=True)
        row = await self._equipment(site_id, equipment_id)
        result = await self.db.execute(
            sa_delete(EquipmentPointSlot).where(
                EquipmentPointSlot.equipment_id == equipment_id,
                EquipmentPointSlot.slot == slot,
            )
        )
        if not result.rowcount:
            raise NotFoundError("Slot not found")
        row.updated_at = _utcnow()
        await self._commit()
        await self.db.refresh(row)
        return await self._emit_equipment(actor, "slot_removed", row, extra={"slot": slot})

    async def delete_equipment(self, site_id: str, equipment_id: str, *, actor) -> None:
        await self.site(site_id, for_write=True)
        row = await self._equipment(site_id, equipment_id)
        tenant_id, system_id, tag = row.tenant_id, row.system_id, row.tag
        orphans = await self._unhook_children([equipment_id])
        await self.db.execute(
            sa_delete(EquipmentPointSlot).where(EquipmentPointSlot.equipment_id == equipment_id)
        )
        await self.db.execute(
            sa_delete(SiteEquipment).where(SiteEquipment.equipment_id == equipment_id)
        )
        await self._commit()
        # Its children first, so a mirror never holds a board fed by a feeder it
        # has already been told is gone.
        for child in orphans:
            await self.db.refresh(child)
            await self._emit_equipment(actor, "updated", child)
        await emit(
            tenant_id,
            "equipment",
            "deleted",
            {"site_id": site_id, "system_id": system_id, "equipment_id": equipment_id,
             "tag": tag},
        )
        await audit_record(
            self.db, actor=actor, action="equipment.deleted", target_type="equipment",
            target_id=equipment_id, meta={"site_id": site_id, "tag": tag},
        )

    # ── republish ───────────────────────────────────────────────────────────

    async def republish(self, site_id: str, *, actor) -> dict:
        """Restate this site's whole registry on the spine, for a mirror to heal from.

        WHY THIS EXISTS. Every write is published once, and a consumer that was
        down longer than the stream's retention never sees those messages again.
        The reporting mirror (`reading-writer/app/equipment_sync.py`) then holds a
        registry that is silently stale — a chiller with no recorded ΔT band reads
        exactly like one whose band was never entered, and the metric refuses for
        the wrong reason.

        So: `resynced` for every system and every piece of equipment, carrying the
        same whole-entity snapshot every other event carries, then ONE
        `site_system.reconciled` naming every id this site really has. The
        restatements heal what went missing; the reconcile removes what the mirror
        kept and core no longer has — a delete whose event aged out is the one
        damage a restatement cannot repair.

        The order is the publish order, on one subject family with one durable
        behind it, so the reconcile cannot overtake the restatements it bounds.

        Nothing is written here. This is core saying again what core already says.
        """
        await self.site(site_id)
        systems = (
            await self.db.execute(
                select(SiteSystem).where(SiteSystem.site_id == site_id)
                .order_by(SiteSystem.name.asc())
            )
        ).scalars().all()
        equipment = (
            await self.db.execute(
                select(SiteEquipment).where(SiteEquipment.site_id == site_id)
                .order_by(SiteEquipment.tag.asc())
            )
        ).scalars().all()
        by_id = {s.system_id: s for s in systems}

        for row in systems:
            await self._emit_system(None, "resynced", row, audit=False)
        for row in equipment:
            snap = await self.equipment_snapshot(row, by_id.get(row.system_id))
            await emit(row.tenant_id, "equipment", "resynced", {**snap, "source": SOURCE_RESYNC})

        await emit(self.scope.tenant_id, "site_system", "reconciled", {
            "site_id": site_id,
            "system_ids": [s.system_id for s in systems],
            "equipment_ids": [e.equipment_id for e in equipment],
        })
        # One audit line for the whole restatement: it is one operator action, and
        # a line per machine would bury the rest of the site's history.
        await audit_record(
            self.db, actor=actor, action="infrastructure.republished", target_type="site",
            target_id=site_id,
            meta={"systems": len(systems), "equipment": len(equipment)},
        )
        return {"site_id": site_id, "systems": len(systems), "equipment": len(equipment)}

    # ── events ──────────────────────────────────────────────────────────────

    async def _emit_system(self, actor, event: str, row: SiteSystem, *, audit: bool = True) -> None:
        payload = {
            "site_id": row.site_id,
            "system_id": row.system_id,
            "name": row.name,
            "kind": row.kind,
            "description": row.description,
        }
        await emit(row.tenant_id, "site_system", event, payload)
        if not audit:
            return
        await audit_record(
            self.db, actor=actor, action=f"site_system.{event}", target_type="site_system",
            target_id=row.system_id, meta=payload,
        )

    async def equipment_snapshot(
        self, row: SiteEquipment, system: SiteSystem | None = None
    ) -> dict[str, Any]:
        """The whole equipment, as published. Read from committed rows."""
        if system is None:
            system = await self.db.get(SiteSystem, row.system_id)
        design = dict(row.design or {})
        return {
            "site_id": row.site_id,
            "system_id": row.system_id,
            "system_name": system.name if system else None,
            "system_kind": system.kind if system else None,
            "equipment_id": row.equipment_id,
            "tag": row.tag,
            "name": row.name,
            "equipment_class": row.equipment_class,
            "fed_by_id": row.fed_by_id,
            "design": design,
            "design_units": vocab.units_of(design),
            "slots": [
                {"slot": s.slot, "device_tag": s.device_tag, "point_tag": s.point_tag}
                for s in await self._slots(row.equipment_id)
            ],
        }

    async def _emit_equipment(
        self,
        actor,
        event: str,
        row: SiteEquipment,
        system: SiteSystem | None = None,
        *,
        extra: dict | None = None,
        source: str = SOURCE_DESIGNER,
    ) -> EquipmentPublic:
        snap = await self.equipment_snapshot(row, system)
        await emit(row.tenant_id, "equipment", event, {**snap, **(extra or {}), "source": source})
        await audit_record(
            self.db, actor=actor, action=f"equipment.{event}", target_type="equipment",
            target_id=row.equipment_id,
            meta={"site_id": row.site_id, "tag": row.tag, **(extra or {}), "source": source},
        )
        return await self._public(row)
