"""Notify-request consumer — NATS ``notify.request`` / ``vms.popup`` → outbox.

Other services (vision/VMS linkage, report scheduler) have no notification
transport of their own; they publish a channel-agnostic request on the spine for
the workflow connector framework to fan out:

    tenant.<id>.notify.request   {channel, target?, subject?, body?, event_id,
                                  camera_id?, event_type?, severity?, incident_id?, config}
    tenant.<id>.vms.popup        {camera_id, reason, event_id, event_type?, severity?}

This consumer turns each into pending ``Notification`` rows the dispatch task then
delivers through the matched connector (email / webhook / **push**). For a
``channel=push`` request (or a popup, which pushes by default) the ``target`` is a
target **user_id**; when no explicit target is given the request fans out to every
user in the tenant who has a registered device token (so an operator gets the popup
on their phone without the publisher knowing user ids).

Tenant isolation: the ``tenant_id`` is taken from the subject / envelope and
stamped on every row, so a push only ever reaches that tenant's users.

Runs as a long-lived JetStream durable in the Celery worker (alongside the
correlation consumer). Best-effort + idempotent-ish: a duplicate delivery just
enqueues a duplicate row (bounded by the publisher's own dedup upstream).
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kernel.events import EventBus

from app.db import get_engine
from .models import DeviceToken, Notification

log = logging.getLogger("workflow.notify_consumer")

DURABLE = "workflow-notify"

# Subjects this consumer binds (one durable per pattern — JetStream binds 1:1).
SUBSCRIBE_PATTERNS = [
    "tenant.*.notify.request",
    "tenant.*.vms.popup",
]


def _sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_engine(), expire_on_commit=False, class_=AsyncSession)


def _tenant_id(envelope: dict[str, Any]) -> str | None:
    tid = envelope.get("tenant_id")
    if tid in (None, "", "platform"):
        return None
    return str(tid)


class NotifyConsumer:
    """JetStream-durable consumer: notify.request / vms.popup → Notification rows."""

    def __init__(self, bus: EventBus | None = None) -> None:
        self.bus = bus or EventBus(source="workflow-notify")
        self._sm = _sessionmaker()

    async def start(self) -> None:
        await self.bus.connect()
        for pattern in SUBSCRIBE_PATTERNS:
            leaf = pattern.split(".")[-1]  # request | popup
            await self.bus.subscribe(pattern, self._route, durable=f"{DURABLE}-{leaf}")
        log.info("NotifyConsumer subscribed on %s", SUBSCRIBE_PATTERNS)

    async def close(self) -> None:
        await self.bus.close()

    async def _route(self, envelope: dict[str, Any]) -> None:
        """Dispatch a raw envelope to the right handler by its shape.

        A ``vms.popup`` carries ``camera_id`` + ``reason``; a ``notify.request``
        carries a ``channel``. We branch on the presence of ``channel``.
        """
        try:
            if "channel" in envelope:
                await self.handle_notify_request(envelope)
            else:
                await self.handle_popup(envelope)
        except Exception as exc:  # never crash the consumer loop
            log.warning("notify consumer error: %s", exc)

    # -- notify.request ---------------------------------------------------

    async def handle_notify_request(self, envelope: dict[str, Any]) -> None:
        tenant_id = _tenant_id(envelope)
        channel = (envelope.get("channel") or "email").strip()
        subject = envelope.get("subject") or "Neubit notification"
        body = envelope.get("body") or ""
        target = envelope.get("target")
        extra = {
            "kind": "notify.request",
            "event_id": envelope.get("event_id"),
            "event_type": envelope.get("event_type"),
            "camera_id": envelope.get("camera_id"),
            "incident_id": envelope.get("incident_id") or envelope.get("instance_id"),
            "severity": envelope.get("severity"),
            "source_config": envelope.get("config") or {},
        }
        extra = {k: v for k, v in extra.items() if v not in (None, {}) or k == "source_config"}

        async with self._sm() as session:
            await self._enqueue(session, tenant_id, channel, target, subject, body, extra)
            await session.commit()

    # -- vms.popup --------------------------------------------------------

    async def handle_popup(self, envelope: dict[str, Any]) -> None:
        """A VMS popup → a push (and only push) to the tenant's operators.

        The popup is inherently a "look at this camera now" alert, so it routes to
        the push channel. With no explicit target user, it fans out to every user
        in the tenant who has a registered device token.
        """
        tenant_id = _tenant_id(envelope)
        camera_id = envelope.get("camera_id")
        reason = envelope.get("reason") or "Camera event"
        subject = f"Live: {camera_id}" if camera_id else "VMS alert"
        extra = {
            "kind": "vms.popup",
            "event_id": envelope.get("event_id"),
            "event_type": envelope.get("event_type"),
            "camera_id": camera_id,
            "severity": envelope.get("severity"),
        }
        extra = {k: v for k, v in extra.items() if v is not None}

        async with self._sm() as session:
            await self._enqueue(session, tenant_id, "push", None, subject, reason, extra)
            await session.commit()

    # -- shared enqueue ---------------------------------------------------

    async def _enqueue(
        self, session: AsyncSession, tenant_id: str | None, channel: str,
        target: Any, subject: str, body: str, extra: dict,
    ) -> None:
        """Create pending Notification row(s) for a request.

        For ``push`` with no explicit target, fan out to every tenant user that has
        a registered device token (one row per user). Otherwise a single row with
        ``recipient = target`` (an address for email/webhook, a user_id for push).
        """
        if channel == "push" and not target:
            user_ids = await self._tenant_push_users(session, tenant_id)
            if not user_ids:
                log.info("notify: push request but no registered devices (tenant=%s)", tenant_id)
                return
            for uid in user_ids:
                session.add(self._row(tenant_id, channel, uid, subject, body, extra))
            return
        if not target:
            log.info("notify: %s request without a target — dropped (tenant=%s)", channel, tenant_id)
            return
        session.add(self._row(tenant_id, channel, str(target), subject, body, extra))

    @staticmethod
    def _row(tenant_id, channel, recipient, subject, body, extra) -> Notification:
        import uuid as _uuid

        tid = None
        if tenant_id:
            try:
                tid = _uuid.UUID(str(tenant_id))
            except (ValueError, TypeError):
                tid = None
        return Notification(
            tenant_id=tid, channel_type=channel, recipient=recipient,
            subject=subject, body=body, status="pending", extra=extra,
        )

    @staticmethod
    async def _tenant_push_users(session: AsyncSession, tenant_id: str | None) -> list[str]:
        """Distinct user_ids in the tenant that have an enabled device token."""
        import uuid as _uuid

        stmt = select(DeviceToken.user_id).where(DeviceToken.is_active.is_(True)).distinct()
        if tenant_id:
            try:
                stmt = stmt.where(DeviceToken.tenant_id == _uuid.UUID(str(tenant_id)))
            except (ValueError, TypeError):
                stmt = stmt.where(DeviceToken.tenant_id.is_(None))
        else:
            stmt = stmt.where(DeviceToken.tenant_id.is_(None))
        return [uid for (uid,) in (await session.execute(stmt)).all() if uid]


async def run_notify_consumer() -> None:
    """Start the notify consumer and block forever (Celery long-running task)."""
    import asyncio

    consumer = NotifyConsumer()
    await consumer.start()
    log.info("notify consumer running")
    try:
        while True:
            await asyncio.sleep(3600)
    finally:
        await consumer.close()
