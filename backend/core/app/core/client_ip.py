"""Who the caller IS, for the purposes of rate limiting and session records.

Core sits behind Traefik, so `request.client.host` is the GATEWAY, not the person.
Two places in this codebase needed the caller's address and they disagreed:

  * `auth/routes/_shared.py::_client_ip` read `X-Forwarded-For` and trusted it
    unconditionally — so the IP recorded against a session was whatever the client
    said it was. Core's port 8000 is published in dev, and a request that reaches
    the app directly can set that header to anything.
  * `core/ratelimit.py` used `request.client.host` with no forwarding at all — so
    every external request presented the same address and `login: 10/min per IP`
    was in practice 10/min for the WHOLE DEPLOYMENT. One office locks out everyone,
    and ten requests a minute denies login to every user in the estate.

Both are wrong, and naively fixing the second by copying the first would be worse
than either: an attacker who can set `X-Forwarded-For` freely gets a fresh bucket
per request, which removes the cap entirely rather than merely sharing it.

So the header is trusted only from an address that is configured as a proxy, and
the hop taken is the RIGHTMOST untrusted one. That matters: a client can send its
own `X-Forwarded-For`, and Traefik APPENDS the peer it saw rather than replacing
the header — so the leftmost entry is attacker-controlled and the rightmost
non-proxy entry is the address the trusted proxy actually observed.

With `trusted_proxy_cidrs` empty — the default — nothing is trusted and the peer is
used, which is safe everywhere and correct for a core exposed directly. Configure it
in a deployment that has a gateway; `deploy/.env` carries the value for this stack.
"""

from __future__ import annotations

import ipaddress

from fastapi import Request

from .config import get_settings
from .logging import get_logger

log = get_logger("edge.clientip")

#: What to attribute a request to when there is no peer at all (ASGI scopes built
#: by a test client, some unix-socket setups). A shared constant so a rate-limit
#: bucket and a session row agree on the same placeholder.
UNKNOWN = "unknown"


def _networks() -> list[ipaddress._BaseNetwork]:
    nets = []
    for raw in get_settings().trusted_proxy_cidrs or []:
        try:
            nets.append(ipaddress.ip_network(raw, strict=False))
        except ValueError:
            # A typo here would silently mean "trust nothing", which looks like the
            # secure default and is actually a misconfiguration; say so once.
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
        # Rightmost first: each trailing hop was added by a proxy we trust, so the
        # first one that is NOT a trusted proxy is the furthest point we have any
        # reason to believe. Anything left of it was supplied by the client.
        for hop in reversed(hops):
            if _is_trusted(hop, nets):
                continue
            try:
                ipaddress.ip_address(hop)
            except ValueError:
                # Not an address. Fall back to the peer rather than returning it:
                # this value becomes a rate-limit bucket key, and a key built from
                # arbitrary text is a way to grow the store without bound.
                log.warning("ignoring non-address X-Forwarded-For hop from %s", peer)
                return peer
            return hop
    return peer or UNKNOWN
