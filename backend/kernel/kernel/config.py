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
    # Redis — Celery broker/result backend + realtime pub/sub.
    redis_url: str = "redis://localhost:6379/0"
    # NATS + JetStream event spine. Empty = events are no-ops (standalone).
    nats_url: str = ""

    # --- App auth (validate the core-minted JWT) ---------------------------
    # MUST be the same secret the core signs with (VE_JWT_SECRET) so tokens
    # minted by core verify here byte-for-byte (HS256).
    jwt_secret: str = "change-me-in-prod"

    # --- CORS (frontend origins) ------------------------------------------
    cors_origins: list[str] = ["http://localhost:3000"]
    # Default allows any http(s) origin so a service opens from the LAN without
    # friction; the specific origin is echoed back (compatible with credentials).
    cors_origin_regex: str = r"https?://.*"


@lru_cache
def get_settings() -> Settings:
    """Cached singleton so we parse the environment only once."""
    return Settings()
