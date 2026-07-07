"""Device brands API — full path ``{api_prefix}/admin/device-brands``.

READ by any authenticated user (the frontend needs the brand list when adding a
device). MUTATIONS are gated by ``require_superadmin``. Read-mostly registry — prep
for the devices phase. Mutations are audit-logged.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.deps import get_current_user
from ..auth.models import User
from ..core.audit import record as audit_record
from ..db.base import get_db
from ..tenancy.deps import require_superadmin
from .service import DeviceBrandService

# Mounted by create_app under the app's api_prefix → {api_prefix}/admin/device-brands.
router = APIRouter(prefix="/admin/device-brands", tags=["admin", "device-brands"])


class DeviceBrandOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    brand_id: str
    name: str
    sdk_type: str
    protocols: list[str]
    capabilities: list[str]
    onvif: bool
    is_installed: bool


class CreateDeviceBrandIn(BaseModel):
    brand_id: str
    name: str
    sdk_type: str = "onvif"
    protocols: list[str] = []
    capabilities: list[str] = []
    onvif: bool = False
    is_installed: bool = False


class UpdateDeviceBrandIn(BaseModel):
    name: str | None = None
    sdk_type: str | None = None
    protocols: list[str] | None = None
    capabilities: list[str] | None = None
    onvif: bool | None = None
    is_installed: bool | None = None


@router.get("", response_model=list[DeviceBrandOut])
async def list_device_brands(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[DeviceBrandOut]:
    """List supported device brands (any authenticated user)."""
    brands = await DeviceBrandService(db).list_brands()
    return [DeviceBrandOut.model_validate(b) for b in brands]


@router.get("/{brand_pk}", response_model=DeviceBrandOut)
async def get_device_brand(
    brand_pk: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> DeviceBrandOut:
    brand = await DeviceBrandService(db).get_or_404(brand_pk)
    return DeviceBrandOut.model_validate(brand)


@router.post("", response_model=DeviceBrandOut, status_code=201)
async def create_device_brand(
    data: CreateDeviceBrandIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> DeviceBrandOut:
    brand = await DeviceBrandService(db).create(
        brand_id=data.brand_id,
        name=data.name,
        sdk_type=data.sdk_type,
        protocols=data.protocols,
        capabilities=data.capabilities,
        onvif=data.onvif,
        is_installed=data.is_installed,
    )
    await audit_record(
        db, actor=actor, action="device_brand.create", target_type="device_brand",
        target_id=str(brand.id), meta={"brand_id": brand.brand_id},
    )
    return DeviceBrandOut.model_validate(brand)


@router.patch("/{brand_pk}", response_model=DeviceBrandOut)
async def update_device_brand(
    brand_pk: uuid.UUID,
    data: UpdateDeviceBrandIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> DeviceBrandOut:
    brand = await DeviceBrandService(db).update(
        brand_pk,
        name=data.name,
        sdk_type=data.sdk_type,
        protocols=data.protocols,
        capabilities=data.capabilities,
        onvif=data.onvif,
        is_installed=data.is_installed,
    )
    await audit_record(
        db, actor=actor, action="device_brand.update", target_type="device_brand",
        target_id=str(brand_pk), meta=data.model_dump(exclude_none=True),
    )
    return DeviceBrandOut.model_validate(brand)


@router.delete("/{brand_pk}", status_code=204)
async def delete_device_brand(
    brand_pk: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> None:
    brand = await DeviceBrandService(db).delete(brand_pk)
    await audit_record(
        db, actor=actor, action="device_brand.delete", target_type="device_brand",
        target_id=str(brand_pk), meta={"brand_id": brand.brand_id},
    )
