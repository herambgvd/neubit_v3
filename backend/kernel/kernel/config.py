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

    # --- Trusted proxies (kernel.client_ip) --------------------------------
    # Networks whose `X-Forwarded-For` may be believed. EMPTY MEANS TRUST
    # NOTHING, which is the safe direction: the socket peer is used instead, so
    # an unset value under-attributes rather than letting a caller-set header
    # decide who they are. Same name and meaning as core's, so one `.env` sets
    # both. `deploy/docker-compose.yml` carries the value for this stack.
    trusted_proxy_cidrs: list[str] = []

    # --- CORS (frontend origins) ------------------------------------------
    cors_origins: list[str] = ["http://localhost:3000"]
    # Which ORIGINS may make credentialed cross-origin calls. This is a security
    # boundary, not a convenience setting: the middleware is mounted with
    # allow_credentials=True, so whatever matches here gets the browser's cookies
    # attached AND gets the response echoed back to it.
    #
    # It used to be `https?://.*`, which matches every website on the internet.
    # Verified against the running stack: a request carrying
    # `Origin: https://evil.example` came back with
    # `access-control-allow-origin: https://evil.example` and
    # `access-control-allow-credentials: true` — on /api/v1/auth/refresh, which
    # reads the httpOnly refresh cookie and returns a fresh access token in the
    # body. Any page an operator visited while signed in could take the session.
    #
    # The stated intent of the loose default was "the app opens from any machine
    # on the LAN", and that intent is kept: loopback, the three RFC 1918 ranges
    # and `*.local`. What is gone is the public internet. A deployment served from
    # a real hostname sets VE_CORS_ORIGINS (or this regex) to that hostname.
    cors_origin_regex: str = (
        r"^https?://(localhost|127\.0\.0\.1|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[A-Za-z0-9-]+\.local)(:\d+)?$"
    )


#: Every shipped default and .env.example placeholder. A deployment left on one of
#: these signs tokens and encrypts tenant credentials with a value that is in the
#: public repository. The empty string is here because an unset env var reaches
#: pydantic as "" rather than as the default, and an empty HMAC key makes every
#: token in the estate forgeable by anyone.
#:
#: KEPT IN STEP WITH core/app/core/api.py's _WEAK_SECRETS AND ITS LENGTH FLOORS.
#: They were not, and the weaker half was this one — which is the wrong way round.
#: Core MINTS the tokens and refused to boot on a short or empty secret; the six
#: satellites VERIFY them and accepted anything that was not one of two exact
#: strings. A deployment with VE_JWT_SECRET="" would have stopped core and left
#: access, ingest, vision, workflow and the reporting writer verifying tokens
#: signed with an empty key.
_WEAK_SECRETS = {
    "change-me-in-prod",
    "change-me-secret",
    "change-me-to-a-long-random-string-min-32-bytes",
    "change-me-another-long-random-string",
    "",
}

#: RFC 7518 §3.2: an HMAC key for HS256 must be at least as long as the hash
#: output. PyJWT warns below this and signs anyway. `secrets_key` is a KDF input
#: rather than a raw HMAC key, so it carries core's lower floor, not this one.
_MIN_JWT_SECRET = 32
_MIN_SECRETS_KEY = 16

#: Every placeholder this repository has ever shipped begins "change-me". The
#: exact-match set above did not actually cover the two values in
#: `deploy/.env.example` — it listed two near-miss variants that appear nowhere,
#: so copying the example and setting VE_ENV=prod booted the whole estate on a
#: secret that is in the public repository, with both guards reading as though
#: they had checked. A list is the wrong shape for this; a rule cannot drift.
_PLACEHOLDER_MARKER = "change-me"


def _is_placeholder(value: str) -> bool:
    return value in _WEAK_SECRETS or _PLACEHOLDER_MARKER in value.lower()


def _weak_secrets(settings: "Settings") -> list[str]:
    """Which secrets are unusable, and why. Empty means both are fine."""
    weak: list[str] = []
    if _is_placeholder(settings.jwt_secret):
        weak.append("VE_JWT_SECRET (shipped placeholder or empty)")
    elif len(settings.jwt_secret) < _MIN_JWT_SECRET:
        weak.append(
            f"VE_JWT_SECRET (needs >={_MIN_JWT_SECRET} chars for HS256, "
            f"has {len(settings.jwt_secret)})"
        )
    if _is_placeholder(settings.secrets_key):
        weak.append("VE_SECRETS_KEY (shipped placeholder or empty)")
    elif len(settings.secrets_key) < _MIN_SECRETS_KEY:
        weak.append(
            f"VE_SECRETS_KEY (needs >={_MIN_SECRETS_KEY} chars, "
            f"has {len(settings.secrets_key)})"
        )
    return weak


def _check_secrets(settings: "Settings") -> None:
    """Refuse to boot outside dev on a weak secret; warn loudly in dev.

    There was no guard at all. A service started without the env file silently
    accepted tokens anyone could forge and encrypted credentials under a key
    anyone could derive — and nothing said so, because pydantic-settings happily
    uses the default.

    Dev warns rather than refuses: a developer running one service by hand should
    not have to set up secrets first, and they are not protecting anything.
    """
    weak = _weak_secrets(settings)
    if not weak:
        return
    detail = "; ".join(weak)
    if settings.env.lower() in ("dev", "test", "local"):
        log.warning(
            "weak secret(s): %s — fine for env=%s, fatal anywhere else",
            detail, settings.env,
        )
        return
    raise RuntimeError(
        f"refusing to start in env={settings.env!r}: weak/default secret(s): {detail}. "
        "Tokens would be forgeable and stored credentials readable by anyone with "
        "the source. Set them, or set VE_ENV=dev."
    )


@lru_cache
def get_settings() -> Settings:
    """Cached singleton so we parse the environment only once."""
    settings = Settings()
    _check_secrets(settings)
    return settings
