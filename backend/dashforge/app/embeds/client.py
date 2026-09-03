"""The DashForge side of the wire: sign in as the service account, mint one
short-lived embed token.

TOKEN LIFETIME — the decision, and what it is protecting against
----------------------------------------------------------------
A DashForge embed token IS the credential. `GET /public/embed/:token` and
`POST /public/embed/:token/query` are unauthenticated by design, so anything
holding that string can read the dashboard, and the string travels in a URL path
segment: it lands in the iframe `src`, in the browser's history, in a `Referer`,
and in every proxy and access log between here and there. There is no session to
revoke — only the dashboard-wide epoch bump, which kills every viewer's token at
once.

So the question is not "is a token secret" (it cannot be) but "for how long does
a copied URL keep working".

REJECTED: mint once, store the token on the registration row, hand the same
string to every viewer. DashForge's own default TTL is 720 hours, which is right
for the case that endpoint was written for — a marketing dashboard pasted into a
public page once. Applied here it is the leak: one row would become a month-long
bearer credential to NeuBit-visible data, readable by anyone who ever opened the
page, present in logs, surviving the revocation of the NeuBit account it was
issued for, and revocable only by breaking the dashboard for everybody.

CHOSEN: mint per viewing session, `ttlMinutes` (VE_DASHFORGE_TOKEN_TTL_MINUTES,
default 15). The bound is the exposure window of a leaked URL, and 15 minutes is
picked from both ends:

  * not 1-2 minutes — the token is live for the whole time a dashboard is open
    and its widgets keep querying through it; a TTL near the refresh interval
    turns an idle tab into a stream of re-mints and makes every slow query a
    race against expiry;
  * not hours — that is long enough for a URL pulled out of a log or a shared
    screenshot to still answer, which is the entire failure this is bounding.

The frontend re-mints on `expires_at` while the tab is open, so the lifetime is
invisible in use and only bounds the copy.

What this does NOT fix, stated so nobody assumes it does: for those 15 minutes
the token is a valid credential for anyone who holds it. Narrowing WHAT it can
reach is the `scope` lock (models.py), not the TTL.

SERVICE-ACCOUNT SESSION
-----------------------
DashForge's mint route is authed, editor+, workspace-scoped. This service holds
one account and caches its access token in memory until shortly before expiry —
in memory and not in the database on purpose: a service credential that outlives
the process is a credential somebody has to remember to rotate, and re-logging in
after a restart costs one request. A 401 from the mint call drops the cached
token and retries ONCE, which is what makes a DashForge restart (new JWT secret,
or a rotated session) heal instead of requiring a NeuBit restart.
"""

from __future__ import annotations

import asyncio
import logging
import time

import httpx
from kernel.errors import AppError

from app.config import get_dashforge_settings

log = logging.getLogger("dashforge.client")


class DashForgeUnavailable(AppError):
    """DashForge could not be reached, or refused in a way retrying will not fix.

    Surfaced as 503 rather than bubbling an httpx error: an operator opening a
    dashboard needs to read that the peer is down, not a connection trace. This
    is deliberately NOT a 500 — nothing in NeuBit is broken.
    """

    status_code = 503
    code = "DASHFORGE_UNAVAILABLE"


class DashForgeRefused(AppError):
    """DashForge answered, and said no.

    Distinct from DashForgeUnavailable because the remedies are opposite: this
    one is not fixed by waiting. The most common cause is a `scope` naming a
    variable the dashboard does not expose as a global filter, or a widget whose
    query ignores every locked binding — both of which DashForge refuses at mint
    rather than serving a token that looks scoped and is not. Its message is
    passed through verbatim, because it names the offending widget or key and
    NeuBit could only make it vaguer.
    """

    status_code = 400
    code = "DASHFORGE_REFUSED"


# Re-login this many seconds before the cached access token's own expiry, so a
# mint never starts with a token that expires mid-flight.
_LOGIN_SKEW = 60.0
# How long a cached DashForge session is trusted without proof. DashForge access
# tokens are short-lived and this service does not parse them (reading another
# product's JWT claims is a coupling to its token format that buys nothing here),
# so the cache is bounded by a conservative wall clock and corrected by the 401
# retry below, which is the authority.
_SESSION_TTL = 10 * 60.0


class DashForgeClient:
    """One shared client. Cheap to hold: an in-memory session and nothing else."""

    def __init__(self) -> None:
        self._token: str | None = None
        self._token_expiry: float = 0.0
        # Concurrent page loads all miss the cache at once. Without this every
        # one of them logs in, which is a burst of failed-login-lockout material
        # against the service account on the peer's own rate limiter.
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
            # The one shape that reaches here with a 2xx and no token is a login
            # that wants a second factor. Named explicitly because the fix is a
            # configuration decision, not a retry: a service account cannot
            # answer a 2FA prompt.
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

        The caller has ALREADY been checked against `dashforge.read` — see
        `router.py`. Nothing in this function authorises anybody; it holds one
        privileged credential and must never be reachable from an ungated route.
        """
        cfg = get_dashforge_settings()
        if not cfg.enabled:
            raise DashForgeUnavailable(
                "the DashForge integration is not configured on this deployment "
                "(VE_DASHFORGE_BASE_URL / _EMAIL / _PASSWORD)"
            )

        body = {"ttlMinutes": cfg.token_ttl_minutes}
        # Emitted only when non-empty. An empty object and an absent key mean the
        # same thing to DashForge, but sending `{}` would make a scoped and an
        # unscoped registration indistinguishable in its request logs.
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
                # The cached session died under us (peer restart, rotated
                # secret). One forced re-login, then take the second answer as
                # final — retrying past that would loop against a service account
                # whose password is simply wrong.
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
        """DashForge's own error text, so the operator reads WHY.

        Its mint refusals name the widget or the filter key that caused them,
        which is information NeuBit cannot reconstruct and must not flatten into
        a status code.
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
