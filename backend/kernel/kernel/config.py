"""Shared settings for neubit_v3 services.

Mirrors the relevant subset of core's ``app.core.config.Settings`` — same ``VE_``
prefix, same field names — so tokens, events and DB URLs stay compatible and one
shared ``.env`` serves everything.

Each service instantiates this once (cached) and passes ``database_url`` to the
db factory.
"""

from __future__ import annotations

import logging

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


log = logging.getLogger("kernel.config")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VE_", env_file=".env", extra="ignore")

    env: str = "dev"
    app_name: str = "neubit-service"

    # All versioned routers mount under this prefix (matches core).
    api_prefix: str = "/api/v1"

    # --- Databases (this service's OWN db) ---------------------------------
    database_url: str = "postgresql+asyncpg://neubit:neubit@localhost:5432/neubit"
    # DB-per-tenant (ARCHITECTURE.md §10). Off: shared DB with tenant_id row
    # scoping, today's default. On: each tenant gets its own physical database
    # (``<base>_t_<tenant_hex>``), routed by the JWT tenant claim, created on
    # provision and dropped on offboard. Flipping it is a cutover needing a data
    # migration, never a hot toggle on a populated stack.
    db_per_tenant: bool = False
    # Server-side `statement_timeout` (ms) on every connection this service opens.
    # 0 = unlimited, Postgres's default. Set it on write paths: a query with no
    # timeout hangs forever and nothing reports it — a writer blocked on a lock
    # keeps /readyz green while nothing is written. The timeout turns that silence
    # into an exception the retry/NAK path already handles.
    #
    # Not a complete answer: a SIGSTOPped server (`docker compose pause postgres`)
    # freezes the server-side timer too, which is what the pipelines' client-side
    # stall detector covers.
    db_statement_timeout_ms: int = 0
    # Redis — Celery broker/result backend + realtime pub/sub.
    redis_url: str = "redis://localhost:6379/0"
    # NATS + JetStream event spine. Empty = events are no-ops (standalone).
    nats_url: str = ""

    # --- App auth (validate the core-minted JWT) ---------------------------
    # MUST be the same secret the core signs with (VE_JWT_SECRET) so tokens
    # minted by core verify here byte-for-byte (HS256).
    jwt_secret: str = "change-me-in-prod"

    # --- Secrets at rest (kernel.secrets) ----------------------------------
    # Master key for credentials a service stores in its own database (SMTP
    # passwords, provider API tokens). Same env var, name and default as core's,
    # so one `.env` keys both. Rotating it re-keys every tenant, and a value that
    # no longer decrypts raises — see kernel/secrets.py.
    secrets_key: str = "change-me-secret"

    # --- CORS (frontend origins) ------------------------------------------
    cors_origins: list[str] = ["http://localhost:3000"]
    # Any http(s) origin by default so a service opens from the LAN; the specific
    # origin is echoed back, which keeps credentialed requests working.
    cors_origin_regex: str = r"https?://.*"


#: The shipped placeholders. A deployment left on one of these signs tokens and
#: encrypts tenant credentials with a value that is in the public repository.
_PLACEHOLDERS = {
    "jwt_secret": "change-me-in-prod",
    "secrets_key": "change-me-secret",
}


def _check_secrets(settings: "Settings") -> None:
    """Refuse to boot outside dev on a placeholder secret; warn loudly in dev.

    There was no guard at all. A service started without the env file silently
    accepted tokens anyone could forge and encrypted credentials under a key
    anyone could derive — and nothing said so, because pydantic-settings happily
    uses the default.

    Dev warns rather than refuses: a developer running one service by hand should
    not have to set up secrets first, and they are not protecting anything.
    """
    left = [name for name, value in _PLACEHOLDERS.items() if getattr(settings, name) == value]
    if not left:
        return
    names = ", ".join(f"VE_{n.upper()}" for n in sorted(left))
    if settings.env.lower() in ("dev", "test", "local"):
        log.warning(
            "%s left at the shipped placeholder — fine for env=%s, fatal anywhere else",
            names, settings.env,
        )
        return
    raise RuntimeError(
        f"{names} still at the shipped placeholder with VE_ENV={settings.env!r}. "
        "Tokens would be forgeable and stored credentials readable by anyone with "
        "the source. Set them, or set VE_ENV=dev."
    )


@lru_cache
def get_settings() -> Settings:
    """Cached singleton so we parse the environment only once."""
    settings = Settings()
    _check_secrets(settings)
    return settings
