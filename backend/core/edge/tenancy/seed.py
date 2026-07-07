"""Idempotent multi-tenancy seeding, run on every startup.

Two effects, both safe to repeat:
  (a) Promote the bootstrap admin (VE_BOOTSTRAP_ADMIN_EMAIL) to a platform
      super-admin (is_superadmin=True, tenant_id NULL).
  (b) Ensure a "Genius Vision" tenant (slug 'genius-vision') exists, with a
      tenant-admin user herambmishra@geniusvision.in (Administrator role).

Call after AuthService.ensure_admin() in the app lifespan.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..core.logging import get_logger
from .models import Tenant
from .service import TenantService

log = get_logger("tenancy.seed")

GENIUS_VISION_SLUG = "genius-vision"
GENIUS_VISION_NAME = "Genius Vision"
GENIUS_VISION_ADMIN_EMAIL = "herambmishra@geniusvision.in"
GENIUS_VISION_ADMIN_PASSWORD = "India@2026"


async def seed_tenancy(db: AsyncSession, *, bootstrap_admin_email: str | None) -> None:
    """Ensure the super-admin + Genius Vision tenant exist. Idempotent."""
    # (a) Promote the bootstrap admin to super-admin (platform-wide).
    if bootstrap_admin_email:
        admin = (
            await db.execute(select(User).where(User.email == bootstrap_admin_email))
        ).scalar_one_or_none()
        if admin is not None and not admin.is_superadmin:
            admin.is_superadmin = True
            admin.tenant_id = None  # super-admins sit above all tenants
            await db.commit()
            log.info("promoted %s to super-admin", bootstrap_admin_email)

    # (b) Ensure the Genius Vision tenant + its tenant-admin exist.
    exists = (
        await db.execute(select(Tenant.id).where(Tenant.slug == GENIUS_VISION_SLUG))
    ).scalar_one_or_none()
    if exists is not None:
        return  # already seeded — nothing to do

    # Guard against a pre-existing user with that email (created some other way):
    # create_tenant would ConflictError, so skip tenant creation and just log.
    clash = (
        await db.execute(
            select(User.id).where(User.email == GENIUS_VISION_ADMIN_EMAIL)
        )
    ).scalar_one_or_none()
    if clash is not None:
        log.warning(
            "skipping Genius Vision seed: user %s already exists",
            GENIUS_VISION_ADMIN_EMAIL,
        )
        return

    tenant = await TenantService(db).create_tenant(
        GENIUS_VISION_NAME, GENIUS_VISION_ADMIN_EMAIL, GENIUS_VISION_ADMIN_PASSWORD
    )
    log.info("seeded tenant '%s' (%s) + admin %s", tenant.name, tenant.slug,
             GENIUS_VISION_ADMIN_EMAIL)
