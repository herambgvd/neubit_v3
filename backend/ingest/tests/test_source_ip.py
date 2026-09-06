"""Who a webhook delivery is recorded as coming from.

`ingest_event_logs.source_ip` is the only record of who called a receiver that
takes no JWT and is reachable from the internet. It used to be the FIRST
`X-Forwarded-For` hop, unconditionally — a header the caller writes. Anyone could
choose the address stored against their own delivery, so the log attributed
whatever the caller wanted it to.

`kernel.client_ip` believes the header only when the socket PEER is a configured
proxy, and then takes the rightmost hop that is not one of ours, because Traefik
APPENDS rather than replaces: the leftmost entries are caller-supplied and the
trailing ones were added by proxies. With no trusted CIDRs the peer is used, which
under-attributes rather than trusting a header — the safe direction for a default.
"""

from __future__ import annotations

import pytest

from kernel import config
from kernel.client_ip import UNKNOWN, client_ip


class _Req:
    """The two things the resolver reads."""

    def __init__(self, peer: str | None, forwarded: str | None = None) -> None:
        self.client = type("C", (), {"host": peer})() if peer else None
        self.headers = {"x-forwarded-for": forwarded} if forwarded else {}


@pytest.fixture(autouse=True)
def fresh_settings():
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


def _trust(monkeypatch, cidrs: str) -> None:
    monkeypatch.setenv("VE_TRUSTED_PROXY_CIDRS", cidrs)
    config.get_settings.cache_clear()


def test_an_untrusted_peer_cannot_choose_its_own_address(monkeypatch):
    """The whole bug: a caller setting the header used to decide what was logged."""
    _trust(monkeypatch, "[]")
    req = _Req("203.0.113.9", "1.2.3.4")
    assert client_ip(req) == "203.0.113.9"


def test_a_forged_leading_hop_is_ignored_behind_a_trusted_proxy(monkeypatch):
    """Traefik APPENDS the address it saw. So in "<forged>, <real>" the real one
    is on the RIGHT, and taking the first hop takes the forgery."""
    _trust(monkeypatch, '["172.19.0.0/16"]')
    req = _Req("172.19.0.5", "1.2.3.4, 203.0.113.9")
    assert client_ip(req) == "203.0.113.9"


def test_trailing_proxy_hops_are_skipped(monkeypatch):
    """A chain of our own proxies is not the caller."""
    _trust(monkeypatch, '["172.19.0.0/16"]')
    req = _Req("172.19.0.5", "203.0.113.9, 172.19.0.7, 172.19.0.5")
    assert client_ip(req) == "203.0.113.9"


def test_a_non_address_hop_falls_back_to_the_peer(monkeypatch):
    """The value is stored and logged. Arbitrary caller text is not."""
    _trust(monkeypatch, '["172.19.0.0/16"]')
    req = _Req("172.19.0.5", "<script>alert(1)</script>")
    assert client_ip(req) == "172.19.0.5"


def test_an_unparseable_cidr_trusts_nothing(monkeypatch):
    """A typo must not silently become "trust everything"."""
    _trust(monkeypatch, '["not-a-cidr"]')
    req = _Req("172.19.0.5", "1.2.3.4")
    assert client_ip(req) == "172.19.0.5"


def test_no_peer_at_all_is_unknown(monkeypatch):
    _trust(monkeypatch, "[]")
    assert client_ip(_Req(None)) == UNKNOWN


# ── what the receiver actually stores ────────────────────────────────────────

def test_the_receiver_records_the_resolved_address(monkeypatch):
    """`_client_ip` is what writes the column: it must not re-introduce the raw
    header, and it must cap at the column width."""
    from app.ingest.service import _client_ip

    _trust(monkeypatch, '["172.19.0.0/16"]')
    assert _client_ip(_Req("172.19.0.5", "1.2.3.4, 203.0.113.9")) == "203.0.113.9"

    _trust(monkeypatch, "[]")
    assert _client_ip(_Req("172.19.0.5", "1.2.3.4")) == "172.19.0.5"


def test_an_unknown_address_is_stored_as_null_not_as_the_word(monkeypatch):
    """"unknown" in an IP column reads like an address that was recorded."""
    from app.ingest.service import _client_ip

    _trust(monkeypatch, "[]")
    assert _client_ip(_Req(None)) is None
    assert _client_ip(None) is None


def test_the_stored_value_fits_the_column(monkeypatch):
    """source_ip is String(64); an over-long value would fail the insert."""
    from app.ingest.service import _client_ip

    _trust(monkeypatch, "[]")
    long_peer = "2001:" + "0db8:" * 20 + "0001"
    assert len(_client_ip(_Req(long_peer))) <= 64
