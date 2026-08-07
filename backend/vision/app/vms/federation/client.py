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

import base64
import binascii
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


async def enroll_node_full(api_url: str, *, label: str = "neubit_v3 VMS") -> dict:
    """Bootstrap a per-node credential: mint the shared-secret superadmin JWT ONCE to
    call the node's enrolment route, and return its FULL 201 payload
    ({credential, id, label, grants, node_id, node_name}). The scoped ``credential`` is
    surfaced ONCE here — the node never returns it again. Raises NodeUnavailable on
    failure (callers fall back to the shared JWT)."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/federation/enroll"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.post(
                url,
                headers={"Authorization": f"Bearer {mint_service_token()}"},
                params={"label": label},
            )
    except httpx.HTTPError as e:
        raise NodeUnavailable(str(e)) from e
    if r.status_code // 100 != 2:
        raise NodeUnavailable(f"{r.status_code}: {r.text[:160]}")
    payload = r.json() or {}
    if not payload.get("credential"):
        raise NodeUnavailable("enrolment returned no credential")
    return payload


async def enroll_node(api_url: str) -> str:
    """Convenience: enrol and return ONLY the scoped credential string (used by the
    media-node CREATE probe, which just stores the key). See ``enroll_node_full`` for
    the full enrolment payload."""
    return (await enroll_node_full(api_url)).get("credential")


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


# ── storage read seam (Phase-1) — the node OWNS storage; the VMS only READS it.
# Mirrors get_node_timeline: httpx GET against the node's estate API, _headers auth,
# NodeUnavailable on any non-2xx. The node serves its OWN disks under estate/storage/*;
# a 3rd-party upstream NVR's HDDs come from estate/nvrs/{nvr_id}/storage.


async def get_node_storage_usage(api_url: str, *, credential: str | None = None) -> dict:
    """GET {api_url}/api/v1/nvr/estate/storage/usage → the node's own disk usage summary."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/storage/usage"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.get(url, headers=_headers(credential))
    except httpx.HTTPError as e:
        raise NodeUnavailable(str(e)) from e
    if r.status_code // 100 != 2:
        raise NodeUnavailable(f"{r.status_code}: {r.text[:160]}")
    return r.json() or {}


async def get_node_storage_raid(api_url: str, *, credential: str | None = None) -> dict:
    """GET {api_url}/api/v1/nvr/estate/storage/raid → the node's RAID array health."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/storage/raid"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.get(url, headers=_headers(credential))
    except httpx.HTTPError as e:
        raise NodeUnavailable(str(e)) from e
    if r.status_code // 100 != 2:
        raise NodeUnavailable(f"{r.status_code}: {r.text[:160]}")
    return r.json() or {}


async def list_node_pools(api_url: str, *, credential: str | None = None) -> dict:
    """GET {api_url}/api/v1/nvr/estate/storage/pools → the node's storage pools."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/storage/pools"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.get(url, headers=_headers(credential))
    except httpx.HTTPError as e:
        raise NodeUnavailable(str(e)) from e
    if r.status_code // 100 != 2:
        raise NodeUnavailable(f"{r.status_code}: {r.text[:160]}")
    return r.json() or {}


async def list_node_tier_rules(api_url: str, *, credential: str | None = None) -> dict:
    """GET {api_url}/api/v1/nvr/estate/storage/tier-rules → the node's tiering rules."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/storage/tier-rules"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.get(url, headers=_headers(credential))
    except httpx.HTTPError as e:
        raise NodeUnavailable(str(e)) from e
    if r.status_code // 100 != 2:
        raise NodeUnavailable(f"{r.status_code}: {r.text[:160]}")
    return r.json() or {}


async def get_upstream_nvr_storage(
    api_url: str, nvr_id: str, *, credential: str | None = None
) -> dict | None:
    """GET {api_url}/api/v1/nvr/estate/nvrs/{nvr_id}/storage → a 3rd-party UPSTREAM NVR's
    HDDs (this recorder federates them). Returns None on 404 (upstream storage not yet
    available — the feature is still being built node-side); other non-2xx raise
    NodeUnavailable."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/nvrs/{nvr_id}/storage"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.get(url, headers=_headers(credential))
    except httpx.HTTPError as e:
        raise NodeUnavailable(str(e)) from e
    if r.status_code == 404:
        return None
    if r.status_code // 100 != 2:
        raise NodeUnavailable(f"{r.status_code}: {r.text[:160]}")
    return r.json() or {}


# ── federation trust / credential management (Phase-2) — the VMS enrols + revokes
# scoped node credentials. These are gated node-side on settings.manage, which the
# SCOPED federation credential does NOT carry, so — like enroll_node — they auth with
# the shared-secret superadmin service JWT (NOT _headers/X-Node-Credential).


