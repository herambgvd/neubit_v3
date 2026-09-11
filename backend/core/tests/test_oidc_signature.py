"""AN ID_TOKEN IS A CLAIM ABOUT WHO SOMEBODY IS. It has to be signed.

`_map_claims` turns an id_token's `email` into a user identity, so a token we do
not verify is an account-takeover primitive: anyone who can answer the token
endpoint — a compromised or hostile IdP, a tenant pointing SSO at their own server
— names any email they like and becomes that user.

This module used to decode with `verify_signature: False` behind a comment saying
production would do better. It never did, and nothing failed, because the only
test of the path was a mock that could not sign. So these tests are about the
three ways the check can be present and still be useless.
"""

from __future__ import annotations

import jwt
import pytest

from app.security.oidc_client import OidcError, _algorithms, exchange_code, verify_id_token


class _Cfg:
    client_id = "neubit-console"
    issuer = "https://idp"
    redirect_uri = "https://console/sso/callback"
    email_claim = "email"
    name_claim = "name"
    groups_claim = None


DISCOVERY = {
    "token_endpoint": "https://idp/token",
    "jwks_uri": "https://idp/jwks",
    "issuer": "https://idp",
}


def test_a_provider_with_no_jwks_is_refused_not_trusted():
    # No published key means no way to check the signature. The only safe answer is
    # to refuse the sign-in — falling back to an unverified decode is how this
    # module was wrong in the first place.
    with pytest.raises(OidcError, match="jwks_uri"):
        verify_id_token(jwt.encode({"email": "x@y.z"}, "k", algorithm="HS256"), {}, _Cfg)


class TestTheAlgorithmAllowList:
    """The subtle one, and the reason a naive implementation is still broken.

    Passing the provider's advertised algorithms straight through invites
    ALGORITHM CONFUSION: a discovery document that says HS256 asks us to verify an
    HMAC whose shared secret is the IdP's PUBLIC key. Anyone can read a public key.
    """

    def test_symmetric_algorithms_are_never_accepted(self):
        algs = _algorithms({"id_token_signing_alg_values_supported": ["RS256", "HS256"]})
        assert "HS256" not in algs
        assert "RS256" in algs

    def test_none_is_never_accepted(self):
        algs = _algorithms({"id_token_signing_alg_values_supported": ["none", "ES256"]})
        assert algs == ["ES256"]

    def test_a_provider_offering_nothing_we_accept_is_refused(self):
        # Better to fail the sign-in than to fall back to a default the provider
        # does not actually sign with.
        with pytest.raises(OidcError, match="asymmetric"):
            _algorithms({"id_token_signing_alg_values_supported": ["HS256", "none"]})

    def test_a_silent_provider_gets_our_own_list_not_a_free_pass(self):
        assert set(_algorithms({})) >= {"RS256", "ES256"}
        assert "HS256" not in _algorithms({})

    def test_the_advertised_list_can_only_narrow_ours(self):
        assert _algorithms({"id_token_signing_alg_values_supported": ["RS512"]}) == ["RS512"]


class _Resp:
    def __init__(self, data):
        self._data = data

    def json(self):
        return self._data


class _Idp:
    def __init__(self, id_token):
        self.id_token = id_token

    async def get(self, url):
        return _Resp(DISCOVERY)

    async def post(self, url, data):
        return _Resp({"id_token": self.id_token})


@pytest.mark.asyncio
async def test_exchange_verifies_by_default_rather_than_on_request():
    """The default matters more than the capability.

    A verifier that has to be asked for is one a future caller forgets, and the
    failure is silent — sign-in keeps working, it just stops being authentication.
    """
    idp = _Idp(jwt.encode({"email": "attacker@evil.io"}, "any-key", algorithm="HS256"))
    with pytest.raises(OidcError):
        await exchange_code(idp, DISCOVERY, _Cfg, "code", None)


@pytest.mark.asyncio
async def test_an_injected_verifier_is_used_when_one_is_given():
    # The test seam itself: explicit, per call, and impossible to acquire by
    # forgetting something.
    idp = _Idp(jwt.encode({"email": "dave@corp.io"}, "any-key", algorithm="HS256"))
    claims = await exchange_code(
        idp, DISCOVERY, _Cfg, "code", None,
        verify=lambda tok, _d, _c: jwt.decode(tok, options={"verify_signature": False}),
    )
    assert claims.email == "dave@corp.io"
