"""Module catalog API — full path ``{api_prefix}/admin/modules``.

The catalog is READ by any authenticated user (the frontend needs it to render the
per-tenant feature toggles and to know what module keys exist). MUTATIONS are gated
by ``require_superadmin``. Deleting a system module is blocked in the service.
Actions are audit-logged like the rest of the platform.
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
from .service import ModuleCatalogService

# Mounted by create_app under the app's api_prefix → {api_prefix}/admin/modules.
router = APIRouter(prefix="/admin/modules", tags=["admin", "modules"])


class ModuleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    key: str
    name: str
    description: str
    category: str
    default_enabled: bool
    is_system: bool


class CreateModuleIn(BaseModel):
    key: str
    name: str
    description: str = ""
    category: str = "General"
    default_enabled: bool = False


class UpdateModuleIn(BaseModel):
    name: str | None = None
    description: str | None = None
    category: str | None = None
    default_enabled: bool | None = None


@router.get("", response_model=list[ModuleOut])
async def list_modules(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[ModuleOut]:
    """List the platform module catalog (any authenticated user).

    The frontend uses this to render the per-tenant feature toggles and to know
    which module keys a tenant's ``features`` dict may carry.
    """
    modules = await ModuleCatalogService(db).list_modules()
    return [ModuleOut.model_validate(m) for m in modules]


@router.post("", response_model=ModuleOut, status_code=201)
async def create_module(
    data: CreateModuleIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> ModuleOut:
    module = await ModuleCatalogService(db).create(
        key=data.key,
        name=data.name,
        description=data.description,
        category=data.category,
        default_enabled=data.default_enabled,
    )
    await audit_record(
        db, actor=actor, action="module.create", target_type="module",
        target_id=str(module.id), meta={"key": module.key},
    )
    return ModuleOut.model_validate(module)


@router.patch("/{module_id}", response_model=ModuleOut)
async def update_module(
    module_id: uuid.UUID,
    data: UpdateModuleIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> ModuleOut:
    module = await ModuleCatalogService(db).update(
        module_id,
        name=data.name,
        description=data.description,
        category=data.category,
        default_enabled=data.default_enabled,
    )
    await audit_record(
        db, actor=actor, action="module.update", target_type="module",
        target_id=str(module_id), meta=data.model_dump(exclude_none=True),
    )
    return ModuleOut.model_validate(module)


@router.delete("/{module_id}", status_code=204)
async def delete_module(
    module_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> None:
    """Delete a non-system module (system modules are protected in the service)."""
    module = await ModuleCatalogService(db).delete(module_id)
    await audit_record(
        db, actor=actor, action="module.delete", target_type="module",
        target_id=str(module_id), meta={"key": module.key},
    )
