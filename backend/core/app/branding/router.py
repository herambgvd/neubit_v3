"""Branding API — read the white-label config (PUBLIC) + manage it (permissioned).

The GET is deliberately PUBLIC (no auth): the login page and every unauthenticated
screen must be able to theme themselves (name, logo, colours) before a user has a
token. The mutating endpoints require BRANDING_MANAGE.
"""

from __future__ import annotations

import os
import uuid

from fastapi import APIRouter, Depends, File, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.deps import require_permission
from ..auth.models import User
from ..auth.permissions import CorePerm
from ..core.storage import get_storage
from ..db.base import get_db
from ..tenancy.deps import optional_tenant_id
from . import service
from .models import Branding
from .schemas import BrandingOut, UpdateBrandingIn

router = APIRouter(prefix="/branding", tags=["branding"])


async def _to_out(branding: Branding) -> BrandingOut:
    """Serialise a Branding row into BrandingOut, resolving logo_key → logo_url.

    The DB holds a storage *key*; the client needs a fetchable *URL*. We resolve it
    here (once, at response time) via the storage backend — a stable local URL or a
    presigned S3 link depending on config. No logo → logo_url is None.
    """
    logo_url = await get_storage().url(branding.logo_key) if branding.logo_key else None
    return BrandingOut(
        id=branding.id,
        app_name=branding.app_name,
        logo_url=logo_url,
        primary_color=branding.primary_color,
        accent_color=branding.accent_color,
        name_in_header=branding.name_in_header,
    )


@router.get("", response_model=BrandingOut)
async def get_branding(
    db: AsyncSession = Depends(get_db),
    tenant_id=Depends(optional_tenant_id),
) -> BrandingOut:
    """PUBLIC — the current white-label config so the UI can theme itself.

    Returns the caller's tenant branding when a valid bearer token is present, else
    the platform default. Never raises on a missing/bad token — the login page must
    always be able to theme itself.
    """
    branding = await service.resolve(db, tenant_id)
    return await _to_out(branding)


@router.put("", response_model=BrandingOut)
async def update_branding(
    data: UpdateBrandingIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.BRANDING_MANAGE)),
) -> BrandingOut:
    """Update name / colours (partial). Logo is uploaded via POST /logo.

    A tenant-admin edits THEIR tenant's branding; a super-admin edits the default.
    """
    branding = await service.update(db, data, actor.tenant_id)
    return await _to_out(branding)


@router.post("/logo", response_model=BrandingOut)
async def upload_logo(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.BRANDING_MANAGE)),
) -> BrandingOut:
    """Accept a logo image, store it, and point the caller's branding at the new key.

    The uploaded file's extension is preserved so the served URL keeps a sensible
    content type; a random hex suffix keeps the key unique (cache-busts old logos).
    """
    data = await file.read()
    # Preserve the original extension (".png", ".svg", …) for a clean served URL.
    ext = os.path.splitext(file.filename or "")[1]
    key = f"branding/logo_{uuid.uuid4().hex}{ext}"
    await get_storage().put(key, data, file.content_type)
    branding = await service.set_logo(db, key, actor.tenant_id)
    return await _to_out(branding)
