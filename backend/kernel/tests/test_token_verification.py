"""What verify_token rejects.

The highest-risk file in the kernel had no test. A token with no `exp` was
accepted forever — as super-admin — and nothing here can revoke one.
"""

from __future__ import annotations

import datetime as dt
import uuid

import jwt
import pytest

from kernel.auth import verify_token
from kernel.config import get_settings
from kernel.errors import UnauthorizedError


def _secret() -> str:
    return get_settings().jwt_secret


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _claims(**over):
    base = {
        "sub": str(uuid.uuid4()),
        "type": "access",
        "exp": _now() + dt.timedelta(hours=1),
    }
    base.update(over)
    return base


def _token(**over) -> str:
    return jwt.encode(_claims(**over), _secret(), algorithm="HS256")


def test_a_valid_token_is_accepted():
    """Without this every rejection test below would pass on a broken verifier."""
    p = verify_token(_token(is_superadmin=True, permissions=["a.b"]))
    assert p.is_superadmin is True
    assert p.permissions == ["a.b"]


def test_a_token_with_no_exp_is_rejected():
    """PyJWT only checks a claim it finds, so this was accepted forever."""
    claims = _claims()
    del claims["exp"]
    with pytest.raises(UnauthorizedError):
        verify_token(jwt.encode(claims, _secret(), algorithm="HS256"))


def test_an_expired_token_is_rejected():
    with pytest.raises(UnauthorizedError):
        verify_token(_token(exp=_now() - dt.timedelta(minutes=2)))


def test_expiry_inside_the_leeway_is_still_accepted():
    """The 30s leeway is deliberate — appliances run without NTP — so a token that
    expired a second ago is accepted. Written down because it looks like a bug
    until you know why, and because it bounds how wrong the clock may be."""
    p = verify_token(_token(exp=_now() - dt.timedelta(seconds=5)))
    assert p.user_id is not None


def test_alg_none_is_rejected():
    """Algorithm confusion. HS256 is pinned in the decode call."""
    claims = _claims()
    with pytest.raises(UnauthorizedError):
        verify_token(jwt.encode(claims, None, algorithm="none"))


def test_a_token_signed_with_another_key_is_rejected():
    with pytest.raises(UnauthorizedError):
        verify_token(jwt.encode(_claims(), "not-the-platform-secret", algorithm="HS256"))


def test_a_refresh_token_is_not_an_access_token():
    with pytest.raises(UnauthorizedError):
        verify_token(_token(type="refresh"))


def test_a_token_with_no_subject_is_rejected():
    claims = _claims()
    del claims["sub"]
    with pytest.raises(UnauthorizedError):
        verify_token(jwt.encode(claims, _secret(), algorithm="HS256"))


def test_garbage_is_rejected_rather_than_crashing():
    for bad in ("", "not.a.token", "a.b.c"):
        with pytest.raises(UnauthorizedError):
            verify_token(bad)


def test_small_clock_skew_is_tolerated():
    """Appliances run without NTP. With no leeway a satellite whose clock trails
    core rejects fresh tokens, and it reads as 'invalid token'."""
    p = verify_token(_token(iat=_now() + dt.timedelta(seconds=10)))
    assert p.user_id is not None


def test_a_large_clock_skew_is_still_rejected():
    """The leeway is a tolerance, not a hole."""
    with pytest.raises(UnauthorizedError):
        verify_token(_token(exp=_now() - dt.timedelta(minutes=5)))


def test_claims_the_satellites_authorize_on_are_carried_through():
    p = verify_token(
        _token(
            tenant_id=str(uuid.uuid4()),
            permissions=["x.read"],
            features={"access": True},
            license_state="grace",
            tenant_status="suspended",
            site_ids=["s1"],
        )
    )
    assert p.tenant_id is not None
    assert p.grants("x.read")
    assert p.feature_enabled("access")
    assert p.tenant_suspended is True
    assert p.site_scoped() is True


def test_a_missing_claim_defaults_safely():
    """A token minted before a claim existed must not read as more privileged."""
    p = verify_token(_token())
    assert p.is_superadmin is False
    assert p.permissions == []
    assert p.tenant_id is None
    assert p.grants("anything") is False
