"""Tenant lifecycle reactions — cross-service handling of core tenant events.

Core (backend/core) publishes tenant lifecycle events on the NATS spine when a
super-admin acts:

    tenant.<id>.tenant.provisioned | .suspended | .reactivated | .offboarded

The important cross-service reaction is **offboard** (DPDP right-to-erase): when a
tenant is deleted, every service must wipe that tenant's data from its OWN database.
This module gives a service a one-line durable subscription that does exactly that,
generically — it deletes every row whose table carries a ``tenant_id`` column, in
FK-safe (child-before-parent) order, so there is NO per-service model list to keep in
sync. Suspension/expiry are already enforced live via the token gate
(``require_tenant_access``); provisioning hooks land with DB-per-tenant (Phase 7).
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from .events import Unprocessable

log = logging.getLogger("kernel.lifecycle")

# Subjects a service subscribes to. Match core's
# events_nats.publish(str(tenant_id), "tenant", "<event>", ...).
OFFBOARD_PATTERN = "tenant.*.tenant.offboarded"
PROVISIONED_PATTERN = "tenant.*.tenant.provisioned"


def _per_tenant_enabled() -> bool:
    from .config import get_settings

    return bool(getattr(get_settings(), "db_per_tenant", False))


def _require_tenant_uuid(tid: Any) -> None:
    """Refuse a tenant id that can never become a uuid.

    Both the erase (``erase_tenant_data``) and the per-tenant drop
    (``tenant_db_name``) parse it with ``uuid.UUID``, so a malformed id fails
    identically on every redelivery — that is :class:`Unprocessable` by
    definition, and the bus parks it in EVENTS_DLQ on the first delivery
    instead of burning the retry budget.
    """
    try:
        uuid.UUID(str(tid))
    except (ValueError, AttributeError, TypeError) as exc:
        raise Unprocessable(f"tenant_id {tid!r} is not a uuid") from exc


async def erase_tenant_data(database: Any, tenant_id: str) -> int:
    """Delete every row belonging to ``tenant_id`` from this service's database.

    Walks the service's mapped tables in reverse dependency order (dependents first)
    and deletes where ``tenant_id`` matches; tables without a ``tenant_id`` column
    (node-global infra) are skipped. One transaction. Returns the rows removed.
    """
    tid = uuid.UUID(str(tenant_id))
    total = 0
    async with database.get_sessionmaker()() as session:
        for table in reversed(database.Base.metadata.sorted_tables):
            if "tenant_id" in table.c:
                result = await session.execute(
                    table.delete().where(table.c.tenant_id == tid)
                )
                total += result.rowcount or 0
        await session.commit()
    return total


async def subscribe_tenant_offboard(bus: Any, database: Any, *, durable: str) -> None:
    """Wire a durable consumer that erases a tenant's data when core offboards it.

    Call once in the service's startup lifespan (after ``bus.connect()``):

        from kernel.lifecycle import subscribe_tenant_offboard
        from app.db import database
        await subscribe_tenant_offboard(bus, database, durable="workflow-offboard")

    Durable → an offboard that arrives while the service is down is still processed
    on restart (JetStream at-least-once).

    FAILURES PROPAGATE, deliberately. This handler used to catch-and-log every
    exception — a hangover from the auto-ack era, when raising killed nothing
    and saved nothing. Under manual ack that catch became the bug: an erasure
    that failed because the database was DOWN was acked and never retried, i.e.
    a GDPR/DPDP right-to-erase silently not honoured. Now a transient failure
    raises and the bus NAKs + retries it (and after the budget, parks it in
    EVENTS_DLQ — visible, not vanished), while a tenant id that can never parse
    is refused via :class:`Unprocessable` on the first delivery. The erase is
    idempotent (DELETE by tenant_id / DROP IF EXISTS), so redelivery after a
    partial failure is safe. The consumer itself is never at risk: the bus
    catches every handler exception to make its ack decision.
    """

    async def _handler(envelope: dict) -> None:
        tid = envelope.get("tenant_id")
        if not tid or tid == "platform":
            return
        _require_tenant_uuid(tid)
        if _per_tenant_enabled():
            # DB-per-tenant: dropping the database IS the erase (complete + trivial).
            from .provisioning import drop_tenant_db

            await drop_tenant_db(database.database_url, tid)
            log.info("tenant offboard: dropped database for tenant %s", tid)
        else:
            removed = await erase_tenant_data(database, tid)
            log.info("tenant offboard: erased %d rows for tenant %s", removed, tid)

    await bus.subscribe(OFFBOARD_PATTERN, _handler, durable=durable)


async def subscribe_tenant_provisioned(bus: Any, database: Any, *, durable: str) -> None:
    """Wire a durable consumer that provisions this service's per-tenant database when
    core creates a tenant. No-op unless ``db_per_tenant`` is on (shared-DB mode needs
    no provisioning). Call once in the service's startup lifespan, like the offboard
    consumer.

    Same failure contract as the offboard handler: a transient failure (Postgres
    briefly down at the moment a tenant was created) raises and is retried by
    the bus — a tenant whose database silently never got provisioned is a
    correctness bug, not a log line — while an unparseable tenant id is refused
    via :class:`Unprocessable`. ``provision_tenant_schema`` is idempotent (the
    CREATE DATABASE is existence-checked, ``create_all`` is checkfirst), so
    redelivery is safe.
    """

    async def _handler(envelope: dict) -> None:
        tid = envelope.get("tenant_id")
        if not tid or tid == "platform" or not _per_tenant_enabled():
            return
        _require_tenant_uuid(tid)
        from .provisioning import provision_tenant_schema

        await provision_tenant_schema(database.database_url, database.Base.metadata, tid)
        log.info("tenant provision: created database + schema for tenant %s", tid)

    await bus.subscribe(PROVISIONED_PATTERN, _handler, durable=durable)
