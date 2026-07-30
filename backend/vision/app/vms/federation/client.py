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


def _headers(credential: str | None) -> dict:
    """Auth for an estate call. Prefer the node's per-node federation credential
    (Phase-2, scoped) as X-Node-Credential; fall back to the ambient service JWT
    (shared secret) when the node hasn't issued one yet."""
    if credential:
        return {"X-Node-Credential": credential}
    return {"Authorization": f"Bearer {mint_service_token()}"}


async def enroll_node(api_url: str) -> str:
    """Bootstrap a per-node credential: mint the shared-secret superadmin JWT ONCE
    to call the node's enrolment route, and return the scoped credential it issues.
    Raises NodeUnavailable on failure (caller falls back to the shared JWT)."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/federation/enroll"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.post(
                url,
                headers={"Authorization": f"Bearer {mint_service_token()}"},
                params={"label": "neubit_v3 VMS"},
            )
    except httpx.HTTPError as e:
        raise NodeUnavailable(str(e)) from e
    if r.status_code // 100 != 2:
        raise NodeUnavailable(f"{r.status_code}: {r.text[:160]}")
    key = (r.json() or {}).get("credential")
    if not key:
        raise NodeUnavailable("enrolment returned no credential")
    return key


async def list_estate_cameras(api_url: str, credential: str | None = None) -> list[dict]:
    """GET {api_url}/api/v1/nvr/estate/cameras → the node's own camera list."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/cameras"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.get(url, headers=_headers(credential), params={"limit": 500})
    except httpx.HTTPError as e:
        raise NodeUnavailable(str(e)) from e
    if r.status_code // 100 != 2:
        raise NodeUnavailable(f"{r.status_code}: {r.text[:160]}")
    return list((r.json() or {}).get("items") or [])


async def mint_estate_live(
    api_url: str, camera_id: str, *, profile: str | None = None, credential: str | None = None
) -> dict:
    """POST {api_url}/api/v1/nvr/estate/cameras/{id}/live → node-issued live payload
    (hls_url / webrtc_url / token / expires_at). The node mints + authorises its own
    media token; the VMS just relays it to the browser."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/cameras/{camera_id}/live"
    body = {}
    if profile:
        body["profile"] = profile
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.post(url, headers=_headers(credential), json=body)
    except httpx.HTTPError as e:
        raise NodeUnavailable(str(e)) from e
    if r.status_code // 100 != 2:
        raise NodeUnavailable(f"{r.status_code}: {r.text[:160]}")
    return r.json() or {}


async def get_node_timeline(
    api_url: str,
    camera_id: str,
    *,
    profile: str | None = None,
    from_: str | None = None,
    to: str | None = None,
    credential: str | None = None,
) -> dict:
    """GET {api_url}/api/v1/nvr/estate/recordings/timeline → merged recorded-coverage
    ranges (the scrub-bar timeline) for a camera, read straight from the node's segment
    index. Returns {camera_id, profile, ranges:[{start,duration,trigger_type}]}."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/recordings/timeline"
    params: dict = {"camera_id": camera_id}
    if profile:
        params["profile"] = profile
    if from_:
        params["from"] = from_
    if to:
        params["to"] = to
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.get(url, headers=_headers(credential), params=params)
    except httpx.HTTPError as e:
        raise NodeUnavailable(str(e)) from e
    if r.status_code // 100 != 2:
        raise NodeUnavailable(f"{r.status_code}: {r.text[:160]}")
    return r.json() or {}


async def list_node_recordings(
    api_url: str,
    camera_id: str,
    *,
    profile: str | None = None,
    from_: str | None = None,
    to: str | None = None,
    limit: int = 500,
    offset: int = 0,
    credential: str | None = None,
) -> dict:
    """GET {api_url}/api/v1/nvr/estate/recordings → the node's per-segment index for a
    camera in an optional [from,to] window. Returns {items, total, skip, limit}."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/recordings"
    params: dict = {"camera_id": camera_id, "limit": limit, "offset": offset}
    if profile:
        params["profile"] = profile
    if from_:
        params["from"] = from_
    if to:
        params["to"] = to
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.get(url, headers=_headers(credential), params=params)
    except httpx.HTTPError as e:
        raise NodeUnavailable(str(e)) from e
    if r.status_code // 100 != 2:
        raise NodeUnavailable(f"{r.status_code}: {r.text[:160]}")
    return r.json() or {}


async def mint_node_playback(
    api_url: str,
    camera_id: str,
    *,
    from_: str | None = None,
    to: str | None = None,
    credential: str | None = None,
) -> dict:
    """POST {api_url}/api/v1/nvr/estate/cameras/{id}/playback → node-issued playback
    payload (session_id / playback_url [tokenized, fmp4] / start [t=0] / ranges /
    expires_at). The node mints + authorises its own playback media token; the VMS
    relays it. 200 with empty playback_url means no footage in the window (not error)."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/cameras/{camera_id}/playback"
    body: dict = {}
    if from_:
        body["from"] = from_
    if to:
        body["to"] = to
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.post(url, headers=_headers(credential), json=body)
    except httpx.HTTPError as e:
        raise NodeUnavailable(str(e)) from e
    if r.status_code // 100 != 2:
        raise NodeUnavailable(f"{r.status_code}: {r.text[:160]}")
    return r.json() or {}
