"""Device-token DB helpers for the push connector.

The push connector (``connectors/push.py``) is transport-only; these helpers are
its default DB-backed ``token_resolver`` / ``token_pruner``. They run from the
Celery dispatch task (its own asyncio loop), so — like ``tasks.py`` — they open a
short-lived NullPool engine per call to stay loop-safe.

Tenant isolation is enforced in ``resolve_tokens``: only tokens whose
``(tenant_id, user_id)`` match the target are returned, so a push can never reach
another tenant's devices.
"""

from __future__ import annotations

import logging
import uuid as _uuid
from contextlib import asynccontextmanager

from sqlalchemy import pool, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.config import get_settings

from .connectors.push import PushToken
from .models import DeviceToken
from .shared import utcnow

log = logging.getLogger("workflow.push_tokens")


@asynccontextmanager
async def _session():
    """Yield an AsyncSession on a fresh NullPool engine (loop-safe per call)."""
    engine = create_async_engine(get_settings().database_url, poolclass=pool.NullPool)
    sm = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    try:
        async with sm() as session:
            yield session
    finally:
        await engine.dispose()


def _as_uuid(value):
    if value is None:
        return None
    if isinstance(value, _uuid.UUID):
        return value
    try:
        return _uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None


async def resolve_tokens(tenant_id: str | None, user_id: str) -> list[PushToken]:
    """Enabled push tokens for ``user_id`` within ``tenant_id`` (tenant-isolated)."""
    tid = _as_uuid(tenant_id)
    async with _session() as session:
        stmt = select(DeviceToken).where(
            DeviceToken.user_id == str(user_id),
            DeviceToken.is_active.is_(True),
        )
        if tid is not None:
            stmt = stmt.where(DeviceToken.tenant_id == tid)
        else:
            stmt = stmt.where(DeviceToken.tenant_id.is_(None))
        rows = (await session.execute(stmt)).scalars().all()
        # Best-effort last_used stamp (does not gate delivery).
        now = utcnow()
        for r in rows:
            r.last_used_at = now
        await session.commit()
        return [
            PushToken(device_token_id=r.device_token_id, platform=r.platform, token=r.token)
            for r in rows
        ]


async def prune_tokens(device_token_ids: list[str]) -> None:
    """Disable tokens the provider reported invalid/unregistered (soft prune)."""
    if not device_token_ids:
        return
    async with _session() as session:
        await session.execute(
            update(DeviceToken)
            .where(DeviceToken.device_token_id.in_(device_token_ids))
            .values(is_active=False, updated_at=utcnow())
        )
        await session.commit()
    log.info("pruned %d invalid device token(s)", len(device_token_ids))
