"""OnvifServerConfig control-plane service (P6-C) — per-tenant upsert + read.

One config row per tenant (unique ``tenant_id``). ``get_or_default`` returns the row or a
transient default (never persisted until updated) so the UI/read always has a shape.
``upsert`` creates-or-updates the single row; the service password is reversibly encrypted
(``vms.common.crypto``) before storage and never returned.

Tenant-scoped: the row is stamped with the caller's ``tenant_id`` on create and only ever
matched within it. A tenant enabling the ONVIF server with a unique ``service_username`` is
what makes the SOAP server multi-tenant — the username→tenant map lives in this table.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope
from kernel.errors import ValidationError

from app.vms.common.crypto import encrypt_secret
from app.vms.models import OnvifServerConfig

from .schemas import OnvifServerConfigUpdate

log = logging.getLogger("vision.onvif_server_service")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


class OnvifServerService:
    """Tenant-scoped OnvifServerConfig upsert + read (one row per tenant)."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _row(self) -> OnvifServerConfig | None:
        stmt = select(OnvifServerConfig)
        if not self.scope.is_platform:
            stmt = stmt.where(OnvifServerConfig.tenant_id == self.scope.tenant_id)
        else:
            # A super-admin acting without a tenant sees the platform (NULL) row.
            stmt = stmt.where(OnvifServerConfig.tenant_id.is_(None))
        return (await self.db.execute(stmt)).scalar_one_or_none()

    async def get(self) -> OnvifServerConfig:
        """The persisted row, or a transient default (not saved) for a first read."""
        row = await self._row()
        if row is not None:
            return row
        tenant = None if self.scope.is_platform else self.scope.tenant_id
        return OnvifServerConfig(
            tenant_id=tenant,
            enabled=False,
            exposed_camera_ids=["*"],
            service_username=f"onvif-{str(tenant)[:8] if tenant else 'platform'}",
            service_enc_password=None,
            device_name="Neubit VMS",
            created_at=_utcnow(),
            updated_at=_utcnow(),
        )

    async def _username_taken(self, username: str, exclude_id: str | None) -> bool:
        stmt = select(OnvifServerConfig).where(
            OnvifServerConfig.service_username == username
        )
        rows = list((await self.db.execute(stmt)).scalars().all())
        return any(r.id != exclude_id for r in rows)

    async def upsert(self, body: OnvifServerConfigUpdate, *, actor) -> OnvifServerConfig:
        """Create-or-update the tenant's single config row (creds encrypted)."""
        row = await self._row()
        creating = row is None
        if creating:
            tenant = None if self.scope.is_platform else self.scope.tenant_id
            row = OnvifServerConfig(
                tenant_id=tenant,
                service_username=f"onvif-{str(tenant)[:8] if tenant else 'platform'}",
                created_by=_actor_id(actor),
            )

        data = body.model_dump(exclude_unset=True)

        # Enabling requires a resolvable username + a set password (now or already).
        new_username = data.get("service_username", row.service_username)
        if "service_username" in data:
            if await self._username_taken(new_username, None if creating else row.id):
                raise ValidationError("service_username already in use by another tenant")
            row.service_username = new_username

        if "service_password" in data and data["service_password"]:
            row.service_enc_password = encrypt_secret(data["service_password"])

        for field in (
            "enabled",
            "exposed_camera_ids",
            "device_name",
            "advertised_host",
            "advertised_http_port",
            "advertised_rtsp_port",
        ):
            if field in data and data[field] is not None:
                setattr(row, field, data[field])

        if row.enabled and not row.service_enc_password:
            raise ValidationError(
                "cannot enable the ONVIF server without a service password set"
            )

        row.updated_by = _actor_id(actor)
        row.updated_at = _utcnow()

        if creating:
            self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        log.info(
            "onvif-server config %s (tenant=%s enabled=%s)",
            "created" if creating else "updated",
            row.tenant_id,
            row.enabled,
        )
        return row
