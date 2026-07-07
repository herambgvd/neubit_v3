"""Reference scenario app = the platform base with no feature modules yet.

Run locally:   uvicorn example.main:app --reload
In Docker:     see ../docker-compose.yml (migrations run first, then this app).

The lifespan bootstraps the first admin from VE_BOOTSTRAP_ADMIN_EMAIL/PASSWORD
(only if the users table is empty). Copy this file into a real scenario, register
its feature modules, and you have a full app.
"""

from contextlib import asynccontextmanager

from app.app import create_base_app
from app.auth.service import AuthService
from app.core.config import get_settings
from app.core.logging import get_logger
from app.db.base import get_sessionmaker
from app.device_brands import seed_brands
from app.module_catalog import seed_modules
from app.tenancy.seed import seed_tenancy
from app.core import events_nats

log = get_logger("example")


@asynccontextmanager
async def lifespan(app):
    settings = get_settings()
    if settings.bootstrap_admin_email and settings.bootstrap_admin_password:
        async with get_sessionmaker()() as db:
            created = await AuthService(db).ensure_admin(
                settings.bootstrap_admin_email, settings.bootstrap_admin_password
            )
            if created:
                log.info("bootstrapped first admin: %s", settings.bootstrap_admin_email)
    # Multi-tenancy seeding: promote the bootstrap admin to super-admin and
    # ensure the Genius Vision tenant exists. Idempotent (safe every startup).
    async with get_sessionmaker()() as db:
        await seed_tenancy(db, bootstrap_admin_email=settings.bootstrap_admin_email)
    # Seed the platform catalogs (module registry + device brands). Idempotent.
    async with get_sessionmaker()() as db:
        await seed_modules(db)
        await seed_brands(db)
    await events_nats.connect()
    await events_nats.publish("system", "core", "startup", {"service": "core"})
    yield
    await events_nats.close()


app = create_base_app(title="Neubit Command Center", lifespan=lifespan)
