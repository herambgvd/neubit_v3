"""SettingsService — per-tenant settings with a platform-default fallback.

Effective value resolution, in order:
  1. the caller's TENANT override row (tenant_id == the caller's tenant), if any;
  2. else the PLATFORM-DEFAULT row (tenant_id NULL);
  3. else the catalog default (code).

Writes upsert the CALLER'S OWN scope: a tenant-admin writes rows stamped with their
tenant_id; a super-admin (tenant_id None) writes the platform-default (NULL) rows.
This keeps one tenant's settings invisible to another while every tenant still
inherits sane platform defaults.

The service is constructed with the caller's ``tenant_id`` (None for a super-admin
or an unauthenticated/public caller — both resolve to the platform default). Callers
that don't care about tenancy (internal lookups like SettingsService(db).get(...))
default to tenant_id None → the platform default, exactly as before.

Writes commit explicitly (no autocommit), matching the rest of the codebase.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import catalog
from .models import AppSetting


class SettingsService:
    def __init__(self, db: AsyncSession, tenant_id: uuid.UUID | None = None) -> None:
        self.db = db
        # None => the platform-default scope (super-admin / public / internal reads).
        self.tenant_id = tenant_id

    async def _rows_for(self, tenant_id: uuid.UUID | None) -> dict:
        """Stored override values for one scope (tenant_id, which may be NULL)."""
        if tenant_id is None:
            stmt = select(AppSetting).where(AppSetting.tenant_id.is_(None))
        else:
            stmt = select(AppSetting).where(AppSetting.tenant_id == tenant_id)
        rows = (await self.db.execute(stmt)).scalars().all()
        return {r.key: r.value for r in rows}

    async def all_values(self) -> dict:
        """Effective values: catalog defaults ← platform-default rows ← tenant rows.

        Later layers win, so a tenant override beats the platform default which
        beats the code default.
        """
        values = catalog.defaults()
        # Layer 1: the platform-default (NULL) rows.
        for key, value in (await self._rows_for(None)).items():
            if key in values:
                values[key] = value
        # Layer 2: the caller's tenant rows (skip when the caller IS the platform).
        if self.tenant_id is not None:
            for key, value in (await self._rows_for(self.tenant_id)).items():
                if key in values:
                    values[key] = value
        return values

    async def public_values(self) -> dict:
        """Only the settings marked public (safe for unauthenticated clients)."""
        allowed = catalog.public_keys()
        return {k: v for k, v in (await self.all_values()).items() if k in allowed}

    async def get(self, key: str):
        return (await self.all_values()).get(key)

    async def update(self, patch: dict) -> dict:
        """Persist overrides for known keys in the CALLER'S scope. Returns the new
        effective values.

        A tenant-admin writes rows tagged with their tenant_id; a super-admin writes
        the platform-default (tenant_id NULL) rows.
        """
        known = catalog.known_keys()
        for key, value in patch.items():
            if key not in known:
                continue
            row = await self._get_row(key, self.tenant_id)
            if row is None:
                self.db.add(AppSetting(key=key, value=value, tenant_id=self.tenant_id))
            else:
                row.value = value
        await self.db.commit()
        return await self.all_values()

    async def _get_row(self, key: str, tenant_id: uuid.UUID | None) -> AppSetting | None:
        """The stored override row for (key, tenant_id), or None."""
        if tenant_id is None:
            stmt = select(AppSetting).where(
                AppSetting.key == key, AppSetting.tenant_id.is_(None)
            )
        else:
            stmt = select(AppSetting).where(
                AppSetting.key == key, AppSetting.tenant_id == tenant_id
            )
        return (await self.db.execute(stmt)).scalar_one_or_none()
