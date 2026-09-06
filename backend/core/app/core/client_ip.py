"""Who the caller IS, for rate limiting and session records.

Core sits behind Traefik, so `request.client.host` is the gateway, not the person.
But trusting `X-Forwarded-For` unconditionally is worse than ignoring it: an
attacker who can set the header gets a fresh rate-limit bucket per request.

So the header is trusted only from an address configured as a proxy, and the hop
taken is the rightmost untrusted one — Traefik appends the peer it saw rather than
replacing the header, so the leftmost entries are client-supplied.

With `trusted_proxy_cidrs` empty (the default) nothing is trusted and the peer is
used. Set it in deployments that have a gateway; `deploy/.env` carries the value
for this stack.
"""

from __future__ import annotations

import ipaddress

from fastapi import Request

from .config import get_settings
from .logging import get_logger

log = get_logger("edge.clientip")

#: Used when there is no peer at all (test-client scopes, some unix sockets).
#: Shared so a rate-limit bucket and a session row use the same placeholder.
UNKNOWN = "unknown"


def _networks() -> list[ipaddress._BaseNetwork]:
    nets = []
    for raw in get_settings().trusted_proxy_cidrs or []:
        try:
            nets.append(ipaddress.ip_network(raw, strict=False))
        except ValueError:
            # A typo silently means "trust nothing", which looks like the secure
            # default but is a misconfiguration. Say so.
            log.warning("ignoring unparseable trusted_proxy_cidr %r", raw)
    return nets


def _is_trusted(addr: str, nets: list) -> bool:
    if not nets:
        return False
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return any(ip in net for net in nets)


def client_ip(request: Request) -> str:
    """The caller's address: the forwarded one when it can be trusted, else the peer."""
    peer = request.client.host if request.client else None
    nets = _networks()
    if peer and _is_trusted(peer, nets):
        forwarded = request.headers.get("x-forwarded-for") or ""
        hops = [h.strip() for h in forwarded.split(",") if h.strip()]
        # Rightmost first: trailing hops came from proxies we trust, so the first
        # non-proxy entry is the furthest address we have reason to believe.
        for hop in reversed(hops):
            if _is_trusted(hop, nets):
                continue
            try:
                ipaddress.ip_address(hop)
            except ValueError:
                # Not an address. Return the peer instead — this becomes a
                # rate-limit bucket key, and arbitrary text grows the store
                # without bound.
                log.warning("ignoring non-address X-Forwarded-For hop from %s", peer)
                return peer
            return hop
    return peer or UNKNOWN
