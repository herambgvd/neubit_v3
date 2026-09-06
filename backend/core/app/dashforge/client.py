"""The DashForge side of the wire: sign in as the service account, mint one
short-lived embed token.

Token lifetime: an embed token *is* the credential — the public embed routes are
unauthenticated and the token travels in a URL path segment (iframe src, history,
Referer, proxy logs), with no per-token revocation. So mint one per viewing
session with a short `ttlMinutes` (VE_DASHFORGE_TOKEN_TTL_MINUTES, default 15)
rather than storing one long-lived token on the registration row. Do not raise
the TTL to hours: it only bounds how long a leaked URL keeps working. The
frontend re-mints on `expires_at`. Narrowing *what* a token can reach is the
`scope` lock in models.py, not the TTL.

Service account: the mint route is authed and workspace-scoped. The access token
is cached in memory only — a credential outliving the process is one somebody has
to rotate, and re-login costs one request. A 401 on mint drops the cache and
retries once, so a DashForge restart heals without restarting NeuBit. The cache
is per process, so each core worker holds its own session.
"""

from __future__ import annotations

import asyncio
import time

import httpx

from ..core.errors import AppError
from ..core.logging import get_logger
from .config import get_dashforge_settings

log = get_logger("dashforge.client")


class DashForgeUnavailable(AppError):
    """DashForge could not be reached.

    503, not 500: the peer is down, nothing in NeuBit is broken. Surfaced instead
    of the raw httpx error so the operator reads something useful.
    """

    status_code = 503
    code = "DASHFORGE_UNAVAILABLE"


class DashForgeRefused(AppError):
    """DashForge answered and refused. Unlike DashForgeUnavailable, waiting will not fix it.

    Usually a `scope` naming a variable the dashboard does not expose as a global
    filter, or a widget whose query ignores every locked binding. DashForge's
    message is passed through verbatim — it names the offending widget or key.
    """

    status_code = 400
    code = "DASHFORGE_REFUSED"


# Re-login this many seconds before the cached access token's own expiry, so a
# mint never starts with a token that expires mid-flight.
_LOGIN_SKEW = 60.0
# How long a cached DashForge session is trusted. The token is not parsed (that
# would couple us to another product's JWT format), so the cache is bounded by a
# conservative wall clock and corrected by the 401 retry below.
_SESSION_TTL = 10 * 60.0


class DashForgeClient:
    """One shared client. Cheap to hold: an in-memory session and nothing else."""

    def __init__(self) -> None:
        self._token: str | None = None
        self._token_expiry: float = 0.0
        # Concurrent page loads all miss the cache at once; without this they each
        # log in and trip the peer's rate limiter on the service account.
        self._lock = asyncio.Lock()

    # --- session ----------------------------------------------------------
    async def _login(self, client: httpx.AsyncClient) -> str:
        cfg = get_dashforge_settings()
        try:
            r = await client.post(
                "/api/v1/auth/login",
                json={"email": cfg.email, "password": cfg.password},
            )
        except httpx.HTTPError as e:
            raise DashForgeUnavailable(f"could not reach DashForge: {e}") from e
        if r.status_code // 100 != 2:
            raise DashForgeUnavailable(
                f"DashForge rejected the service account login ({r.status_code})"
            )
        body = r.json() or {}
        token = body.get("accessToken")
        if not token:
            # 2xx with no token means the login wants a second factor. Named
            # explicitly because the fix is configuration, not a retry — a service
            # account cannot answer a 2FA prompt.
            raise DashForgeUnavailable(
                "DashForge login returned no access token"
                + (" (the service account requires 2FA)" if body.get("mfaRequired") else "")
            )
        return token

    async def _session(self, client: httpx.AsyncClient, *, force: bool = False) -> str:
        async with self._lock:
            now = time.monotonic()
            if force or not self._token or now >= self._token_expiry - _LOGIN_SKEW:
                self._token = await self._login(client)
                self._token_expiry = now + _SESSION_TTL
            return self._token

    # --- mint -------------------------------------------------------------
    async def mint_embed_token(
        self, *, workspace_ref: str, dashboard_ref: str, scope: dict | None
    ) -> dict:
        """Mint one embed token for a dashboard. Returns DashForge's own payload.

        The caller is already checked against `dashforge.read` in router.py.
        Nothing here authorises anybody, and it holds a privileged credential, so
        it must never be reachable from an ungated route.
        """
        cfg = get_dashforge_settings()
        if not cfg.enabled:
            raise DashForgeUnavailable(
                "the DashForge integration is not configured on this deployment "
                "(VE_DASHFORGE_BASE_URL / _EMAIL / _PASSWORD)"
            )

        body = {"ttlMinutes": cfg.token_ttl_minutes}
        # Emitted only when non-empty. `{}` and an absent key mean the same to
        # DashForge, but sending `{}` hides the scoped/unscoped split in its logs.
        if scope:
            body["scope"] = scope

        path = f"/api/v1/dashboards/{dashboard_ref}/embed-token"
        headers_extra = {"X-Workspace-ID": workspace_ref}

        async with httpx.AsyncClient(
            base_url=cfg.base_url.rstrip("/"), timeout=cfg.timeout_seconds
        ) as client:
            token = await self._session(client)
            r = await self._post(client, path, token, headers_extra, body)
            if r.status_code == 401:
                # Cached session died (peer restart, rotated secret). One forced
                # re-login, then take the second answer as final — retrying past
                # that loops forever if the password is simply wrong.
                token = await self._session(client, force=True)
                r = await self._post(client, path, token, headers_extra, body)

        if r.status_code // 100 == 2:
            return r.json() or {}
        if r.status_code in (400, 403, 404):
            raise DashForgeRefused(self._message(r, "DashForge refused to mint an embed token"))
        raise DashForgeUnavailable(
            f"DashForge could not mint an embed token ({r.status_code})"
        )

    @staticmethod
    async def _post(
        client: httpx.AsyncClient, path: str, token: str, extra: dict, body: dict
    ) -> httpx.Response:
        try:
            return await client.post(
                path, json=body, headers={"Authorization": f"Bearer {token}", **extra}
            )
        except httpx.HTTPError as e:
            raise DashForgeUnavailable(f"could not reach DashForge: {e}") from e

    @staticmethod
    def _message(r: httpx.Response, fallback: str) -> str:
        """DashForge's own error text, falling back to `fallback`.

        Its mint refusals name the offending widget or filter key, which NeuBit
        cannot reconstruct — don't flatten it into a status code.
        """
        try:
            payload = r.json() or {}
        except ValueError:
            return fallback
        err = payload.get("error")
        if isinstance(err, str) and err:
            return err
        if isinstance(err, dict) and err.get("message"):
            return str(err["message"])
        return fallback


# One instance per process, so the session cache is actually shared.
client = DashForgeClient()
