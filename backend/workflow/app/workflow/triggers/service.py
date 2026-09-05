"""Trigger / alert-format / simulator services — what turns an event into an incident.

``SimulatorService`` reaches into ``correlation.engine`` for the SAME
match-and-create helpers the live NATS consumer uses, so a dry run cannot drift
from what actually happens. That import is deliberately made inside the method:
the correlation engine imports these models, and a module-level import here would
close the loop.
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, owns, scoped
from kernel.errors import ConflictError

from ..core.actor import actor_id as _actor_id
from ..core.enums import InstancePriority, InstanceStatus
from ..core.matching import matches_conditions
from ..core.primitives import utcnow
from ..core.references import ChecksReferences
from ..runtime.events import emit
from ..sops.models import SOP
from .models import AlertFormat, Trigger


# ── Trigger ────────────────────────────────────────────────────────────


class TriggerService(ChecksReferences):
    # A trigger names the SOP it starts. Checked on EVERY write path, not just
    # create — see ``core.references``.
    REFERENCES = {"sop_id": (SOP, "SOP not found")}

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _row(self, trigger_id: str) -> Trigger:
        row = await self.db.get(Trigger, trigger_id)
        assert_owned(row, self.scope, message="Trigger not found")
        return row

    async def create(self, body, *, actor) -> Trigger:
        await self._check_references(body.model_dump())
        row = Trigger(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            description=body.description,
            sop_id=body.sop_id,
            event_source=body.event_source,
            event_type=body.event_type or "",
            conditions=[c.model_dump(mode="json") for c in body.conditions],
            dedup=body.dedup.model_dump(mode="json"),
            priority=body.priority.value,
            auto_assign=body.auto_assign,
            assign_users=list(body.assign_users),
            enabled=body.enabled,
            created_by=_actor_id(actor),
            updated_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        await emit(row.tenant_id, "trigger", "created", {"trigger_id": row.trigger_id})
        return row

    async def list_(self, *, skip=0, limit=50, enabled=None, event_type=None):
        stmt = scoped(select(Trigger), Trigger, self.scope)
        count = scoped(select(func.count()).select_from(Trigger), Trigger, self.scope)
        if enabled is not None:
            stmt = stmt.where(Trigger.enabled.is_(enabled))
            count = count.where(Trigger.enabled.is_(enabled))
        if event_type:
            stmt = stmt.where(Trigger.event_type == event_type)
            count = count.where(Trigger.event_type == event_type)
        stmt = stmt.order_by(Trigger.created_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count) or 0)
        return rows, total

    async def get(self, trigger_id: str) -> Trigger:
        return await self._row(trigger_id)

    async def update(self, trigger_id: str, body, *, actor) -> Trigger:
        row = await self._row(trigger_id)
        data = body.model_dump(exclude_none=True)
        await self._check_references(data)
        if "priority" in data:
            data["priority"] = body.priority.value
        if "conditions" in data and body.conditions is not None:
            data["conditions"] = [c.model_dump(mode="json") for c in body.conditions]
        if "dedup" in data and body.dedup is not None:
            data["dedup"] = body.dedup.model_dump(mode="json")
        for k, v in data.items():
            setattr(row, k, v)
        row.updated_by = _actor_id(actor)
        row.updated_at = utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        await emit(row.tenant_id, "trigger", "updated", {"trigger_id": row.trigger_id})
        return row

    async def delete(self, trigger_id: str) -> None:
        row = await self._row(trigger_id)
        await self.db.delete(row)
        await self.db.commit()
        await emit(self.scope.tenant_id, "trigger", "deleted", {"trigger_id": trigger_id})

    async def set_enabled(self, trigger_id: str, enabled: bool, *, actor) -> Trigger:
        """Flip a trigger's ``enabled`` flag (enable/disable endpoints)."""
        row = await self._row(trigger_id)
        row.enabled = enabled
        row.updated_by = _actor_id(actor)
        row.updated_at = utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        await emit(row.tenant_id, "trigger", "enabled" if enabled else "disabled",
                   {"trigger_id": row.trigger_id})
        return row



# ── Alert format (alert_code → SOP mapping) ────────────────────────────


