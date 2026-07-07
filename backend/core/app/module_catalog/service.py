"""ModuleCatalogService — CRUD + idempotent seeding for the platform module catalog.

The catalog is platform-global (one set of modules for the whole deployment). The
super-admin manages it; tenants get modules by having ``features[key]`` toggled on.

Writes commit explicitly (the shared session does not auto-commit).
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.errors import ConflictError, NotFoundError, ValidationError
from .models import Module

# Sensible platform defaults seeded on startup. Each is a system module (cannot be
# deleted, only toggled/edited). Keys here are the keys a tenant's features dict uses.
DEFAULT_MODULES: list[dict] = [
    {
        "key": "vms",
        "name": "Video Management",
        "description": "Cameras, live view, recording and playback (NVR core).",
        "category": "Video",
        "default_enabled": True,
    },
    {
        "key": "access",
        "name": "Access Control",
        "description": "Doors, readers, credentials and access events.",
        "category": "Security",
        "default_enabled": False,
    },
    {
        "key": "fire",
        "name": "Fire & Safety",
        "description": "Fire alarm panels, zones and safety incident handling.",
        "category": "Security",
        "default_enabled": False,
    },
    {
        "key": "octosense",
        "name": "OctoSense Analytics",
        "description": "Sensor fusion and edge analytics (OctoSense integration).",
        "category": "Analytics",
        "default_enabled": False,
    },
    {
        "key": "nms",
        "name": "Network Management",
        "description": "Network device monitoring and management (NMS).",
        "category": "Operations",
        "default_enabled": False,
    },
    {
        "key": "workflow",
        "name": "Workflow & SOP",
        "description": "Standard operating procedures and incident workflows.",
        "category": "Operations",
        "default_enabled": False,
    },
    {
        "key": "analytics",
        "name": "Dashboards & Reports",
        "description": "Cross-domain dashboards, analytics and scheduled reports.",
        "category": "Analytics",
        "default_enabled": True,
    },
]


class ModuleCatalogService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def list_modules(self) -> list[Module]:
        rows = (
            await self.db.execute(select(Module).order_by(Module.category, Module.name))
        ).scalars().all()
        return list(rows)

    async def get_by_key(self, key: str) -> Module | None:
        return (
            await self.db.execute(select(Module).where(Module.key == key))
        ).scalar_one_or_none()

    async def get_or_404(self, module_id: uuid.UUID) -> Module:
        module = await self.db.get(Module, module_id)
        if module is None:
            raise NotFoundError("module not found")
        return module

    async def create(
        self,
        *,
        key: str,
        name: str,
        description: str = "",
        category: str = "General",
        default_enabled: bool = False,
    ) -> Module:
        key = (key or "").strip()
        if not key:
            raise ValidationError("module key is required")
        if await self.get_by_key(key) is not None:
            raise ConflictError(f"a module with key '{key}' already exists")
        module = Module(
            key=key,
            name=name,
            description=description or "",
            category=category or "General",
            default_enabled=bool(default_enabled),
            is_system=False,  # admin-created modules are never system modules
        )
        self.db.add(module)
        await self.db.commit()
        await self.db.refresh(module)
        return module

    async def update(
        self,
        module_id: uuid.UUID,
        *,
        name: str | None = None,
        description: str | None = None,
        category: str | None = None,
        default_enabled: bool | None = None,
    ) -> Module:
        module = await self.get_or_404(module_id)
        if name is not None:
            module.name = name
        if description is not None:
            module.description = description
        if category is not None:
            module.category = category
        if default_enabled is not None:
            module.default_enabled = bool(default_enabled)
        await self.db.commit()
        await self.db.refresh(module)
        return module

    async def delete(self, module_id: uuid.UUID) -> Module:
        module = await self.get_or_404(module_id)
        if module.is_system:
            raise ValidationError("system modules cannot be deleted")
        await self.db.delete(module)
        await self.db.commit()
        return module


async def seed_modules(db: AsyncSession) -> None:
    """Ensure the default platform modules exist. Idempotent (safe every startup).

    Only inserts missing keys; never overwrites an admin's edits to an existing one.
    """
    svc = ModuleCatalogService(db)
    existing = {m.key for m in await svc.list_modules()}
    added = False
    for spec in DEFAULT_MODULES:
        if spec["key"] in existing:
            continue
        db.add(
            Module(
                key=spec["key"],
                name=spec["name"],
                description=spec["description"],
                category=spec["category"],
                default_enabled=spec["default_enabled"],
                is_system=True,
            )
        )
        added = True
    if added:
        await db.commit()
