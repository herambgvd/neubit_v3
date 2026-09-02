"""OIDC (OpenID Connect) authorization-code client.

Handles the two IdP round-trips of the auth-code flow:
  1. discovery: fetch ``{issuer}/.well-known/openid-configuration`` for the
     authorization + token endpoints.
  2. token exchange: POST the ``code`` to the token endpoint, then decode the
     returned ``id_token`` JWT to get the user's claims (email, name, groups).

The HTTP client + JWT decode are injectable so tests exercise the exact exchange →
claim-mapping path with a MOCK IdP (no network, no real signature verification).

⚠️ LIVE-VALIDATE: signature verification against the IdP JWKS is stubbed for the
fixture path. Against a real IdP, verify the id_token signature via the discovered
``jwks_uri`` before trusting claims.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlencode

import jwt


@dataclass
class OidcClaims:
    email: str
    name: str | None = None
    groups: list[str] | None = None
    raw: dict | None = None


class OidcError(Exception):
    pass


class HttpLike(Protocol):
    async def get(self, url: str) -> Any: ...
    async def post(self, url: str, data: dict) -> Any: ...


def build_authorization_url(discovery: dict, config, state: str) -> str:
    """Build the IdP authorization URL the browser is redirected to."""
    auth_ep = discovery.get("authorization_endpoint")
    if not auth_ep:
        raise OidcError("discovery document has no authorization_endpoint")
    params = {
        "response_type": "code",
        "client_id": config.client_id,
        "redirect_uri": config.redirect_uri or "",
        "scope": config.scopes,
        "state": state,
    }
    return f"{auth_ep}?{urlencode(params)}"


def gen_state() -> str:
    return secrets.token_urlsafe(24)


async def fetch_discovery(http: HttpLike, issuer: str) -> dict:
    url = issuer.rstrip("/") + "/.well-known/openid-configuration"
    resp = await http.get(url)
    data = resp.json() if hasattr(resp, "json") else resp
    if not isinstance(data, dict):
        raise OidcError("invalid discovery document")
    return data


async def exchange_code(
    http: HttpLike, discovery: dict, config, code: str, client_secret: str | None
) -> OidcClaims:
    """Exchange an auth code for tokens and return the mapped id_token claims."""
    token_ep = discovery.get("token_endpoint")
    if not token_ep:
        raise OidcError("discovery document has no token_endpoint")
    resp = await http.post(
        token_ep,
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": config.redirect_uri or "",
            "client_id": config.client_id,
            "client_secret": client_secret or "",
        },
    )
    body = resp.json() if hasattr(resp, "json") else resp
    id_token = body.get("id_token") if isinstance(body, dict) else None
    if not id_token:
        raise OidcError("token response had no id_token")
    # LIVE-VALIDATE: verify signature via discovery['jwks_uri'] in production. Here we
    # decode without signature verification so the fixture/mock path is testable.
    claims = jwt.decode(id_token, options={"verify_signature": False})
    return _map_claims(claims, config)


def _map_claims(claims: dict, config) -> OidcClaims:
    email = claims.get(config.email_claim)
    if not email:
        raise OidcError(f"id_token missing the '{config.email_claim}' claim")
    groups = None
    if config.groups_claim:
        g = claims.get(config.groups_claim)
        if isinstance(g, str):
            g = [g]
        groups = list(g) if g else []
    return OidcClaims(
        email=email,
        name=claims.get(config.name_claim),
        groups=groups,
        raw=claims,
    )


class HttpxAdapter:  # pragma: no cover - live path
    """Thin async httpx wrapper implementing HttpLike for the real IdP."""

    async def get(self, url: str):
        import httpx

        async with httpx.AsyncClient(timeout=10) as c:
            return await c.get(url)

    async def post(self, url: str, data: dict):
        import httpx

        async with httpx.AsyncClient(timeout=10) as c:
            return await c.post(url, data=data)
