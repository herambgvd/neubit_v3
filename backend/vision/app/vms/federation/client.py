"""Federation client — the central VMS pulling a node-authoritative NVR's estate.

Phase-1 federation (NVR owns cameras). For each registered recorder (``MediaNode``)
the VMS reads that node's own camera estate and mints live tokens THROUGH the node,
using the shared-secret service JWT (``mint_service_token``) that the node's estate
API now accepts (central-JWT branch). The node stays authoritative — the VMS never
writes its cameras, only reads + streams them.

Graceful: an unreachable node / non-2xx surfaces as ``NodeUnavailable`` so the
aggregator can skip one node without failing the whole list.
"""

from __future__ import annotations

import logging

import httpx

from app.vms.common.service_token import mint_service_token

log = logging.getLogger("vision.federation")

_TIMEOUT = 8.0


class NodeUnavailable(Exception):
    """A federated recorder node could not be reached / answered non-2xx."""


def _headers() -> dict:
    return {"Authorization": f"Bearer {mint_service_token()}"}


async def list_estate_cameras(api_url: str) -> list[dict]:
    """GET {api_url}/api/v1/nvr/estate/cameras → the node's own camera list."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/cameras"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.get(url, headers=_headers(), params={"limit": 500})
    except httpx.HTTPError as e:
        raise NodeUnavailable(str(e)) from e
    if r.status_code // 100 != 2:
        raise NodeUnavailable(f"{r.status_code}: {r.text[:160]}")
    return list((r.json() or {}).get("items") or [])


async def mint_estate_live(api_url: str, camera_id: str, *, profile: str | None = None) -> dict:
    """POST {api_url}/api/v1/nvr/estate/cameras/{id}/live → node-issued live payload
    (hls_url / webrtc_url / token / expires_at). The node mints + authorises its own
    media token; the VMS just relays it to the browser."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/cameras/{camera_id}/live"
    body = {}
    if profile:
        body["profile"] = profile
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.post(url, headers=_headers(), json=body)
    except httpx.HTTPError as e:
        raise NodeUnavailable(str(e)) from e
    if r.status_code // 100 != 2:
        raise NodeUnavailable(f"{r.status_code}: {r.text[:160]}")
    return r.json() or {}
