"""Notification services — templates, channels, and device-token registration.

``DeviceTokenService`` sits beside ``NotificationService`` rather than in a
package of its own because the two are one surface: they share the
``/workflow/notifications`` router and the ``workflow.notification.*`` permission
family, and a device token exists only to be a push notification's recipient.
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ValidationError

from ..core.actor import actor_id as _actor_id
from ..core.primitives import utcnow
from .models import DeviceToken, Notification, NotificationChannel, NotificationTemplate


# ── Notification templates + channels ──────────────────────────────────


class NotificationService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    # -- templates --
    async def _template(self, template_id: str) -> NotificationTemplate:
        row = await self.db.get(NotificationTemplate, template_id)
        assert_owned(row, self.scope, message="Template not found")
        return row

    async def create_template(self, body, *, actor) -> NotificationTemplate:
        row = NotificationTemplate(
            tenant_id=self.scope.tenant_id, name=body.name, description=body.description,
            channel_type=body.channel_type, subject=body.subject, body=body.body,
            provider_template_ref=body.provider_template_ref,
            is_active=body.is_active, created_by=_actor_id(actor), updated_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def list_templates(self, *, skip=0, limit=50):
        stmt = scoped(select(NotificationTemplate), NotificationTemplate, self.scope)
        count = scoped(select(func.count()).select_from(NotificationTemplate), NotificationTemplate, self.scope)
        stmt = stmt.order_by(NotificationTemplate.created_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count) or 0)
        return rows, total

    async def update_template(self, template_id: str, body, *, actor) -> NotificationTemplate:
        row = await self._template(template_id)
        for k, v in body.model_dump(exclude_none=True).items():
            setattr(row, k, v)
        row.updated_by = _actor_id(actor)
        row.updated_at = utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def delete_template(self, template_id: str) -> None:
        row = await self._template(template_id)
        await self.db.delete(row)
        await self.db.commit()

    # -- channels --
    async def _channel(self, channel_id: str) -> NotificationChannel:
        row = await self.db.get(NotificationChannel, channel_id)
        assert_owned(row, self.scope, message="Channel not found")
        return row

    async def create_channel(self, body, *, actor) -> NotificationChannel:
        row = NotificationChannel(
            tenant_id=self.scope.tenant_id, name=body.name, channel_type=body.channel_type,
            config=body.config, is_enabled=body.is_enabled, is_default=body.is_default,
            created_by=_actor_id(actor), updated_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def list_channels(self, *, skip=0, limit=50):
        stmt = scoped(select(NotificationChannel), NotificationChannel, self.scope)
        count = scoped(select(func.count()).select_from(NotificationChannel), NotificationChannel, self.scope)
        stmt = stmt.order_by(NotificationChannel.created_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count) or 0)
        return rows, total

    async def update_channel(self, channel_id: str, body, *, actor) -> NotificationChannel:
        row = await self._channel(channel_id)
        for k, v in body.model_dump(exclude_none=True).items():
            setattr(row, k, v)
        row.updated_by = _actor_id(actor)
        row.updated_at = utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def delete_channel(self, channel_id: str) -> None:
        row = await self._channel(channel_id)
        await self.db.delete(row)
        await self.db.commit()


# ── Device tokens (mobile push registration) ───────────────────────────


class DeviceTokenService:
    """Register/unregister a user's mobile push tokens (FCM/APNs).

    Scoped to the caller: a user registers tokens for THEMSELVES within their own
    tenant. Re-registering the same ``(tenant, platform, token)`` upserts (updates
    the label + re-enables) rather than duplicating.
    """

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _row(self, device_token_id: str) -> DeviceToken:
        row = await self.db.get(DeviceToken, device_token_id)
        assert_owned(row, self.scope, message="Device token not found")
        return row

    async def register(self, body, *, actor) -> DeviceToken:
        user_id = _actor_id(actor)
        if not user_id:
            raise ValidationError("cannot register a device token without a user")
        # Upsert on (tenant, platform, token) — a device re-registering keeps one row.
        stmt = scoped(
            select(DeviceToken).where(
                DeviceToken.platform == body.platform,
                DeviceToken.token == body.token,
            ),
            DeviceToken, self.scope,
        )
        existing = (await self.db.execute(stmt)).scalars().first()
        if existing is not None:
            existing.user_id = user_id
            existing.label = body.label if body.label is not None else existing.label
            existing.is_active = True
            existing.updated_by = user_id
            existing.updated_at = utcnow()
            await self.db.commit()
            await self.db.refresh(existing)
            return existing
        row = DeviceToken(
            tenant_id=self.scope.tenant_id,
            user_id=user_id,
            platform=body.platform,
            token=body.token,
            label=body.label,
            is_active=True,
            created_by=user_id,
            updated_by=user_id,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def list_mine(self, *, actor) -> list[DeviceToken]:
        """The caller's registered device tokens (own user only)."""
        user_id = _actor_id(actor)
        if not user_id:
            return []
        stmt = scoped(
            select(DeviceToken).where(DeviceToken.user_id == user_id),
            DeviceToken, self.scope,
        ).order_by(DeviceToken.created_at.desc())
        return list((await self.db.execute(stmt)).scalars().all())

    async def unregister(self, device_token_id: str, *, actor) -> None:
        row = await self._row(device_token_id)
        # A user may only unregister their own device token.
        if row.user_id != _actor_id(actor) and not self.scope.is_superadmin:
            raise ValidationError("cannot unregister another user's device token")
        await self.db.delete(row)
        await self.db.commit()

    async def unregister_by_token(self, platform: str, token: str, *, actor) -> bool:
        """Delete the caller's row for a given (platform, token). True if removed."""
        user_id = _actor_id(actor)
        stmt = scoped(
            select(DeviceToken).where(
                DeviceToken.platform == platform,
                DeviceToken.token == token,
            ),
            DeviceToken, self.scope,
        )
        row = (await self.db.execute(stmt)).scalars().first()
        if row is None or (row.user_id != user_id and not self.scope.is_superadmin):
            return False
        await self.db.delete(row)
        await self.db.commit()
        return True


