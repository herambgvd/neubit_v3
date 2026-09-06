"""The link to a controller carries its password, so say when it is unprotected.

verify_tls feeds httpx's `verify=` and defaulted to False; base_url also accepts
http://. Neither is blocked — controllers are usually LAN boxes with self-signed
certs — but both are now logged. These pin the default and the warnings.
"""

from __future__ import annotations

import logging

import pytest

from app.connectors.factory import get_connector


class _Inst:
    """The attributes the factory reads off an Instance row."""

    def __init__(self, base_url: str, verify_tls: bool = True, name: str = "ctrl-1"):
        self.brand = "dds"
        self.base_url = base_url
        self.auth_type = "basic"
        self.username = "svc"
        self.verify_tls = verify_tls
        self.name = name


def test_a_new_instance_verifies_tls_by_default():
    """The API schema's default is what an operator with no opinion gets."""
    from app.access.schemas import InstanceCreate

    body = InstanceCreate(name="c", base_url="https://ctrl.example")
    assert body.verify_tls is True


def test_the_factory_defaults_to_verifying_when_the_row_says_nothing():
    class Bare:
        brand = "dds"
        base_url = "https://ctrl.example"
        auth_type = "basic"
        username = "svc"
        name = "bare"
        # no verify_tls attribute at all

    conn = get_connector(Bare(), secret="pw")
    assert conn.verify_tls is True


def test_the_stored_value_still_wins():
    """An operator who deliberately turned it off keeps it off — the fix is a
    default, not an override. Otherwise every self-signed deployment breaks."""
    conn = get_connector(_Inst("https://ctrl.example", verify_tls=False), secret="pw")
    assert conn.verify_tls is False


def test_disabled_verification_is_logged_with_the_instance_named(caplog):
    with caplog.at_level(logging.WARNING, logger="access.connector"):
        get_connector(_Inst("https://ctrl.example", verify_tls=False, name="tower-a"), secret="pw")
    msg = " ".join(r.getMessage() for r in caplog.records)
    assert "tower-a" in msg
    assert "TLS verification DISABLED" in msg


def test_plain_http_is_logged_as_the_worse_case(caplog):
    """http:// is not a TLS problem, it is the absence of one, and it must not be
    reported as though verification were the issue."""
    with caplog.at_level(logging.WARNING, logger="access.connector"):
        get_connector(_Inst("http://ctrl.local", verify_tls=True, name="tower-b"), secret="pw")
    msg = " ".join(r.getMessage() for r in caplog.records)
    assert "tower-b" in msg
    assert "PLAIN HTTP" in msg
    assert "TLS verification DISABLED" not in msg


def test_a_properly_protected_link_is_silent(caplog):
    """Otherwise the warning is noise, and noise is how a real one gets ignored."""
    with caplog.at_level(logging.WARNING, logger="access.connector"):
        get_connector(_Inst("https://ctrl.example", verify_tls=True), secret="pw")
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


def test_the_flag_is_what_the_http_client_is_given():
    """The setting is worth nothing unless it lands on the client. Read the one
    line that turns the flag into behaviour, so a hardcoded `verify=False` — the
    regression that would undo this whole file — is caught."""
    import inspect

    from app.connectors.dds import DDSConnector

    src = inspect.getsource(DDSConnector._client)
    assert "verify=self.verify_tls" in src, src
