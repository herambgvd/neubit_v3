"""Application settings.

All config comes from environment variables (prefix ``VE_``) or a ``.env`` file.
Never hardcode secrets or endpoints in code.

Example .env:
    VE_ENV=prod
    VE_DATABASE_URL=postgresql+asyncpg://neubit:secret@db:5432/neubit
    VE_LICENSE_TOKEN_FILE=/etc/neubit/license.jwt
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VE_", env_file=".env", extra="ignore")

    # Runtime environment. "dev" enables a permissive license fallback (see license.py).
    env: str = "dev"
    app_name: str = "vizor-edge-app"

    # --- API ---------------------------------------------------------------
    # All versioned routers mount under this prefix (bump to /api/v2 for a new version).
    api_prefix: str = "/api/v1"

    # --- Security policy ---------------------------------------------------
    password_min_length: int = 8
    password_require_number: bool = True
    password_require_letter: bool = True
    rate_limit_login_per_minute: int = 10
    # The API-key exchange has its own budget so it and login cannot starve
    # each other — see core/ratelimit.api_key_rate_limit.
    rate_limit_api_key_per_minute: int = 60
    # Global per-IP request cap across the whole API (0 disables it). A coarse
    # brute-force / abuse backstop on top of the stricter per-login limit.
    rate_limit_global_per_minute: int = 600
    # Where the rate-limit windows live: "redis" (shared by every worker) or
    # "memory" (per process, so N workers means N times the configured cap).
    # "memory" is for the offline test suite and single-process installs.
    rate_limit_backend: str = "redis"

    # Networks whose `X-Forwarded-For` may be believed. Empty means trust nothing
    # and use the socket peer. Behind a gateway this must name the gateway's
    # network, or every request shares one rate-limit bucket.
    trusted_proxy_cidrs: list[str] = []
    # Per-ACCOUNT brute-force lockout (complements the per-IP limit). Lock after
    # this many consecutive failed logins, for this many minutes (0 disables).
    lockout_max_attempts: int = 5
    lockout_minutes: int = 15
    # Password lifecycle. expiry_days=0 disables expiry; history_count blocks
    # reuse of the last N password hashes.
    password_expiry_days: int = 0
    password_history_count: int = 5
    # Require TOTP on every super-admin-gated endpoint. Off by default so the first
    # super-admin can enrol via /auth/me/2fa/* before turning it on.
    require_superadmin_2fa: bool = False

    # --- Sensitive-media protection (STQC / DPDP) --------------------------
    # Object keys under any of these prefixes are transparently encrypted at rest
    # (Fernet, keyed from secrets_key) and decrypted on read/serve. Empty = off.
    encrypt_media_prefixes: list[str] = []

    # --- Databases ---------------------------------------------------------
    database_url: str = "postgresql+asyncpg://vizor:vizor@localhost:5432/vizor"
    # Redis — Celery broker/result backend + realtime pub/sub.
    redis_url: str = "redis://localhost:6379/0"
    # NATS + JetStream event spine. Empty = events are no-ops (standalone core).
    nats_url: str = ""
    # MediaMTX control API (camera path register / republish / record).
    mediamtx_url: str = "http://localhost:9997"

    # --- App auth (the app's own users, NOT the license) -------------------
    jwt_secret: str = "change-me-in-prod"
    jwt_ttl_minutes: int = 60 * 12
    # TTL of the access token an API key is exchanged for. Much shorter than a
    # human's 12 hours because satellites verify statelessly and cannot learn a key
    # was revoked — this is the width of that residual window. Core itself refuses
    # immediately. Keep it short: a machine re-exchanges on 401 with no human.
    api_key_token_ttl_minutes: int = 15

    # --- Refresh token cookie (httpOnly hardening) -------------------------
    # httpOnly so JavaScript, and therefore XSS, can never read the refresh token.
    # The short-lived access token stays in SPA memory. See app/auth/cookies.py.
    refresh_cookie_name: str = "nb_refresh"
    # "lax" is correct when the admin UI and API share an origin (recommended).
    # Use "none" only for a cross-site setup — it then also requires Secure.
    refresh_cookie_samesite: str = "lax"
    # Secure flag. Off in dev (plain HTTP); force on outside dev, or override.
    refresh_cookie_secure: bool | None = None

    # Key used to derive the Fernet cipher that encrypts integration secrets
    # (SMTP / FCM / S3 credentials) stored in the DB. Rotate to re-key.
    secrets_key: str = "change-me-secret"

    # First-run bootstrap: if set and the users table is empty, the app creates
    # this admin (with the built-in Administrator role) on startup.
    bootstrap_admin_email: str | None = None
    bootstrap_admin_password: str | None = None

    # --- Licensing (see core/license.py) -----------------------------------
    # Provide the token inline OR via a file; same for the verification public key.
    license_token: str | None = None
    license_token_file: str | None = None
    license_public_key: str | None = None
    license_public_key_file: str | None = "license_pub.pem"
    # Whole-deployment license expiry: the on-prem model, one signed license gating
    # the app. Set false in the multi-tenant edition, which gates per tenant per
    # request — otherwise one global license blocks every tenant.
    license_enforce_global: bool = True

    # --- Object storage (logos, exports, snapshots, clips) -----------------
    # Public base URL of the frontend — used to build links inside emails
    # (invites, password resets). Set to the real domain in production.
    frontend_url: str = "http://localhost:3000"
    storage_backend: str = "local"            # "local" | "s3"
    storage_local_dir: str = "./data/storage"
    storage_base_url: str = "/files"          # public URL prefix for local files
    # Key prefixes whose /files URLs must carry a signature and an expiry.
    # `/files/{key}` is public, which is right for an avatar (unguessable key,
    # loaded from an <img>) and wrong for a report export, where an unsigned link
    # would outlive the `report.export` check forever. A prefix rule rather than
    # "everything", because signing avatars breaks every <img> the console renders.
    signed_url_prefixes: list[str] = ["reports/"]
    # Short on purpose: the console follows the url immediately, so this is a
    # hand-off window, not a session.
    signed_url_ttl_seconds: int = 300

    # How often an open SSE stream re-checks its caller. Without it a deactivated
    # user keeps their feed until the token expires. This is the staleness bound.
    sse_revalidate_seconds: int = 60
    s3_endpoint: str | None = None            # e.g. http://minio:9000 (None = AWS)
    s3_region: str = "us-east-1"
    s3_bucket: str | None = None
    s3_access_key: str | None = None
    s3_secret_key: str | None = None

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


@lru_cache
def get_settings() -> Settings:
    """Cached singleton: the environment is parsed once."""
    return Settings()