async def list_node_credentials(api_url: str) -> list[dict]:
    """GET {api_url}/api/v1/nvr/estate/federation/credentials → the node's issued
    federation credentials [{id,label,grants,created_at,last_used_at,revoked_at}].
    Service-JWT auth (settings.manage-gated). Raises NodeUnavailable on non-2xx."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/federation/credentials"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.get(url, headers={"Authorization": f"Bearer {mint_service_token()}"})
    except httpx.HTTPError as e:
        raise NodeUnavailable(str(e)) from e
    if r.status_code // 100 != 2:
        raise NodeUnavailable(f"{r.status_code}: {r.text[:160]}")
    return list((r.json() or {}).get("items") or [])


async def revoke_node_credential(api_url: str, cred_id: str) -> None:
    """DELETE {api_url}/api/v1/nvr/estate/federation/credentials/{cred_id} → revoke one
    issued credential. Service-JWT auth (settings.manage-gated). NodeUnavailable on non-2xx."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/federation/credentials/{cred_id}"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.delete(url, headers={"Authorization": f"Bearer {mint_service_token()}"})
    except httpx.HTTPError as e:
        raise NodeUnavailable(str(e)) from e
    if r.status_code // 100 != 2:
        raise NodeUnavailable(f"{r.status_code}: {r.text[:160]}")


# ── operate-THROUGH-node (Phase-3) — the only two mutations the VMS makes on a
# node-owned camera. Everything else on a federated camera stays read-only; PTZ
# and snapshot are proxied to the owning NVR, which runs the real device op.

# The node's PTZ subroutes (estate/ptz.go). Allow-listed so a caller can never
# smuggle an arbitrary path segment into the node URL.
_PTZ_ACTIONS = frozenset({"move", "stop", "zoom", "focus"})


async def ptz_node(
    api_url: str,
    camera_id: str,
    action: str,
    body: dict | None = None,
    *,
    credential: str | None = None,
) -> dict:
    """POST {api_url}/api/v1/nvr/estate/cameras/{id}/ptz/{action} → the node runs the
    real PTZ command on its own camera and returns { ok, result }. ``action`` names
    the node subroute (move|stop|zoom|focus); ``body`` is the command payload the
    node forwards to the device (pan/tilt/zoom/speed, or direction+speed). The node
    gates PTZ on vms.ptz.control — a grant the SCOPED federation credential does not
    carry (see federation.go federationGrants), so this only passes on a node still
    falling back to the shared service JWT. NodeUnavailable (→ 502) on any non-2xx."""
    act = (action or "").strip().lower()
    if act not in _PTZ_ACTIONS:
        raise NodeUnavailable(f"unsupported ptz action: {action!r}")
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/cameras/{camera_id}/ptz/{act}"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.post(url, headers=_headers(credential), json=body or {})
    except httpx.HTTPError as e:
        raise NodeUnavailable(str(e)) from e
    if r.status_code // 100 != 2:
        raise NodeUnavailable(f"{r.status_code}: {r.text[:160]}")
    return r.json() or {}


async def snapshot_node(
    api_url: str,
    camera_id: str,
    *,
    refresh: bool = False,
    credential: str | None = None,
) -> tuple[bytes, str]:
    """GET {api_url}/api/v1/nvr/estate/cameras/{id}/snapshot → the node grabs a still
    off its own camera. The node answers JSON { image: "data:image/jpeg;base64,…",
    captured_at, … } (snapshot.go), so we decode the data URI down to raw bytes +
    content-type — the VMS then serves a real image the browser renders/downloads
    directly. Gated node-side on vms.camera.read, which the scoped federation
    credential DOES carry. Returns (image_bytes, content_type). NodeUnavailable on a
    non-2xx or a response carrying no decodable image."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/cameras/{camera_id}/snapshot"
    params: dict = {"refresh": "1"} if refresh else {}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.get(url, headers=_headers(credential), params=params)
    except httpx.HTTPError as e:
        raise NodeUnavailable(str(e)) from e
    if r.status_code // 100 != 2:
        raise NodeUnavailable(f"{r.status_code}: {r.text[:160]}")
    uri = ((r.json() or {}).get("image") or "").strip()
    if not uri.startswith("data:"):
        raise NodeUnavailable("node returned no snapshot image")
    try:
        header, b64 = uri.split(",", 1)
        content_type = header[len("data:"):].split(";", 1)[0] or "image/jpeg"
        raw = base64.b64decode(b64)
    except (ValueError, binascii.Error) as e:
        raise NodeUnavailable(f"could not decode node snapshot: {e}") from e
    return raw, content_type
