"""Infrastructure routes — a site's equipment registry, under the site.

Mounted under the api_prefix → ``{prefix}/sites/{site_id}/infrastructure``, plus
the static vocabulary at ``{prefix}/site-infrastructure/vocabulary``.

PERMISSIONS: ``sites.read`` to read, ``sites.update`` to write — including
deleting a system or a piece of equipment. The registry is a set of facts ABOUT
a site, the same standing as its area, tariff slabs and emission factors, which
are all written under ``sites.update``. ``sites.delete`` means deleting the
building; asking for it to remove one pump would hand out the power to delete
the building in order to edit it. A new ``infrastructure.*`` permission would be
one no existing role holds and no operator could be told they need.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.deps import get_current_user, require_permission
from ...auth.models import User
from ...auth.permissions import CorePerm
from ...core.uploads import read_capped
from ...db.base import get_db
from ...tenancy.scope import Scope, get_scope
from . import schedule_import
from . import vocabulary as vocab
from .schemas import (
    CreateEquipmentRequest,
    CreateSystemRequest,
    DesignUpdate,
    EquipmentPublic,
    InfrastructureTree,
    PointBinding,
    SystemPublic,
    UpdateEquipmentRequest,
    UpdateSystemRequest,
)
from .service import InfrastructureService

router = APIRouter(prefix="/sites/{site_id}/infrastructure", tags=["Site infrastructure"])
vocabulary_router = APIRouter(prefix="/site-infrastructure", tags=["Site infrastructure"])

_READ = Depends(require_permission(CorePerm.SITES_READ))


async def _service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    user: Annotated[User, Depends(get_current_user)],
) -> InfrastructureService:
    # The same site confinement SiteService applies: a platform caller is never
    # confined, a tenant user only to their User.site_ids (empty = every site).
    site_ids = [] if scope.is_platform else list(user.site_ids or [])
    return InfrastructureService(db, scope, site_ids=site_ids)


Svc = Annotated[InfrastructureService, Depends(_service)]
Writer = Annotated[User, Depends(require_permission(CorePerm.SITES_UPDATE))]


@vocabulary_router.get("/vocabulary", dependencies=[_READ])
async def get_vocabulary() -> dict:
    """Every system kind, equipment class, slot and design fact the API accepts."""
    return vocab.as_document()


@router.get("", dependencies=[_READ])
async def get_tree(site_id: str, svc: Svc) -> InfrastructureTree:
    return await svc.tree(site_id)


# ── systems ─────────────────────────────────────────────────────────────────


@router.post("/systems", status_code=status.HTTP_201_CREATED)
async def create_system(
    site_id: str, body: CreateSystemRequest, svc: Svc, actor: Writer
) -> SystemPublic:
    return await svc.create_system(site_id, body, actor=actor)


@router.patch("/systems/{system_id}")
async def update_system(
    site_id: str, system_id: str, body: UpdateSystemRequest, svc: Svc, actor: Writer
) -> SystemPublic:
    return await svc.update_system(site_id, system_id, body, actor=actor)


@router.delete("/systems/{system_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_system(site_id: str, system_id: str, svc: Svc, actor: Writer) -> Response:
    await svc.delete_system(site_id, system_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── equipment ───────────────────────────────────────────────────────────────


@router.post("/equipment", status_code=status.HTTP_201_CREATED)
async def create_equipment(
    site_id: str, body: CreateEquipmentRequest, svc: Svc, actor: Writer
) -> EquipmentPublic:
    return await svc.create_equipment(site_id, body, actor=actor)


@router.get("/equipment/{equipment_id}", dependencies=[_READ])
async def get_equipment(site_id: str, equipment_id: str, svc: Svc) -> EquipmentPublic:
    return await svc.get_equipment(site_id, equipment_id)


@router.patch("/equipment/{equipment_id}")
async def update_equipment(
    site_id: str, equipment_id: str, body: UpdateEquipmentRequest, svc: Svc, actor: Writer
) -> EquipmentPublic:
    return await svc.update_equipment(site_id, equipment_id, body, actor=actor)


@router.put("/equipment/{equipment_id}/design")
async def set_design(
    site_id: str, equipment_id: str, body: DesignUpdate, svc: Svc, actor: Writer
) -> EquipmentPublic:
    """Replace the design facts as a SET: a fact left out or sent null is cleared."""
    return await svc.set_design(site_id, equipment_id, body, actor=actor)


@router.put("/equipment/{equipment_id}/slots/{slot}")
async def set_slot(
    site_id: str, equipment_id: str, slot: str, body: PointBinding, svc: Svc, actor: Writer
) -> EquipmentPublic:
    """Create or re-bind one slot. `{"device_tag": null, "point_tag": null}` leaves
    the slot declared and unbound."""
    return await svc.set_slot(site_id, equipment_id, slot, body, actor=actor)


@router.delete("/equipment/{equipment_id}/slots/{slot}")
async def remove_slot(
    site_id: str, equipment_id: str, slot: str, svc: Svc, actor: Writer
) -> EquipmentPublic:
    return await svc.remove_slot(site_id, equipment_id, slot, actor=actor)


@router.delete("/equipment/{equipment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_equipment(
    site_id: str, equipment_id: str, svc: Svc, actor: Writer
) -> Response:
    await svc.delete_equipment(site_id, equipment_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── I/O schedule import ─────────────────────────────────────────────────────


@router.post("/import")
async def import_schedule(
    site_id: str,
    svc: Svc,
    actor: Writer,
    file: Annotated[UploadFile, File(description="I/O schedule (.xlsx)")],
    dry_run: Annotated[bool, Query()] = True,
) -> dict:
    """Parse an I/O schedule and report what it would create — or create it.

    ``dry_run`` DEFAULTS TO TRUE, so a client that forgets the flag gets a report
    and not a registry. Writing takes an explicit ``dry_run=false``, and writes
    exactly the plan a dry run of the same file would have shown, in one commit.
    """
    site = await svc.site(site_id, for_write=True)
    content = await read_capped(
        file, limit=schedule_import.MAX_UPLOAD_BYTES, field="I/O schedule"
    )
    report = await schedule_import.plan(svc, site, content)
    if not dry_run:
        report = await schedule_import.apply(svc, site, report, actor=actor)
    return {"dry_run": dry_run, **report}
