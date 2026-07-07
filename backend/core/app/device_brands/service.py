"""DeviceBrandService — CRUD + idempotent seeding for the device-brand catalog.

Read-mostly registry (prep for the devices phase). The super-admin curates it; the
catalog is platform-global. Writes commit explicitly (no session autocommit).
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.errors import ConflictError, NotFoundError, ValidationError
from .models import DeviceBrand

# A few real brands seeded on startup (idempotent). ``is_installed`` reflects
# whether the driver ships enabled by default — ONVIF-generic is the safe baseline.
DEFAULT_BRANDS: list[dict] = [
    {
        "brand_id": "hikvision",
        "name": "Hikvision",
        "sdk_type": "hikvision",
        "protocols": ["onvif", "rtsp", "isapi", "http"],
        "capabilities": ["ptz", "events", "audio", "io", "smart"],
        "onvif": True,
        "is_installed": False,
    },
    {
        "brand_id": "dahua",
        "name": "Dahua",
        "sdk_type": "dahua",
        "protocols": ["onvif", "rtsp", "http"],
        "capabilities": ["ptz", "events", "audio", "io"],
        "onvif": True,
        "is_installed": False,
    },
    {
        "brand_id": "cpplus",
        "name": "CP-Plus",
        "sdk_type": "dahua",
        "protocols": ["onvif", "rtsp", "http"],
        "capabilities": ["ptz", "events", "audio"],
        "onvif": True,
        "is_installed": False,
    },
    {
        "brand_id": "onvif",
        "name": "ONVIF Generic",
        "sdk_type": "onvif",
        "protocols": ["onvif", "rtsp"],
        "capabilities": ["events", "ptz"],
        "onvif": True,
        "is_installed": True,
    },
    {
        "brand_id": "lumina",
        "name": "Lumina",
        "sdk_type": "onvif",
        "protocols": ["onvif", "rtsp"],
        "capabilities": ["events"],
        "onvif": True,
        "is_installed": False,
    },
]


class DeviceBrandService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def list_brands(self) -> list[DeviceBrand]:
        rows = (
            await self.db.execute(select(DeviceBrand).order_by(DeviceBrand.name))
        ).scalars().all()
        return list(rows)

    async def get_by_brand_id(self, brand_id: str) -> DeviceBrand | None:
        return (
            await self.db.execute(
                select(DeviceBrand).where(DeviceBrand.brand_id == brand_id)
            )
        ).scalar_one_or_none()

    async def get_or_404(self, pk: uuid.UUID) -> DeviceBrand:
        brand = await self.db.get(DeviceBrand, pk)
        if brand is None:
            raise NotFoundError("device brand not found")
        return brand

    async def create(
        self,
        *,
        brand_id: str,
        name: str,
        sdk_type: str = "onvif",
        protocols: list | None = None,
        capabilities: list | None = None,
        onvif: bool = False,
        is_installed: bool = False,
    ) -> DeviceBrand:
        brand_id = (brand_id or "").strip()
        if not brand_id:
            raise ValidationError("brand_id is required")
        if await self.get_by_brand_id(brand_id) is not None:
            raise ConflictError(f"a device brand '{brand_id}' already exists")
        brand = DeviceBrand(
            brand_id=brand_id,
            name=name,
            sdk_type=sdk_type or "onvif",
            protocols=list(protocols or []),
            capabilities=list(capabilities or []),
            onvif=bool(onvif),
            is_installed=bool(is_installed),
        )
        self.db.add(brand)
        await self.db.commit()
        await self.db.refresh(brand)
        return brand

    async def update(
        self,
        pk: uuid.UUID,
        *,
        name: str | None = None,
        sdk_type: str | None = None,
        protocols: list | None = None,
        capabilities: list | None = None,
        onvif: bool | None = None,
        is_installed: bool | None = None,
    ) -> DeviceBrand:
        brand = await self.get_or_404(pk)
        if name is not None:
            brand.name = name
        if sdk_type is not None:
            brand.sdk_type = sdk_type
        if protocols is not None:
            brand.protocols = list(protocols)
        if capabilities is not None:
            brand.capabilities = list(capabilities)
        if onvif is not None:
            brand.onvif = bool(onvif)
        if is_installed is not None:
            brand.is_installed = bool(is_installed)
        await self.db.commit()
        await self.db.refresh(brand)
        return brand

    async def delete(self, pk: uuid.UUID) -> DeviceBrand:
        brand = await self.get_or_404(pk)
        await self.db.delete(brand)
        await self.db.commit()
        return brand


async def seed_brands(db: AsyncSession) -> None:
    """Ensure the default device brands exist. Idempotent (safe every startup).

    Only inserts missing brand_ids; never overwrites an admin's edits.
    """
    svc = DeviceBrandService(db)
    existing = {b.brand_id for b in await svc.list_brands()}
    added = False
    for spec in DEFAULT_BRANDS:
        if spec["brand_id"] in existing:
            continue
        db.add(
            DeviceBrand(
                brand_id=spec["brand_id"],
                name=spec["name"],
                sdk_type=spec["sdk_type"],
                protocols=list(spec["protocols"]),
                capabilities=list(spec["capabilities"]),
                onvif=spec["onvif"],
                is_installed=spec["is_installed"],
            )
        )
        added = True
    if added:
        await db.commit()
