"""Shared settings for neubit_v3 services.

Mirrors the relevant subset of the platform core's ``app.core.config.Settings``
(same ``VE_`` env prefix, same field names) so that every service reads the SAME
env vars the core does — tokens, events, and DB URLs stay compatible across
services without duplicating config conventions.

Each service instantiates this once (cached) and passes ``database_url`` to the
db factory. Fields intentionally match core so a shared ``.env`` Just Works.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VE_", env_file=".env", extra="ignore")

    env: str = "dev"
    app_name: str = "neubit-service"

    # All versioned routers mount under this prefix (matches core).
    api_prefix: str = "/api/v1"

    # --- Databases (this service's OWN db) ---------------------------------
    database_url: str = "postgresql+asyncpg://neubit:neubit@localhost:5432/neubit"
    # DB-per-tenant (strong isolation, ARCHITECTURE.md §10). OFF = the shared-DB +
    # tenant_id row-scoping model (today's default; on-prem is naturally one tenant).
    # ON = each tenant's operational data lives in its OWN physical database
    # (``<base>_t_<tenant_hex>``): requests route by the JWT tenant claim, provisioning
    # creates the DB, offboard drops it. Flipping this is a DELIBERATE cutover (needs a
    # data migration of existing tenants) — never a hot toggle on a populated stack.
    db_per_tenant: bool = False
    # Server-side `statement_timeout` (milliseconds) applied to every connection
    # this service opens. 0 = unlimited, Postgres's own default.
    #
    # WHY IT IS NOT 0 FOR THE WRITE PATHS: a query with no timeout can hang
    # forever, and a hang is worse than an error because nothing reports it. A
    # writer blocked on a lock keeps its health flag TRUE (the last write
    # succeeded, and the current one has not failed — it just has not returned),
    # so /readyz stays green while nothing at all is being written. A statement
    # timeout converts that silence into an exception the retry/NAK path already
    # knows how to handle and the health flag already reflects.
    #
    # It is NOT a complete answer on its own: `docker compose pause postgres`
    # SIGSTOPs the server, so the server-side timer is frozen too and never
    # fires. That case needs the client-side stall detector in the pipelines.
    # The two cover different halves of "the database stopped answering".
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
    # Master key for credentials a service stores in its OWN database (SMTP
    # passwords, provider API tokens). Same env var, name and default as core's
    # setting of the same name, so one `.env` keys both and neither invents its own
    # convention. Additive: a service that encrypts nothing never reads it.
    # ROTATING IT RE-KEYS EVERY TENANT — see kernel/secrets.py, where a value that
    # no longer decrypts raises rather than being handed back as if it were plaintext.
    secrets_key: str = "change-me-secret"

    # --- CORS (frontend origins) ------------------------------------------
    cors_origins: list[str] = ["http://localhost:3000"]
    # Default allows any http(s) origin so a service opens from the LAN without
    # friction; the specific origin is echoed back (compatible with credentials).
    cors_origin_regex: str = r"https?://.*"


@lru_cache
def get_settings() -> Settings:
    """Cached singleton so we parse the environment only once."""
    return Settings()
