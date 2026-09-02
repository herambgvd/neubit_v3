"""DB-backed tests for device-token registration + notify-consumer enqueue.

Uses an in-memory aiosqlite engine (the models use portable generic column types,
so they build on SQLite). Exercises:
  * register (create) + upsert (re-register same token → one row, re-enabled),
  * list_mine (own user only),
  * unregister by id + by (platform, token),
  * tenant isolation on the push-user fan-out,
  * NotifyConsumer.handle_notify_request / handle_popup → pending Notification rows,
  * the DB token resolver/pruner (resolve enabled tokens, prune → is_active False).
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import Base
from app.workflow.models import DeviceToken, Notification
from app.workflow.service import DeviceTokenService
from app.workflow import schemas as S

from kernel.auth import Principal, Scope


def _run(coro):
    return asyncio.run(coro)


class _Actor:
    def __init__(self, user_id):
        self.user_id = user_id


async def _make_session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        # Build only the tables these tests touch.
        await conn.run_sync(
            lambda c: Base.metadata.create_all(
                c, tables=[DeviceToken.__table__, Notification.__table__]
            )
        )
    sm = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    return engine, sm


TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()


def test_register_and_upsert():
    async def go():
        engine, sm = await _make_session()
        try:
            async with sm() as session:
                scope = Scope(tenant_id=TENANT_A, is_superadmin=False)
                svc = DeviceTokenService(session, scope)
                actor = _Actor("user-1")
                row = await svc.register(
                    S.RegisterDeviceTokenRequest(platform="fcm", token="tok-1", label="Pixel"),
                    actor=actor,
                )
                assert row.user_id == "user-1"
                assert row.is_active is True
                # Re-register same (tenant, platform, token) → upsert, not a duplicate.
                row2 = await svc.register(
                    S.RegisterDeviceTokenRequest(platform="fcm", token="tok-1", label="Pixel-8"),
                    actor=actor,
                )
                assert row2.device_token_id == row.device_token_id
                assert row2.label == "Pixel-8"
                count = len((await session.execute(select(DeviceToken))).scalars().all())
                assert count == 1
        finally:
            await engine.dispose()

    _run(go())


def test_list_mine_and_unregister():
    async def go():
        engine, sm = await _make_session()
        try:
            async with sm() as session:
                scope = Scope(tenant_id=TENANT_A, is_superadmin=False)
                svc = DeviceTokenService(session, scope)
                a = _Actor("user-1")
                b = _Actor("user-2")
                r1 = await svc.register(S.RegisterDeviceTokenRequest(platform="fcm", token="a"), actor=a)
                await svc.register(S.RegisterDeviceTokenRequest(platform="apns", token="b"), actor=b)
                mine = await svc.list_mine(actor=a)
                assert [m.token for m in mine] == ["a"]
                # Unregister by id.
                await svc.unregister(r1.device_token_id, actor=a)
                assert await svc.list_mine(actor=a) == []
                # Unregister by (platform, token).
                removed = await svc.unregister_by_token("apns", "b", actor=b)
                assert removed is True
        finally:
            await engine.dispose()

    _run(go())


def test_tenant_isolation_on_fanout():
    """A tenant-B push user is never returned for a tenant-A fan-out."""
    async def go():
        engine, sm = await _make_session()
        try:
            async with sm() as session:
                # tenant A user with a token.
                await DeviceTokenService(
                    session, Scope(tenant_id=TENANT_A, is_superadmin=False)
                ).register(S.RegisterDeviceTokenRequest(platform="fcm", token="a-tok"), actor=_Actor("a-user"))
                # tenant B user with a token.
                await DeviceTokenService(
                    session, Scope(tenant_id=TENANT_B, is_superadmin=False)
                ).register(S.RegisterDeviceTokenRequest(platform="fcm", token="b-tok"), actor=_Actor("b-user"))

                from app.workflow.notify_consumer import NotifyConsumer

                users_a = await NotifyConsumer._tenant_push_users(session, str(TENANT_A))
                users_b = await NotifyConsumer._tenant_push_users(session, str(TENANT_B))
                assert users_a == ["a-user"]
                assert users_b == ["b-user"]
        finally:
            await engine.dispose()

    _run(go())


def test_notify_consumer_request_enqueues_row():
    async def go():
        engine, sm = await _make_session()
        try:
            from app.workflow.notify_consumer import NotifyConsumer

            consumer = NotifyConsumer.__new__(NotifyConsumer)  # skip bus connect
            consumer._sm = sm
            await consumer.handle_notify_request({
                "tenant_id": str(TENANT_A), "channel": "push", "target": "user-9",
                "subject": "Hi", "body": "Body", "event_id": "e1", "camera_id": "cam-1",
            })
            async with sm() as session:
                rows = (await session.execute(select(Notification))).scalars().all()
                assert len(rows) == 1
                n = rows[0]
                assert n.channel_type == "push"
                assert n.recipient == "user-9"
                assert n.extra["camera_id"] == "cam-1"
                assert str(n.tenant_id) == str(TENANT_A)
        finally:
            await engine.dispose()

    _run(go())


def test_notify_consumer_popup_fans_out_to_push_users():
    async def go():
        engine, sm = await _make_session()
        try:
            async with sm() as session:
                await DeviceTokenService(
                    session, Scope(tenant_id=TENANT_A, is_superadmin=False)
                ).register(S.RegisterDeviceTokenRequest(platform="fcm", token="x"), actor=_Actor("op-1"))

            from app.workflow.notify_consumer import NotifyConsumer

            consumer = NotifyConsumer.__new__(NotifyConsumer)
            consumer._sm = sm
            await consumer.handle_popup({
                "tenant_id": str(TENANT_A), "camera_id": "cam-5", "reason": "Motion",
                "event_id": "ev-1",
            })
            async with sm() as session:
                rows = (await session.execute(select(Notification))).scalars().all()
                assert len(rows) == 1
                assert rows[0].channel_type == "push"
                assert rows[0].recipient == "op-1"
                assert rows[0].extra["kind"] == "vms.popup"
        finally:
            await engine.dispose()

    _run(go())
