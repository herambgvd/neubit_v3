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
from .models import SOP, AlertFormat, CorrelationDedup, State, Trigger, WorkflowInstance
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


# ── Alert-code extraction + shared matching (used by live engine AND simulate) ──


def extract_alert_code(envelope: dict[str, Any]) -> str | None:
    """Pull an alert code out of an event envelope.

    Checks the common keys in priority order: top-level ``alert_code`` / ``code``,
    then ``payload.alert_code`` / ``payload.code``. Returns the raw code (stripped)
    or None. Matching against AlertFormat.alert_code is case-insensitive.
    """
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    for candidate in (
        envelope.get("alert_code"),
        envelope.get("code"),
        payload.get("alert_code"),
        payload.get("code"),
    ):
        if candidate is not None and str(candidate).strip():
            return str(candidate).strip()
    return None


async def find_alert_format(
    session: AsyncSession, tenant_id: Any, alert_code: str
) -> AlertFormat | None:
    """Active AlertFormat for this tenant whose alert_code matches (case-insensitive).

    NULL-tenant (platform) formats also match. Filtering is done in Python on the
    small operator-configured set so the match is case-insensitive + whitespace-safe.
    """
    stmt = select(AlertFormat).where(AlertFormat.is_active.is_(True))
    if tenant_id:
        import uuid as _uuid

        try:
            tid = _uuid.UUID(str(tenant_id))
            stmt = stmt.where((AlertFormat.tenant_id == tid) | (AlertFormat.tenant_id.is_(None)))
        except (ValueError, TypeError):
            stmt = stmt.where(AlertFormat.tenant_id.is_(None))
    code_l = alert_code.strip().lower()
    for row in (await session.execute(stmt)).scalars().all():
        if (row.alert_code or "").strip().lower() == code_l:
            return row
    return None


async def initial_state(session: AsyncSession, sop_id: str) -> State | None:
    stmt = select(State).where(State.sop_id == sop_id, State.is_initial.is_(True)).limit(1)
    return (await session.execute(stmt)).scalars().first()


