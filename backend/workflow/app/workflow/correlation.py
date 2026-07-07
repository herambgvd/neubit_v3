"""Correlation engine — event → incident.

Ported from neubit_v2's ``module/correlation/engine.py``, adapted to the v3 spine:
subscribes to domain events over NATS/JetStream (durable consumer) instead of
Kafka, and creates ``WorkflowInstance`` rows in this service's OWN db. The
NVR-specific snapshot/camera enrichment from v2 is intentionally dropped (that
belongs to the devices/ingest phase); the incident-automation CORE is kept:

    for each event → find matching Triggers (by event_type) → check conditions
    → honour the dedup window (idempotent claim) → create a WorkflowInstance in
    the SOP's initial state → publish ``tenant.<id>.workflow.incident.created``.

Idempotency: dedup slots (``correlation_dedup``) keyed by
``trigger_id:dedup_key:window_bucket``, plus event_id-based dedup so re-delivery
of the same event never double-creates an incident.

Subjects consumed (JetStream durable ``workflow-correlation``):
    tenant.*.ingest.event.received      (normalized external events — future ingest)
    tenant.*.vms.>                        (camera / VMS events — future)
    tenant.*.access.>                     (access-control events — future)
    tenant.*.fire.>                       (fire-alarm events — future)
    tenant.*.sites.site.threat_level_changed  (posture changes — core, today)

Published:
    tenant.<id>.workflow.incident.created
    tenant.<id>.workflow.trigger.fired
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kernel.events import EventBus, subject

from app.db import get_engine
from .models import SOP, CorrelationDedup, State, Trigger, WorkflowInstance
from .shared import InstancePriority, InstanceStatus, matches_conditions, utcnow, walk

log = logging.getLogger("workflow.correlation")

DURABLE = "workflow-correlation"
DEDUP_TTL_MARGIN_SECONDS = 300

# The subject patterns the correlation consumer listens on. Ingest / vms / access /
# fire are future domains; sites.* threat-level changes already flow today.
SUBSCRIBE_PATTERNS = [
    "tenant.*.ingest.>",
    "tenant.*.vms.>",
    "tenant.*.access.>",
    "tenant.*.fire.>",
    "tenant.*.sites.>",
]


def _parse_dt(raw: Any) -> datetime | None:
    if isinstance(raw, datetime):
        return raw
    if isinstance(raw, str):
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _sessionmaker() -> async_sessionmaker[AsyncSession]:
    """A fresh sessionmaker bound to this service's engine (lazy)."""
    return async_sessionmaker(get_engine(), expire_on_commit=False, class_=AsyncSession)


