"""Idempotent multi-tenancy seeding, run on every startup.

Two effects, both safe to repeat:
  (a) Promote the bootstrap admin (VE_BOOTSTRAP_ADMIN_EMAIL) to a platform
      super-admin (is_superadmin=True, tenant_id NULL).
  (b) Ensure a "Genius Vision" tenant (slug 'genius-vision') exists, with a
      tenant-admin user herambmishra@geniusvision.in (Administrator role).

Call after AuthService.ensure_admin() in the app lifespan.
"""

from __future__ import annotations

import os

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
# The tenant-admin seed password is read from the environment — never hardcode a
# secret in source. If VE_SEED_TENANT_PASSWORD is unset, the tenant seed is SKIPPED
# (create the tenant later via the /admin API instead).
SEED_TENANT_PASSWORD_ENV = "VE_SEED_TENANT_PASSWORD"


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

    # The seed password MUST come from the environment — no hardcoded secret. Without
    # it we cannot create the tenant admin, so skip the tenant seed entirely (the
    # super-admin can create the tenant later via POST /admin/tenants).
    seed_password = os.environ.get(SEED_TENANT_PASSWORD_ENV)
    if not seed_password:
        log.info(
            "skipping Genius Vision seed: %s not set (create the tenant via the "
            "/admin API instead)",
            SEED_TENANT_PASSWORD_ENV,
        )
        return

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
        GENIUS_VISION_NAME, GENIUS_VISION_ADMIN_EMAIL, seed_password
    )
    log.info("seeded tenant '%s' (%s) + admin %s", tenant.name, tenant.slug,
             GENIUS_VISION_ADMIN_EMAIL)