async def build_incident_from_sop(
    session: AsyncSession,
    *,
    sop: SOP,
    initial: State,
    envelope: dict[str, Any],
    tenant_id: Any,
    priority: str,
    status: str,
    name: str,
    description: str | None,
    source: dict[str, Any],
) -> WorkflowInstance:
    """Construct + add (not commit) a WorkflowInstance in the SOP's initial state."""
    now = utcnow()
    site_id = envelope.get("site_id")
    sla_deadline = now + timedelta(hours=sop.sla_hours) if sop.sla_hours else None
    instance = WorkflowInstance(
        tenant_id=tenant_id,
        sop_id=sop.sop_id, sop_name=sop.name, sop_version=sop.version,
        name=name, description=description, priority=priority, site_id=site_id,
        current_state=initial.state_id, current_state_name=initial.name,
        status=status,
        trigger_data=envelope, event_id=envelope.get("event_id"),
        event_type=envelope.get("type") or envelope.get("event_type"),
        sla_hours=sop.sla_hours, sla_deadline=sla_deadline, state_entered_at=now,
        timeline=[], extra=source,
    )
    session.add(instance)
    return instance


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

        A trigger matches on EITHER of two names, because publishers disagree
        about which one is the event's identity:

        * the TRANSPORT type — ``kernel.events`` derives ``envelope["type"]`` from
          the subject, so everything ingest publishes is ``ingest.event.received``
          regardless of what the payload actually is;
        * the SEMANTIC type — ``payload["event_type"]``, which is what an ingest
          event RULE emits ("lumina.motion") and what an operator naturally types
          into a trigger.

        Matching only the transport type (the original behavior) made per-type
        triggers impossible for ingest: every ingest event looked identical. v2
        had no such split — its Kafka envelope carried the semantic type at the
        top level — so this is the v2 behavior restored, not a new feature.

        Feedback-loop guard stays on the transport type: it is our own subject we
        must not react to, whatever a payload claims to be.
        """
        transport_type = envelope.get("type") or envelope.get("event_type")
        if not transport_type:
            return
        if str(transport_type).startswith("workflow."):
            return  # never react to our own emissions

        tenant_id = envelope.get("tenant_id")
        payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
        # Flatten payload site_id up to the envelope for downstream convenience.
        if "site_id" not in envelope and isinstance(payload, dict):
            envelope = {**envelope, "site_id": payload.get("site_id")}

        semantic_type = payload.get("event_type") if isinstance(payload, dict) else None
        candidates = {str(transport_type)}
        if semantic_type:
            candidates.add(str(semantic_type))
        event_type = str(semantic_type or transport_type)  # for logging

        async with self._sm() as session:
            triggers = await self._matching_triggers(session, tenant_id, candidates)
            fired = 0
            for trig in triggers:
                if not matches_conditions(envelope, trig.conditions or []):
                    continue
                if await self._fire(session, trig, envelope):
                    fired += 1
            # AlertFormat path — an event carrying an alert code that maps to an
            # active SOP creates an incident too (in ADDITION to trigger matches).
            if await self._fire_alert_format(session, tenant_id, envelope):
                fired += 1
            await session.commit()
            if fired:
                log.info("correlation: event_type=%s fired %d incident(s)", event_type, fired)

    async def _matching_triggers(
        self, session: AsyncSession, tenant_id: str | None, event_types: set[str]
    ) -> list[Trigger]:
        """Enabled triggers for this tenant matching any candidate type (or empty).

        ``event_types`` holds the transport type and, when the payload names one,
        the semantic type — see ``handle_event``.
        """
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
        return [t for t in rows if not t.event_type or t.event_type in event_types]

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

    async def _fire_alert_format(
        self, session: AsyncSession, tenant_id: Any, envelope: dict[str, Any]
    ) -> bool:
        """Match an event's alert code against AlertFormats → create an incident.

        Mirrors v2's ``_fire_alert_formats``: look up the active AlertFormat for the
        tenant, and if it maps to an active SOP with an initial state, create an
        incident (ACTIVE for automatic sop_mode, PENDING for manual). Honours the
        same dedup slots so re-delivery of the same event never double-creates.
        Returns True iff an incident was created.
        """
        alert_code = extract_alert_code(envelope)
        if not alert_code:
            return False
        fmt = await find_alert_format(session, tenant_id, alert_code)
        if not fmt or not fmt.sop_id:
            return False
        sop = await session.get(SOP, fmt.sop_id)
        if not sop or not sop.is_active:
            return False
        initial = await initial_state(session, sop.sop_id)
        if not initial:
            log.warning("alert format %s maps to SOP %s with no initial state",
                        fmt.format_id, sop.sop_id)
            return False

        # Dedup — key the alert-format firing on format_id + event identity.
        source_event_id = envelope.get("event_id")
        dedup_key = (
            f"event:{source_event_id}" if source_event_id
            else f"code:{alert_code}:site:{envelope.get('site_id')}"
        )
        if not await self._claim(session, fmt.format_id, dedup_key, 24 * 60 * 60,
                                 _parse_dt(envelope.get("occurred_at"))):
            log.debug("alert format %s suppressed by dedup (key=%s)", fmt.format_id, dedup_key)
            return False

        try:
            priority = InstancePriority(fmt.priority or sop.priority).value
        except ValueError:
            priority = sop.priority
        status = (InstanceStatus.ACTIVE.value if fmt.sop_mode == "automatic"
                  else InstanceStatus.PENDING.value)
        payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
        device_name = (
            payload.get("device_name") or payload.get("camera_name")
            or envelope.get("type") or envelope.get("event_type") or alert_code
        )
        instance = await build_incident_from_sop(
            session, sop=sop, initial=initial, envelope=envelope, tenant_id=fmt.tenant_id,
            priority=priority, status=status,
            name=f"{fmt.name}: {device_name}", description=fmt.description,
            source={"source": "correlation.alert_format", "alert_format_id": fmt.format_id,
                    "alert_code": fmt.alert_code, "sop_mode": fmt.sop_mode},
        )
        await session.flush()

        tid = str(fmt.tenant_id) if fmt.tenant_id else None
        await self.bus.publish(subject(tid, "workflow", "incident.created"), {
            "tenant_id": tid, "instance_id": instance.instance_id, "sop_id": sop.sop_id,
            "sop_name": sop.name, "alert_format_id": fmt.format_id,
            "priority": priority, "matched_event_type": envelope.get("type"),
            "site_id": envelope.get("site_id"), "source": "alert_format",
        })
        log.info("alert-format incident created instance_id=%s format_id=%s code=%s",
                 instance.instance_id, fmt.format_id, alert_code)
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
