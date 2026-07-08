"""SignalR event-ingestion supervisor.

For each ACTIVE instance the service opens the controller's real-time event
stream (DDS SignalR EventsHub, via the connector) and, per event:

  1. persists an ``AccessEvent`` row (audit trail — v2 ``events`` table), then
  2. publishes it on the NATS spine at
     ``tenant.<tenant_id>.access.<category>.<event_type>`` so the workflow
     correlation engine (``tenant.*.access.>``) can trigger SOPs.

This is the v3 port of v2's ``ingestion/signalr_supervisor.py`` +
``signalr_handlers.py`` (which persisted to Postgres and published to Kafka).

Robustness contract (per the task): the listener MUST start, log, and RETRY
without crashing the service even when there is no live controller in dev. The
connector's ``subscribe_events`` already reconnects with backoff internally; this
supervisor additionally wraps each instance's listen loop so a permanent failure
only restarts that one loop (with backoff) and never propagates.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from kernel.events import EventBus

from app.db import get_sessionmaker
from ..connectors.base import ControllerEvent
from ..connectors.factory import get_connector
from .crypto import decrypt_secret
from .events import emit_access_event
from .models import AccessEvent, Instance

log = logging.getLogger("access.ingestion")

# How long to wait before restarting a listener that gave up permanently.
RESTART_BACKOFF_SECONDS = 30


def _parse_dt(raw: str | None) -> datetime:
    if not raw:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, AttributeError):
        return datetime.now(timezone.utc)


class SignalRSupervisor:
    """Owns one listen task per active instance; started/stopped by the lifespan."""

    def __init__(self, bus: EventBus) -> None:
        self.bus = bus
        self._tasks: dict[str, asyncio.Task] = {}
        self._stopping = False

    async def start(self) -> None:
        """Spawn a listener per active instance across ALL tenants.

        Runs in the API process. Discovery failures (e.g. DB not ready) are
        logged and swallowed — the service must still boot.
        """
        self._stopping = False
        try:
            instances = await self._active_instances()
        except Exception as exc:  # noqa: BLE001 — never block startup
            log.warning("event ingestion: could not list instances (%s); none started", exc)
            return
        for inst in instances:
            self._spawn(inst)
        log.info("event ingestion: started %d listener(s)", len(self._tasks))

    async def _active_instances(self) -> list[Instance]:
        sm = get_sessionmaker()
        async with sm() as session:
            rows = (
                await session.execute(select(Instance).where(Instance.is_active.is_(True)))
            ).scalars().all()
            return list(rows)

    def _spawn(self, instance: Instance) -> None:
        if instance.id in self._tasks:
            return
        # Snapshot the fields the loop needs (detached from the session).
        snapshot = {
            "id": instance.id,
            "tenant_id": instance.tenant_id,
            "brand": instance.brand,
            "base_url": instance.base_url,
            "auth_type": instance.auth_type,
            "username": instance.username,
            "secret_enc": instance.secret_enc,
            "verify_tls": instance.verify_tls,
            "site_id": instance.site_id,
        }
        self._tasks[instance.id] = asyncio.create_task(self._listen_forever(snapshot))

    async def _listen_forever(self, inst: dict) -> None:
        """Keep an instance's SignalR listener alive; restart on permanent loss."""
        while not self._stopping:
            connector = None
            try:
                # Build a lightweight object exposing the attrs the factory reads.
                connector = get_connector(
                    _InstanceView(inst), secret=decrypt_secret(inst["secret_enc"])
                )

                async def _on_event(ev: ControllerEvent, _inst=inst) -> None:
                    await self._handle_event(_inst, ev)

                await connector.subscribe_events(_on_event)
                # subscribe_events returns only when stopped.
                break
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — never crash the service
                log.warning(
                    "event ingestion: listener for instance %s failed (%s); "
                    "restarting in %ss",
                    inst["id"], exc, RESTART_BACKOFF_SECONDS,
                )
                await asyncio.sleep(RESTART_BACKOFF_SECONDS)
            finally:
                if connector is not None:
                    try:
                        await connector.aclose()
                    except Exception:  # noqa: BLE001
                        pass

    async def _handle_event(self, inst: dict, ev: ControllerEvent) -> None:
        """Persist the event, then publish it on the NATS spine (v2 handler port)."""
        tenant_id = inst["tenant_id"]
        occurred_at = _parse_dt(ev.occurred_at)

        row = AccessEvent(
            tenant_id=tenant_id,
            instance_id=inst["id"],
            category=ev.category,
            event_type=ev.event_type,
            result=ev.result or "unknown",
            remote_uid=ev.remote_uid,
            door_ref=ev.door_ref,
            cardholder_ref=ev.cardholder_ref,
            site_id=inst["site_id"],
            raw=ev.raw,
            occurred_at=occurred_at,
            published=False,
        )

        # 1. Persist (own session per event).
        sm = get_sessionmaker()
        try:
            async with sm() as session:
                session.add(row)
                await session.commit()
                await session.refresh(row)
        except Exception as exc:  # noqa: BLE001
            log.warning("event persist failed (instance=%s): %s", inst["id"], exc)
            return

        # 2. Publish to NATS: tenant.<id>.access.<category>.<event_type>.
        try:
            subj = await emit_access_event(
                tenant_id,
                ev.category,
                ev.event_type,
                {
                    "instance_id": inst["id"],
                    "event_id": row.id,
                    "category": ev.category,
                    "type": ev.event_type,
                    "result": row.result,
                    "remote_uid": ev.remote_uid,
                    "door_ref": ev.door_ref,
                    "cardholder_ref": ev.cardholder_ref,
                    "site_id": inst["site_id"],
                    "occurred_at": occurred_at.isoformat(),
                    "raw": ev.raw,
                },
                _bus=self.bus,
            )
            # Mark published.
            async with sm() as session:
                obj = await session.get(AccessEvent, row.id)
                if obj is not None:
                    obj.published = True
                    await session.commit()
            log.debug("published access event %s → %s", row.id, subj)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "event publish failed (instance=%s, category=%s): %s",
                inst["id"], ev.category, exc,
            )

    async def stop(self) -> None:
        self._stopping = True
        for task in list(self._tasks.values()):
            task.cancel()
        for task in list(self._tasks.values()):
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._tasks.clear()


class _InstanceView:
    """Minimal attr view over an instance snapshot dict for the connector factory."""

    def __init__(self, data: dict) -> None:
        self._d = data

    def __getattr__(self, name: str):
        try:
            return self._d[name]
        except KeyError as exc:
            raise AttributeError(name) from exc
