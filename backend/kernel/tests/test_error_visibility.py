"""A refusal has to leave a trace.

Nothing recorded a 401 or a 403 in any of the seven services on this kernel. So
brute-force attempts, permission probing, and the NOT_FOUND that assert_owned
returns for a cross-tenant id were all invisible.
"""

from __future__ import annotations

import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kernel.errors import ForbiddenError, NotFoundError, UnauthorizedError, register_error_handlers


@pytest.fixture
def app():
    application = FastAPI()
    register_error_handlers(application)

    @application.get("/unauthorized")
    def _unauthorized():
        raise UnauthorizedError("no token")

    @application.get("/forbidden")
    def _forbidden():
        raise ForbiddenError("not yours")

    @application.get("/missing")
    def _missing():
        raise NotFoundError("gone")

    @application.get("/fine")
    def _fine():
        return {"ok": True}

    return application


@pytest.mark.parametrize("path,status", [("/unauthorized", 401), ("/forbidden", 403)])
def test_a_refusal_is_logged_at_warning(app, caplog, path, status):
    with caplog.at_level(logging.WARNING, logger="kernel.error"):
        r = TestClient(app, raise_server_exceptions=False).get(path)
    assert r.status_code == status
    text = " ".join(rec.getMessage() for rec in caplog.records)
    assert path in text and str(status) in text


def test_a_not_found_is_logged_quieter(app, caplog):
    """A 404 is traffic, not a signal — but assert_owned answers 404 for a
    cross-tenant id, so it must not be silent either."""
    with caplog.at_level(logging.INFO, logger="kernel.error"):
        r = TestClient(app, raise_server_exceptions=False).get("/missing")
    assert r.status_code == 404
    records = [rec for rec in caplog.records if "/missing" in rec.getMessage()]
    assert records and all(rec.levelno < logging.WARNING for rec in records)


def test_a_successful_request_logs_nothing(app, caplog):
    """Otherwise the log is noise, and noise is how a real refusal gets missed."""
    with caplog.at_level(logging.INFO, logger="kernel.error"):
        assert TestClient(app).get("/fine").status_code == 200
    assert not caplog.records


def test_the_envelope_still_carries_the_code(app):
    """Logging must not change what a caller sees."""
    body = TestClient(app, raise_server_exceptions=False).get("/forbidden").json()
    assert body["error"]["code"] == "FORBIDDEN"
    assert body["error"]["message"] == "not yours"
