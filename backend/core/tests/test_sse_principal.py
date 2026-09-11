"""WHO IS THIS — the step before every SSE stream's permission check.

`principal_or_401` lived as a private copy in each of three stream modules:
byte-identical in two and differing by a comment in the third. That is the wrong
number of copies for any code and a bad one for code that decides whether a
request is authenticated at all — a fix applied to one of three is the failure
mode, and nothing would have reported the other two.

There is one now, and these are the refusals it has to keep making. Each is
distinct on purpose: "not an access token" and "expired" send an operator to
different places, and collapsing them into "unauthorized" is how a misconfigured
client gets debugged as a permissions problem.
"""

from __future__ import annotations

import datetime as dt

import jwt
import pytest
from fastapi import HTTPException

from app.core.config import get_settings
from app.core.sse_auth import extract_token, principal_or_401


class _Req:
    """Just the header bag — the function reads nothing else."""

    def __init__(self, headers: dict | None = None):
        self.headers = headers or {}


def _token(drop: str | None = None, **over) -> str:
    now = dt.datetime.now(dt.timezone.utc)
    claims = {
        "sub": "user-1",
        "type": "access",
        "exp": now + dt.timedelta(minutes=5),
        "iat": now,
        **over,
    }
    # `drop` rather than passing None: PyJWT 2.10+ refuses a `sub` that is present
    # and not a string, so `sub=None` never reaches our own check — it fails as an
    # invalid token instead, which is a different sentence for a different fault.
    if drop:
        claims.pop(drop, None)
    return jwt.encode(claims, get_settings().jwt_secret, algorithm="HS256")


class TestWhereTheTokenComesFrom:
    def test_the_query_string_wins(self):
        # A browser's EventSource cannot set headers, which is the whole reason
        # these streams accept ?token= at all.
        assert extract_token(_Req({"Authorization": "Bearer header-one"}), "query-one") == "query-one"

    def test_a_bearer_header_is_read_when_there_is_no_query_token(self):
        assert extract_token(_Req({"Authorization": "Bearer abc"}), None) == "abc"

    def test_the_header_name_is_read_either_way_round(self):
        assert extract_token(_Req({"authorization": "bearer abc"}), None) == "abc"

    def test_an_empty_bearer_is_no_token_rather_than_an_empty_one(self):
        # "Bearer " with nothing after it must not become the empty-string token,
        # which would then be decoded and refused for the wrong reason.
        assert extract_token(_Req({"Authorization": "Bearer   "}), None) is None

    def test_a_non_bearer_scheme_is_ignored(self):
        assert extract_token(_Req({"Authorization": "Basic abc"}), None) is None


class TestWhatItRefuses:
    def test_no_token_at_all(self):
        with pytest.raises(HTTPException) as e:
            principal_or_401(_Req(), None)
        assert e.value.status_code == 401
        assert "SSE auth required" in e.value.detail["message"]

    def test_a_token_it_did_not_sign(self):
        forged = jwt.encode({"sub": "x", "type": "access"}, "not-the-secret", algorithm="HS256")
        with pytest.raises(HTTPException) as e:
            principal_or_401(_Req(), forged)
        assert "invalid or expired" in e.value.detail["message"]

    def test_an_expired_token(self):
        old = _token(exp=dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=1))
        with pytest.raises(HTTPException) as e:
            principal_or_401(_Req(), old)
        assert "invalid or expired" in e.value.detail["message"]

    def test_a_refresh_token_used_as_an_access_token(self):
        # Distinct from "invalid": the signature is ours and the token is live. It
        # is the wrong KIND, and saying so is what stops this being debugged as a
        # signing problem.
        with pytest.raises(HTTPException) as e:
            principal_or_401(_Req(), _token(type="refresh"))
        assert "not an access token" in e.value.detail["message"]

    def test_a_token_naming_nobody(self):
        with pytest.raises(HTTPException) as e:
            principal_or_401(_Req(), _token(drop="sub"))
        assert "missing subject" in e.value.detail["message"]


def test_a_good_token_returns_its_claims():
    claims = principal_or_401(_Req(), _token())
    assert claims["sub"] == "user-1"