class AlertFormatService(ChecksReferences):
    """CRUD for AlertFormats + ``find_by_code`` used by the correlation/simulate path."""

    # An alert format may map to a SOP (nullable). Same rule as a trigger's.
    REFERENCES = {"sop_id": (SOP, "SOP not found")}

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _row(self, format_id: str) -> AlertFormat:
        row = await self.db.get(AlertFormat, format_id)
        assert_owned(row, self.scope, message="Alert format not found")
        return row

    async def _code_taken(self, alert_code: str, *, exclude_id: str | None = None) -> bool:
        stmt = scoped(
            select(AlertFormat).where(AlertFormat.alert_code == alert_code),
            AlertFormat, self.scope,
        )
        for row in (await self.db.execute(stmt)).scalars().all():
            if exclude_id and row.format_id == exclude_id:
                continue
            return True
        return False

    async def create(self, body, *, actor) -> AlertFormat:
        await self._check_references(body.model_dump())
        if await self._code_taken(body.alert_code):
            raise ConflictError(f"alert_code '{body.alert_code}' already exists")
        row = AlertFormat(
            tenant_id=self.scope.tenant_id,
            alert_code=body.alert_code, name=body.name, description=body.description,
            category=body.category, severity=body.severity, priority=body.priority,
            color_code=body.color_code, icon=body.icon, alert_sound=body.alert_sound,
            sop_id=body.sop_id, sop_mode=body.sop_mode, is_active=body.is_active,
            created_by=_actor_id(actor), updated_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        await emit(row.tenant_id, "alert_format", "created",
                   {"format_id": row.format_id, "alert_code": row.alert_code})
        return row

    async def list_(self, *, skip=0, limit=50, is_active=None):
        stmt = scoped(select(AlertFormat), AlertFormat, self.scope)
        count = scoped(select(func.count()).select_from(AlertFormat), AlertFormat, self.scope)
        if is_active is not None:
            stmt = stmt.where(AlertFormat.is_active.is_(is_active))
            count = count.where(AlertFormat.is_active.is_(is_active))
        stmt = stmt.order_by(AlertFormat.alert_code.asc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count) or 0)
        return rows, total

    async def get(self, format_id: str) -> AlertFormat:
        return await self._row(format_id)

    async def find_by_code(self, alert_code: str) -> AlertFormat | None:
        """Active-or-not AlertFormat for the scope whose alert_code matches (ci)."""
        stmt = scoped(select(AlertFormat), AlertFormat, self.scope)
        code_l = (alert_code or "").strip().lower()
        for row in (await self.db.execute(stmt)).scalars().all():
            if (row.alert_code or "").strip().lower() == code_l:
                return row
        return None

    async def update(self, format_id: str, body, *, actor) -> AlertFormat:
        row = await self._row(format_id)
        data = body.model_dump(exclude_none=True)
        await self._check_references(data)
        if "alert_code" in data and await self._code_taken(data["alert_code"], exclude_id=format_id):
            raise ConflictError(f"alert_code '{data['alert_code']}' already exists")
        for k, v in data.items():
            setattr(row, k, v)
        row.updated_by = _actor_id(actor)
        row.updated_at = utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        await emit(row.tenant_id, "alert_format", "updated", {"format_id": row.format_id})
        return row

    async def delete(self, format_id: str) -> None:
        row = await self._row(format_id)
        await self.db.delete(row)
        await self.db.commit()
        await emit(self.scope.tenant_id, "alert_format", "deleted", {"format_id": format_id})


# ── Event simulator ────────────────────────────────────────────────────


