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

log = logging.getLogger("kernel.lifecycle")

# Subjects a service subscribes to. Match core's
# events_nats.publish(str(tenant_id), "tenant", "<event>", ...).
OFFBOARD_PATTERN = "tenant.*.tenant.offboarded"
PROVISIONED_PATTERN = "tenant.*.tenant.provisioned"


def _per_tenant_enabled() -> bool:
    from .config import get_settings

    return bool(getattr(get_settings(), "db_per_tenant", False))


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
    on restart (JetStream at-least-once). A failed erase is logged, never fatal.
    """

    async def _handler(envelope: dict) -> None:
        tid = envelope.get("tenant_id")
        if not tid or tid == "platform":
            return
        try:
            if _per_tenant_enabled():
                # DB-per-tenant: dropping the database IS the erase (complete + trivial).
                from .provisioning import drop_tenant_db

                await drop_tenant_db(database.database_url, tid)
                log.info("tenant offboard: dropped database for tenant %s", tid)
            else:
                removed = await erase_tenant_data(database, tid)
                log.info("tenant offboard: erased %d rows for tenant %s", removed, tid)
        except Exception as exc:  # noqa: BLE001 — a bad erase must not kill the consumer
            log.warning("tenant offboard failed for %s: %s", tid, exc)

    await bus.subscribe(OFFBOARD_PATTERN, _handler, durable=durable)


async def subscribe_tenant_provisioned(bus: Any, database: Any, *, durable: str) -> None:
    """Wire a durable consumer that provisions this service's per-tenant database when
    core creates a tenant. No-op unless ``db_per_tenant`` is on (shared-DB mode needs
    no provisioning). Call once in the service's startup lifespan, like the offboard
    consumer.
    """

    async def _handler(envelope: dict) -> None:
        tid = envelope.get("tenant_id")
        if not tid or tid == "platform" or not _per_tenant_enabled():
            return
        try:
            from .provisioning import provision_tenant_schema

            await provision_tenant_schema(database.database_url, database.Base.metadata, tid)
            log.info("tenant provision: created database + schema for tenant %s", tid)
        except Exception as exc:  # noqa: BLE001 — never let a bad provision kill the consumer
            log.warning("tenant provision failed for %s: %s", tid, exc)

    await bus.subscribe(PROVISIONED_PATTERN, _handler, durable=durable)
