"""OIDC (OpenID Connect) authorization-code client.

Handles the two IdP round-trips of the auth-code flow:
  1. discovery: fetch ``{issuer}/.well-known/openid-configuration`` for the
     authorization + token endpoints.
  2. token exchange: POST the ``code`` to the token endpoint, then decode the
     returned ``id_token`` JWT to get the user's claims (email, name, groups).

The HTTP client and the id_token verifier are injectable, so a test exercises the
exact exchange → claim-mapping path against a MOCK IdP without a network.

THE SIGNATURE IS VERIFIED, and it was not always. This module used to decode the
id_token with ``verify_signature: False`` and a comment promising that production
would do better — so the only thing standing between an attacker and an account
was that the token arrived over TLS from an endpoint named in a discovery document.
``_map_claims`` turns that token's ``email`` claim into a user identity, which
makes an unverified id_token an account-takeover primitive the moment any tenant
configures SSO.

Verification is now the DEFAULT and the test seam is an explicit parameter, rather
than the whole check being switched off so a fixture could pass. A test that needs
an unsigned token passes its own decoder and says so locally; production cannot
inherit that by accident.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
import asyncio
from typing import Any, Callable, Protocol
from urllib.parse import urlencode

import jwt
from jwt import PyJWKClient


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


# ASYMMETRIC ONLY, and this is the part that is easy to get wrong.
#
# The obvious implementation passes whatever ``id_token_signing_alg_values_supported``
# says. That is an algorithm-confusion hole: a discovery document advertising HS256
# invites us to verify an HMAC using the IdP's PUBLIC key as the shared secret — and
# the public key is, by definition, public. Anyone holding it could then mint a
# token we would accept. So the IdP's list only ever NARROWS this one.
#
# "none" is excluded by construction for the same reason, and PyJWT refuses it
# anyway; being explicit costs nothing and survives a dependency change.
_ALLOWED_ALGS = ("RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512")


def _algorithms(discovery: dict) -> list[str]:
    advertised = discovery.get("id_token_signing_alg_values_supported")
    if not isinstance(advertised, list) or not advertised:
        return list(_ALLOWED_ALGS)
    allowed = [a for a in advertised if a in _ALLOWED_ALGS]
    if not allowed:
        raise OidcError(
            "the provider advertises no asymmetric id_token signing algorithm we accept"
        )
    return allowed


def verify_id_token(id_token: str, discovery: dict, config) -> dict:
    """Decode an id_token only if the IdP actually signed it.

    Three checks, and all three matter:
      * SIGNATURE, against the key the provider publishes at ``jwks_uri``. Without
        it the rest is decoration — anybody can write claims.
      * AUDIENCE, so a token minted for a DIFFERENT client of the same IdP cannot be
        replayed here. Shared identity providers are the normal case.
      * ISSUER, so a token from another provider entirely is refused even if it is
        genuinely signed.
    """
    jwks_uri = discovery.get("jwks_uri")
    if not jwks_uri:
        raise OidcError("discovery document has no jwks_uri, so the id_token cannot be verified")
    try:
        # PyJWKClient caches fetched keys, so a key rotation costs one extra fetch
        # rather than one per sign-in.
        signing_key = PyJWKClient(jwks_uri).get_signing_key_from_jwt(id_token)
        return jwt.decode(
            id_token,
            signing_key.key,
            algorithms=_algorithms(discovery),
            audience=config.client_id,
            issuer=discovery.get("issuer") or config.issuer,
        )
    except OidcError:
        raise
    except Exception as exc:  # noqa: BLE001 — every failure here means "do not trust it"
        raise OidcError(f"the id_token could not be verified: {exc}") from exc


async def exchange_code(
    http: HttpLike,
    discovery: dict,
    config,
    code: str,
    client_secret: str | None,
    *,
    verify: Callable[[str, dict, Any], dict] | None = None,
) -> OidcClaims:
    """Exchange an auth code for tokens and return the mapped id_token claims.

    ``verify`` exists for tests against a mock IdP that cannot sign. It defaults to
    real verification, so a caller that forgets it gets the safe behaviour — the
    opposite of the arrangement this replaced, where verification was off for
    everyone so that the fixture would pass.
    """
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
    check = verify or verify_id_token
    # Off the event loop: PyJWKClient fetches the JWKS with blocking I/O, and a
    # sign-in is not worth stalling every other request in the process for.
    claims = await asyncio.to_thread(check, id_token, discovery, config)
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
