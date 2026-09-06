"""Who the caller IS, for a satellite behind the gateway.

The same problem core solves in `app/core/client_ip.py`, and the same answer, so
that one deployment does not have two definitions of "the client's address".

A satellite sits behind Traefik, so `request.client.host` is the gateway rather
than the caller. But believing `X-Forwarded-For` unconditionally is WORSE than
ignoring it: anyone who can set the header picks their own identity, which in
ingest's case is the address written into a delivery log and used to attribute an
unauthenticated webhook call.

So the header is believed only when the PEER is a configured proxy, and the hop
taken is the rightmost untrusted one — Traefik appends the address it saw rather
than replacing the header, so the leftmost entries are whatever the caller sent.

With `trusted_proxy_cidrs` empty (the default) nothing is trusted and the peer is
used. That is the safe direction: an unset value under-attributes rather than
letting a header decide.
"""

from __future__ import annotations

import ipaddress
import logging

log = logging.getLogger("kernel.clientip")

#: Used when there is no peer at all (test clients, some unix sockets).
UNKNOWN = "unknown"


def _networks() -> list:
    from .config import get_settings

    nets = []
    for raw in getattr(get_settings(), "trusted_proxy_cidrs", None) or []:
        try:
            nets.append(ipaddress.ip_network(raw, strict=False))
        except ValueError:
            # A typo silently means "trust nothing", which LOOKS like the secure
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


def client_ip(request) -> str:
    """The caller's address: the forwarded one when it can be trusted, else the peer."""
    peer = request.client.host if getattr(request, "client", None) else None
    nets = _networks()
    if peer and _is_trusted(peer, nets):
        forwarded = request.headers.get("x-forwarded-for") or ""
        hops = [h.strip() for h in forwarded.split(",") if h.strip()]
        # Rightmost first: trailing hops were appended by proxies we trust, so the
        # first entry that is NOT one of ours is the furthest address we have any
        # reason to believe.
        for hop in reversed(hops):
            if _is_trusted(hop, nets):
                continue
            try:
                ipaddress.ip_address(hop)
            except ValueError:
                # Not an address at all. Fall back to the peer: this value is
                # stored and logged, and arbitrary caller-supplied text is not.
                log.warning("ignoring non-address X-Forwarded-For hop from %s", peer)
                return peer
            return hop
    return peer or UNKNOWN