class SimulatorService:
    """Run a synthetic event through the SAME matching logic the correlation
    engine uses (trigger conditions + AlertFormat lookup) and report — or, when
    ``dry_run`` is false, actually create — the resulting incident(s).

    Reuses the correlation module's helpers so simulate and the live NATS consumer
    share one match/create implementation (no duplication).
    """

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    def _tenant_id(self):
        return self.scope.tenant_id

    async def _owned_sop(self, sop_id: str | None) -> SOP | None:
        """The referenced SOP, or None when the caller may not see it.

        The write side now refuses a foreign ``sop_id``, but rows stored before it
        did still exist, and a bare ``db.get`` on a tenant-owned table would read
        one straight into this tenant's simulate output (and, when dry_run is off,
        into an incident carrying that SOP's name). Unreadable is reported as
        "SOP missing", which is what it is from here.
        """
        if not sop_id:
            return None
        sop = await self.db.get(SOP, sop_id)
        return sop if sop is not None and owns(sop, self.scope) else None

    async def simulate(self, body, *, actor) -> dict:
        from ..correlation.engine import (
            build_incident_from_sop,
            extract_alert_code,
            find_alert_format,
            initial_state,
        )

        tenant_id = self._tenant_id()
        # Build a correlation-shaped envelope from the synthetic event.
        envelope: dict = {
            "type": body.event_type,
            "event_type": body.event_type,
            "tenant_id": str(tenant_id) if tenant_id else None,
            "site_id": body.site_id,
            "payload": dict(body.payload or {}),
        }
        alert_code = body.alert_code or extract_alert_code(envelope)
        if body.alert_code:
            envelope["alert_code"] = body.alert_code

        matched_triggers: list[dict] = []
        matched_format: dict | None = None
        skipped: list[dict] = []
        created_ids: list[str] = []

        # ── Trigger matching (same predicate as CorrelationEngine) ──────
        stmt = scoped(select(Trigger).where(Trigger.enabled.is_(True)), Trigger, self.scope)
        triggers = [
            t for t in (await self.db.execute(stmt)).scalars().all()
            if not t.event_type or t.event_type == body.event_type
        ]
        for trig in triggers:
            if not matches_conditions(envelope, trig.conditions or []):
                continue
            sop = await self._owned_sop(trig.sop_id)
            initial = await initial_state(self.db, trig.sop_id) if sop else None
            would_create = bool(sop and sop.is_active and initial)
            matched_triggers.append({
                "trigger_id": trig.trigger_id, "name": trig.name,
                "sop_id": trig.sop_id, "would_create": would_create,
            })
            if not would_create:
                reason = ("SOP missing" if not sop else
                          "SOP inactive" if not sop.is_active else
                          "SOP has no initial state")
                skipped.append({"trigger_id": trig.trigger_id, "reason": reason})
                continue
            if not body.dry_run:
                try:
                    priority = InstancePriority(trig.priority or sop.priority).value
                except ValueError:
                    priority = sop.priority
                inst = await build_incident_from_sop(
                    self.db, sop=sop, initial=initial, envelope=envelope,
                    tenant_id=tenant_id, priority=priority,
                    status=InstanceStatus.ACTIVE.value,
                    name=f"{sop.name}: {body.event_type}", description=trig.description,
                    source={"source": "simulator", "trigger_id": trig.trigger_id},
                )
                trig.last_fired_at = utcnow()
                trig.fire_count = (trig.fire_count or 0) + 1
                await self.db.flush()
                created_ids.append(inst.instance_id)

        # ── AlertFormat matching ────────────────────────────────────────
        if alert_code:
            fmt = await find_alert_format(self.db, tenant_id, alert_code)
            if fmt:
                sop = await self._owned_sop(fmt.sop_id)
                initial = await initial_state(self.db, fmt.sop_id) if sop else None
                would_create = bool(fmt.sop_id and sop and sop.is_active and initial)
                matched_format = {
                    "format_id": fmt.format_id, "alert_code": fmt.alert_code,
                    "name": fmt.name, "sop_id": fmt.sop_id, "sop_mode": fmt.sop_mode,
                    "would_create": would_create,
                }
                if not would_create:
                    reason = ("no SOP mapped" if not fmt.sop_id else
                              "SOP missing" if not sop else
                              "SOP inactive" if not sop.is_active else
                              "SOP has no initial state")
                    skipped.append({"format_id": fmt.format_id, "reason": reason})
                elif not body.dry_run:
                    try:
                        priority = InstancePriority(fmt.priority or sop.priority).value
                    except ValueError:
                        priority = sop.priority
                    status = (InstanceStatus.ACTIVE.value if fmt.sop_mode == "automatic"
                              else InstanceStatus.PENDING.value)
                    inst = await build_incident_from_sop(
                        self.db, sop=sop, initial=initial, envelope=envelope,
                        tenant_id=tenant_id, priority=priority, status=status,
                        name=f"{fmt.name}: {body.event_type}", description=fmt.description,
                        source={"source": "simulator.alert_format",
                                "alert_format_id": fmt.format_id, "alert_code": fmt.alert_code},
                    )
                    await self.db.flush()
                    created_ids.append(inst.instance_id)

        if not body.dry_run and created_ids:
            await self.db.commit()
            for iid in created_ids:
                await emit(tenant_id, "incident", "created",
                           {"instance_id": iid, "source": "simulator"})
        else:
            await self.db.rollback()

        return {
            "dry_run": body.dry_run,
            "event_type": body.event_type,
            "alert_code": alert_code,
            "matched_triggers": matched_triggers,
            "matched_format": matched_format,
            "skipped": skipped,
            "created_instance_id": created_ids[0] if created_ids else None,
            "created_instance_ids": created_ids,
        }
