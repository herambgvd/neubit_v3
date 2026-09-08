"""Branding API — read the white-label config (PUBLIC) + manage it (permissioned).

The GET is deliberately PUBLIC (no auth): the login page and every unauthenticated
screen must be able to theme themselves (name, logo, favicon) before a user has a
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
from ..core.uploads import read_capped, validate_image
from ..db.base import get_db
from ..tenancy.deps import optional_tenant_id
from . import service
from .models import Branding
from .schemas import BrandingOut, UpdateBrandingIn

router = APIRouter(prefix="/branding", tags=["branding"])

#: The one route here that must answer without a credential: the login page has to
#: theme itself before anyone has signed in.
#:
#: Separate from `router` because `app/app.py` guards whole routers with
#: `require_tenant_active`, which resolves an actor — folding this route back in
#: makes it a 401. `optional_tenant_id` already handles the anonymous case.
public_router = APIRouter(prefix="/branding", tags=["branding"])


async def _to_out(branding: Branding) -> BrandingOut:
    """Serialise a Branding row into BrandingOut, resolving logo_key → logo_url.

    The DB holds a storage key; the client needs a fetchable URL, resolved here at
    response time (local URL or presigned S3, per config). No logo → logo_url None.
    """
    storage = get_storage()
    logo_url = await storage.url(branding.logo_key) if branding.logo_key else None
    favicon_url = await storage.url(branding.favicon_key) if branding.favicon_key else None
    return BrandingOut(
        id=branding.id,
        app_name=branding.app_name,
        logo_url=logo_url,
        favicon_url=favicon_url,
    )


@public_router.get("", response_model=BrandingOut)
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
    """Update the app name. The logo and favicon are uploads (POST /logo, /favicon).

    A tenant-admin edits their own tenant's branding; a super-admin edits the default.
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
    # read_capped, not file.read() — the 8 MiB cap has to stop the read, not report
    # on it afterwards. See core/uploads.py.
    data = await read_capped(file, field="Logo")
    # Extension from the validated content type, not the uploaded filename, so the
    # served URL cannot be made to end in .html. See core/uploads.py.
    ctype, ext = validate_image(data, file.content_type, field="Logo")
    key = f"branding/logo_{uuid.uuid4().hex}{ext}"
    await get_storage().put(key, data, ctype)
    branding = await service.set_logo(db, key, actor.tenant_id)
    return await _to_out(branding)


@router.post("/favicon", response_model=BrandingOut)
async def upload_favicon(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.BRANDING_MANAGE)),
) -> BrandingOut:
    """Accept a favicon image, store it, and point the caller's branding at it.

    A SEPARATE image from the logo, not a resize of it: the favicon is read at 16px
    in a browser tab, where a wordmark that works in a header is a grey smudge.

    Same handling as the logo — `read_capped` so the cap stops the read rather than
    reporting on it afterwards, and the extension taken from the VALIDATED content
    type rather than the uploaded filename, so the served URL cannot be made to end
    in .html. See core/uploads.py.
    """
    data = await read_capped(file, field="Favicon")
    ctype, ext = validate_image(data, file.content_type, field="Favicon")
    key = f"branding/favicon_{uuid.uuid4().hex}{ext}"
    await get_storage().put(key, data, ctype)
    branding = await service.set_favicon(db, key, actor.tenant_id)
    return await _to_out(branding)


# Mounted by app/app.py alongside `router`; kept separate so the tenant-active
# guard applies to the writes and not to the public read.