class CorrelationEngine:
    """JetStream-durable consumer that turns domain events into incidents.

    Owns its own ``EventBus`` (source="workflow-correlation") so it can both
    subscribe and publish. A fresh DB session is opened per event so a long idle
    never leaks a pooled connection.
    """

    def __init__(self, bus: EventBus | None = None) -> None:
        self.bus = bus or EventBus(source="workflow-correlation")
        self._sm = _sessionmaker()

    async def start(self) -> None:
        await self.bus.connect()
        # One JetStream durable can bind to only ONE subscription, so give each
        # subject pattern its own durable (workflow-correlation-<domain>).
        for pattern in SUBSCRIBE_PATTERNS:
            domain = pattern.split(".")[2]  # tenant.*.<domain>.>
            await self.bus.subscribe(pattern, self.handle_event, durable=f"{DURABLE}-{domain}")
        log.info("CorrelationEngine subscribed on %s (durable prefix=%s)", SUBSCRIBE_PATTERNS, DURABLE)

    async def close(self) -> None:
        await self.bus.close()

    async def handle_event(self, envelope: dict[str, Any]) -> None:
        """Handle one decoded event envelope (from ``kernel.events``).

        Envelope shape: {event_id, tenant_id, type, occurred_at, source, payload}.
        ``type`` is ``<domain>.<event>`` (e.g. "ingest.event.received"). We map it
        onto Trigger.event_type. Feedback-loop guard: skip our own workflow events.
        """
        event_type = envelope.get("type") or envelope.get("event_type")
        if not event_type:
            return
        if str(event_type).startswith("workflow."):
            return  # never react to our own emissions

        tenant_id = envelope.get("tenant_id")
        payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
        # Flatten payload site_id up to the envelope for downstream convenience.
        if "site_id" not in envelope and isinstance(payload, dict):
            envelope = {**envelope, "site_id": payload.get("site_id")}

        async with self._sm() as session:
            triggers = await self._matching_triggers(session, tenant_id, str(event_type))
            fired = 0
            for trig in triggers:
                if not matches_conditions(envelope, trig.conditions or []):
                    continue
                if await self._fire(session, trig, envelope):
                    fired += 1
            await session.commit()
            if fired:
                log.info("correlation: event_type=%s fired %d trigger(s)", event_type, fired)

    async def _matching_triggers(
        self, session: AsyncSession, tenant_id: str | None, event_type: str
    ) -> list[Trigger]:
        """Enabled triggers for this tenant whose event_type matches (or is empty)."""
        stmt = select(Trigger).where(Trigger.enabled.is_(True))
        # Scope by tenant: a trigger fires only for its own tenant's events. NULL
        # tenant_id triggers are platform/shared and match any event.
        if tenant_id:
            import uuid as _uuid

            try:
                tid = _uuid.UUID(str(tenant_id))
                stmt = stmt.where((Trigger.tenant_id == tid) | (Trigger.tenant_id.is_(None)))
            except (ValueError, TypeError):
                stmt = stmt.where(Trigger.tenant_id.is_(None))
        rows = list((await session.execute(stmt)).scalars().all())
        return [t for t in rows if not t.event_type or t.event_type == event_type]

    async def _fire(self, session: AsyncSession, trigger: Trigger, envelope: dict[str, Any]) -> bool:
        sop = await session.get(SOP, trigger.sop_id)
        if not sop or not sop.is_active:
            return False
        initial = await self._initial_state(session, sop.sop_id)
        if not initial:
            log.warning("trigger %s would fire but SOP %s has no initial state",
                        trigger.trigger_id, sop.sop_id)
            return False

        dedup_key = self._resolve_dedup_key(trigger, envelope)
        window = max(1, int((trigger.dedup or {}).get("window_seconds", 3600)))
        if not await self._claim(session, trigger.trigger_id, dedup_key, window,
                                 _parse_dt(envelope.get("occurred_at"))):
            log.debug("trigger %s suppressed by dedup (key=%s)", trigger.trigger_id, dedup_key)
            return False

        try:
            priority = InstancePriority(trigger.priority or sop.priority).value
        except ValueError:
            priority = sop.priority

        now = utcnow()
        site_id = envelope.get("site_id")
        sla_deadline = now + timedelta(hours=sop.sla_hours) if sop.sla_hours else None
        assign_users = trigger.assign_users or []
        instance = WorkflowInstance(
            tenant_id=trigger.tenant_id,
            sop_id=sop.sop_id, sop_name=sop.name, sop_version=sop.version,
            name=f"{sop.name}: {envelope.get('type')}",
            description=trigger.description, priority=priority, site_id=site_id,
            current_state=initial.state_id, current_state_name=initial.name,
            status=InstanceStatus.ACTIVE.value,
            assigned_to=assign_users[0] if assign_users else None,
            trigger_data=envelope, event_id=envelope.get("event_id"),
            event_type=envelope.get("type"),
            sla_hours=sop.sla_hours, sla_deadline=sla_deadline, state_entered_at=now,
            timeline=[], extra={"source": "correlation", "trigger_id": trigger.trigger_id},
        )
        session.add(instance)

        # Bump trigger counters.
        trigger.last_fired_at = now
        trigger.fire_count = (trigger.fire_count or 0) + 1

        await session.flush()  # populate instance_id before publishing

        tid = str(trigger.tenant_id) if trigger.tenant_id else None
        await self.bus.publish(subject(tid, "workflow", "incident.created"), {
            "tenant_id": tid, "instance_id": instance.instance_id, "sop_id": sop.sop_id,
            "sop_name": sop.name, "trigger_id": trigger.trigger_id,
            "trigger_event_id": envelope.get("event_id"), "priority": priority,
            "matched_event_type": envelope.get("type"), "site_id": site_id,
        })
        await self.bus.publish(subject(tid, "workflow", "trigger.fired"), {
            "tenant_id": tid, "trigger_id": trigger.trigger_id, "trigger_name": trigger.name,
            "instance_id": instance.instance_id, "matched_event_id": envelope.get("event_id"),
        })
        log.info("incident created instance_id=%s trigger_id=%s event_type=%s",
                 instance.instance_id, trigger.trigger_id, envelope.get("type"))
        return True

    @staticmethod
    async def _initial_state(session: AsyncSession, sop_id: str) -> State | None:
        stmt = select(State).where(State.sop_id == sop_id, State.is_initial.is_(True)).limit(1)
        return (await session.execute(stmt)).scalars().first()

    @staticmethod
    def _resolve_dedup_key(trigger: Trigger, envelope: dict[str, Any]) -> str:
        dedup = trigger.dedup or {}
        strategy = dedup.get("strategy", "per_event_type")
        if strategy == "per_event_id":
            return f"event:{envelope.get('event_id')}"
        if strategy == "per_field" and dedup.get("key_field"):
            return f"field:{dedup['key_field']}={walk(envelope, dedup['key_field'])}"
        return f"type:{envelope.get('type')}:site:{envelope.get('site_id')}"

    @staticmethod
    async def _claim(session: AsyncSession, trigger_id: str, dedup_key: str,
                     window_seconds: int, occurred_at: datetime | None) -> bool:
        """Atomic dedup claim (INSERT … ON CONFLICT DO NOTHING). True = claimed."""
        when = occurred_at or utcnow()
        bucket = int(when.timestamp() // max(1, window_seconds))
        key = f"{trigger_id}:{dedup_key}:{bucket}"
        expires = datetime.fromtimestamp(
            (bucket + 1) * window_seconds + DEDUP_TTL_MARGIN_SECONDS, tz=timezone.utc,
        )
        stmt = (
            pg_insert(CorrelationDedup)
            .values(key=key, trigger_id=trigger_id, dedup_key=dedup_key,
                    claimed_at=utcnow(), expires_at=expires)
            .on_conflict_do_nothing(index_elements=["key"])
        )
        result = await session.execute(stmt)
        return result.rowcount > 0
