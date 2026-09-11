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
import json
import logging
import os
import re

import httpx

from app.vms.common.service_token import mint_service_token

log = logging.getLogger("vision.federation")

_TIMEOUT = 8.0


class NodeUnavailable(Exception):
    """A federated recorder node could not be reached, or answered a non-2xx that is
    not an authorisation refusal (see ``NodeRefused``)."""


class NodeRefused(NodeUnavailable):
    """The recorder was REACHED and refused us: 401 (no/!valid credential) or 403
    (the credential lacks a permission the route needs).

    This is not a transport failure and must not read like one. It cost two rounds of
    live debugging to learn that twice — once for ``vms.event.read`` and once for
    ``vms.storage.read`` — because both surfaced as "recorder unavailable", which
    sends you to look at the network.

    The cause is almost always the same and is invisible from the outside: a
    federation credential FREEZES the grant list it was minted with. Widening
    ``federationGrants`` on the recorder does nothing for credentials that already
    exist; the node has to be re-enrolled. ``missing_permission`` carries the
    permission the node named so the caller can say exactly that.

    Subclasses NodeUnavailable so every existing ``except NodeUnavailable`` still
    catches it — a refusal is still a failed call — while a handler that wants to say
    something better can.
    """

    def __init__(self, message: str, *, status_code: int, missing_permission: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.missing_permission = missing_permission


# The node's kernel renders a refusal as {"error": {"code", "message"}}, and a
# permission failure spells the permission into the message: "missing permission:
# vms.storage.read". Pulling it out is what lets the VMS name the exact grant an
# operator must re-enrol for, instead of handing them a status code.
_MISSING_PERM = re.compile(r"missing permission:\s*([a-z0-9_.]+)")


def _transport_failure(exc: Exception) -> "NodeUnavailable":
    """An httpx failure as something an operator can read.

    `str(httpx.ReadTimeout())` is the EMPTY STRING, so the 33 call sites that
    raised `NodeUnavailable(str(e))` produced "recorder unavailable: " — a sentence
    that stops at the colon. A timeout is the commonest federated failure there is
    (a recorder waiting on a camera that has gone), so the commonest message was
    the one that said nothing.
    """
    detail = str(exc).strip()
    if not detail:
        # The class name is the fact when the instance carries no message:
        # ReadTimeout, ConnectError, PoolTimeout each say something different.
        detail = type(exc).__name__
    return NodeUnavailable(detail)


async def _send(method: str, url: str, **kw) -> httpx.Response:
    """One call to a recorder, and the ONE place a transport failure is translated.

    This was written out 33 times — a `try`, a client, the call, and the same
    `except httpx.HTTPError` raising the same thing. Thirty-three copies of an
    error path is thirty-three chances for one of them to be subtly different, and
    it had already happened once: `str(httpx.ReadTimeout())` is empty, so a whole
    class of failure reported a sentence ending at the colon. Fixing that meant
    finding every copy. Now there is one.

    A fresh `AsyncClient` per call is kept deliberately. It is not the fast choice
    and it is the correct one here: these calls go to a DIFFERENT recorder each
    time, each with its own credential, and a shared pool would hand one node's
    keep-alive connection to a call meant for another.
    """
    try:
        async with httpx.AsyncClient(timeout=kw.pop("timeout", _TIMEOUT)) as c:
            return await c.request(method, url, **kw)
    except httpx.HTTPError as e:
        raise _transport_failure(e) from e


def _raise_for_node(r: httpx.Response, *, detailed: bool = False) -> None:
    """Turn a non-2xx from a recorder into the right exception, once.

    The SPLIT is the point, and it decides what the operator is told to do:
    401/403 is the node refusing THIS console (a credential that was never granted
    the reach, or one frozen before the grant existed) and is fixed by re-enrolling
    — a retry will refuse forever. Anything else is reported as the node being
    unavailable, which is a thing worth retrying.

    `detailed` asks the node's own error message to be read out of the body, for
    the calls where it carries a sentence worth repeating.

    This block stood in 31 functions. It is not the kind of code that drifts on
    purpose; it is the kind where one copy gets a fix and the other thirty do not.
    """
    if r.status_code // 100 == 2:
        return
    if r.status_code in (401, 403):
        raise _refusal(r.status_code, r.text)
    body = _node_error_message(r, r.text[:160]) if detailed else r.text[:160]
    raise NodeUnavailable(f"{r.status_code}: {body}")


def _refusal(status_code: int, body: str) -> NodeRefused:
    """Build a NodeRefused from the node's own answer, keeping ITS sentence."""
    detail = (body or "").strip()
    try:
        parsed = json.loads(detail)
        detail = str(parsed.get("error", {}).get("message") or parsed.get("detail") or detail)
    except (ValueError, AttributeError):
        pass
    m = _MISSING_PERM.search(detail)
    perm = m.group(1) if m else None
    if perm:
        message = (
            f"the recorder refused this call: the federation credential is missing "
            f"{perm}. A credential keeps the grants it was minted with, so if the "
            f"recorder's grant set was widened, re-enrol this node "
            f"(POST /vms/media-nodes/{{id}}/enroll)."
        )
    elif status_code == 401:
        message = (
            "the recorder rejected this node's credential. Re-enrol the node "
            "(POST /vms/media-nodes/{id}/enroll), or re-pair it if the recorder "
            "revoked the credential."
        )
    else:
        message = f"the recorder refused this call: {detail[:160]}"
    return NodeRefused(message, status_code=status_code, missing_permission=perm)


class NodePairingRejected(Exception):
    """The recorder REFUSED a pairing code — unknown, already spent, or expired.

    Distinct from ``NodeUnavailable`` on purpose: the node was reached and answered,
    so retrying or waiting for a heartbeat will not help. Only a fresh code will.
    """


#: What this VMS calls itself on a recorder it federates.
#:
#: The label is written into the RECORDER's own credential list, not just ours —
#: it is how an operator standing at that recorder knows which VMS holds a key,
#: and a recorder federated by two of them shows two labels. It used to be the
#: repository name ("neubit_v3 VMS"), which named a source tree rather than a
#: deployment, on someone else's screen.
#:
#: Settable per deployment, so an estate with two VMSs can tell them apart.
_DEFAULT_FEDERATION_LABEL = "Neubit VMS"


def federation_label() -> str:
    """The label this VMS presents when enrolling or pairing with a recorder."""
    return (os.environ.get("VE_FEDERATION_LABEL") or "").strip() or _DEFAULT_FEDERATION_LABEL


def _headers(credential: str | None) -> dict:
    """Auth for an estate call. Prefer the node's per-node federation credential
    (Phase-2, scoped) as X-Node-Credential; fall back to the ambient service JWT
    (shared secret) when the node hasn't issued one yet."""
    if credential:
        return {"X-Node-Credential": credential}
    return {"Authorization": f"Bearer {mint_service_token()}"}


async def enroll_node_full(api_url: str, *, label: str | None = None) -> dict:
    """Bootstrap a per-node credential: mint the shared-secret superadmin JWT ONCE to
    call the node's enrolment route, and return its FULL 201 payload
    ({credential, id, label, grants, node_id, node_name}). The scoped ``credential`` is
    surfaced ONCE here — the node never returns it again. Raises NodeUnavailable on
    failure (callers fall back to the shared JWT)."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/federation/enroll"
    r = await _send("POST", 
        url,
        headers={"Authorization": f"Bearer {mint_service_token()}"},
        params={"label": label or federation_label()},
    )
    _raise_for_node(r)
    payload = r.json() or {}
    if not payload.get("credential"):
        raise NodeUnavailable("enrolment returned no credential")
    return payload


async def enroll_node(api_url: str) -> str:
    """Convenience: enrol and return ONLY the scoped credential string (used by the
    media-node CREATE probe, which just stores the key). See ``enroll_node_full`` for
    the full enrolment payload."""
    return (await enroll_node_full(api_url)).get("credential")


def _node_error_message(r: httpx.Response, fallback: str) -> str:
    """The node's own error text, so the operator reads WHY a call was refused rather
    than a status code. Both kernels emit ``{"error": {"code", "message"}}``."""
    try:
        body = r.json() or {}
    except ValueError:
        return fallback
    err = body.get("error")
    if isinstance(err, dict) and err.get("message"):
        return str(err["message"])
    return fallback


async def pair_node(api_url: str, code: str, *, label: str | None = None) -> dict:
    """Trade a recorder-minted PAIRING CODE for this VMS's own scoped credential.

    The credential-free bootstrap. ``enroll_node_full`` signs its call with the shared
    ``VE_JWT_SECRET``, so it only works where the recorder and the VMS were deployed as
    one stack; a recorder on its own box has its own secret and would answer 401. This
    presents instead a short-lived, one-use code an operator minted on that recorder's
    console and carried here — which is what makes an independently deployed recorder
    onboardable at all.

    Returns the node's full 201 payload ({credential, id, label, grants, node_id,
    node_name}); the raw ``credential`` is surfaced ONCE and stored on the node row.

    The two failure modes are deliberately DIFFERENT exceptions, because the fixes are
    different: a refused code is the operator's to correct (retype it, or mint a fresh
    one), while an unreachable node is a networking problem the onboarding flow can ride
    out. Collapsing them would either hard-fail a reachable-later recorder or silently
    register a node whose code was simply wrong.
    """
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/federation/pair"
    r = await _send("POST", url, json={"code": code, "label": label or federation_label()})
    if r.status_code in (400, 401, 403, 429):
        raise NodePairingRejected(
            _node_error_message(r, "the recorder refused this pairing code")
        )
    _raise_for_node(r)
    payload = r.json() or {}
    if not payload.get("credential"):
        raise NodePairingRejected("pairing returned no credential")
    return payload


async def list_estate_cameras(api_url: str, credential: str | None = None) -> list[dict]:
    """GET {api_url}/api/v1/nvr/estate/cameras → the node's own camera list."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/cameras"
    r = await _send("GET", url, headers=_headers(credential), params={"limit": 500})
    _raise_for_node(r)
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
    r = await _send("POST", url, headers=_headers(credential), json=body)
    _raise_for_node(r)
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
    r = await _send("GET", url, headers=_headers(credential), params=params)
    _raise_for_node(r)
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
    r = await _send("GET", url, headers=_headers(credential), params=params)
    _raise_for_node(r)
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
    r = await _send("POST", url, headers=_headers(credential), json=body)
    _raise_for_node(r)
    return r.json() or {}


# ── storage read seam (Phase-1) — the node OWNS storage; the VMS only READS it.
# Mirrors get_node_timeline: httpx GET against the node's estate API, _headers auth,
# NodeUnavailable on any non-2xx. The node serves its OWN disks under estate/storage/*;
# a 3rd-party upstream NVR's HDDs come from estate/nvrs/{nvr_id}/storage.


async def get_node_storage_usage(api_url: str, *, credential: str | None = None) -> dict:
    """GET {api_url}/api/v1/nvr/estate/storage/usage → the node's own disk usage summary."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/storage/usage"
    r = await _send("GET", url, headers=_headers(credential))
    _raise_for_node(r)
    return r.json() or {}


async def get_node_storage_raid(api_url: str, *, credential: str | None = None) -> dict:
    """GET {api_url}/api/v1/nvr/estate/storage/raid → the node's RAID array health."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/storage/raid"
    r = await _send("GET", url, headers=_headers(credential))
    _raise_for_node(r)
    return r.json() or {}


async def list_node_pools(api_url: str, *, credential: str | None = None) -> dict:
    """GET {api_url}/api/v1/nvr/estate/storage/pools → the node's storage pools."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/storage/pools"
    r = await _send("GET", url, headers=_headers(credential))
    _raise_for_node(r)
    return r.json() or {}


async def list_node_tier_rules(api_url: str, *, credential: str | None = None) -> dict:
    """GET {api_url}/api/v1/nvr/estate/storage/tier-rules → the node's tiering rules."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/storage/tier-rules"
    r = await _send("GET", url, headers=_headers(credential))
    _raise_for_node(r)
    return r.json() or {}


async def get_node_sysmon(api_url: str, *, credential: str | None = None) -> dict:
    """GET {api_url}/api/v1/nvr/estate/sysmon → the node's whole System-Monitor board.

    One call per recorder gives the verdict, engine liveness, hardware sample,
    volumes with real usage, RAID, retention default and every camera row with its
    link quality. Pulse fans this out across the estate rather than asking each
    recorder five questions.

    Gated node-side on ``camera.read``, which a federation credential already
    carries (nvr estate/core/perms.go → federationGrants), so no re-enrolment is
    needed to read it.

    The node marks what it cannot measure as ``unmeasured`` rather than inventing
    a value; nothing here is allowed to smooth that over.
    """
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/sysmon"
    r = await _send("GET", url, headers=_headers(credential))
    _raise_for_node(r)
    return r.json() or {}


async def isolate_node_camera(
    api_url: str, camera_id: str, *, profile: str | None = None, credential: str | None = None
) -> dict:
    """GET {api_url}/api/v1/nvr/estate/sysmon/isolate?camera_id= → one camera's fault trace.

    The payoff of the whole surface: the recorder walks camera → network → ingest
    → decode → storage → display with the evidence it actually measured and says
    where the fault sits, including when the recorder itself is cleared. Same
    ``camera.read`` gate as the board.
    """
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/sysmon/isolate"
    params = {"camera_id": camera_id}
    if profile:
        params["profile"] = profile
    r = await _send("GET", url, params=params, headers=_headers(credential))
    _raise_for_node(r)
    return r.json() or {}


async def list_nvrs_node(api_url: str, *, credential: str | None = None) -> dict:
    """GET {api_url}/api/v1/nvr/estate/nvrs → the third-party NVR/DVR appliances this
    recorder has onboarded, { items, total }.

    The recorder owns them: it holds their credentials, probes them, enumerates their
    channels and keeps them in step. Their CHANNELS are not listed here because they
    are not separate objects on the node — onboarding turns each one into a proxy
    camera, so they arrive through the ordinary camera list and their footage is read
    through the ordinary camera routes. This endpoint answers only "which appliances
    does this recorder front", which is the part a cross-recorder estate view needs
    and no single recorder can assemble.

    Gated node-side on vms.nvr.read, which the scoped federation credential carries."""
    return await _node_json("GET", api_url, "/nvrs", credential=credential)


async def get_upstream_nvr_storage(
    api_url: str, nvr_id: str, *, credential: str | None = None
) -> dict | None:
    """GET {api_url}/api/v1/nvr/estate/nvrs/{nvr_id}/storage → a 3rd-party UPSTREAM NVR's
    HDDs (this recorder federates them). Returns None on 404 (upstream storage not yet
    available — the feature is still being built node-side); other non-2xx raise
    NodeUnavailable."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/nvrs/{nvr_id}/storage"
    r = await _send("GET", url, headers=_headers(credential))
    if r.status_code == 404:
        return None
    _raise_for_node(r)
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
    r = await _send("GET", url, headers={"Authorization": f"Bearer {mint_service_token()}"})
    _raise_for_node(r)
    return list((r.json() or {}).get("items") or [])


async def revoke_node_credential(api_url: str, cred_id: str) -> None:
    """DELETE {api_url}/api/v1/nvr/estate/federation/credentials/{cred_id} → revoke one
    issued credential. Service-JWT auth (settings.manage-gated). NodeUnavailable on non-2xx."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/federation/credentials/{cred_id}"
    r = await _send("DELETE", url, headers={"Authorization": f"Bearer {mint_service_token()}"})
    _raise_for_node(r)


async def rename_node_credential(api_url: str, cred_id: str, label: str) -> None:
    """PATCH …/federation/credentials/{cred_id} → change one credential's LABEL.

    Label only: the recorder refuses anything else on this route, so this can
    never widen a credential. Service-JWT auth (settings.manage-gated), which a
    federation credential deliberately does not hold — so this works on a
    co-located recorder and 403s on an independently deployed one, exactly like
    enrolment. NodeUnavailable (NodeRefused for a 401/403) on non-2xx.
    """
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/federation/credentials/{cred_id}"
    r = await _send("PATCH", 
        url,
        headers={"Authorization": f"Bearer {mint_service_token()}"},
        json={"label": label},
    )
    _raise_for_node(r)


# ── operate-THROUGH-node (Phase-3) — the only two mutations the VMS makes on a
# node-owned camera. Everything else on a federated camera stays read-only; PTZ
# and snapshot are proxied to the owning NVR, which runs the real device op.

# The node's PTZ subroutes (onvifapi/ptz_routes.go MountPTZ). Allow-listed so a caller
# can never smuggle an arbitrary path segment into the node URL.
#
# move and stop are the ONLY two the node mounts under /cameras/{id}/ptz/. "zoom" and
# "focus" were in this set and are not routes: zoom is a field inside the move body,
# focus lives at /onvif/imaging/focus/*. Both 404'd rather than being refused here, so
# the allow-list read as though it permitted more than the node could answer.
_PTZ_ACTIONS = frozenset({"move", "stop"})


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
    the node subroute (move|stop); ``body`` is the command payload the node forwards
    to the device (pan/tilt/zoom/speed, or direction+speed). The node gates PTZ on
    vms.ptz.control, which the scoped federation credential DOES carry (federation.go
    federationGrants), so this works over a federation credential alone — no shared
    service JWT needed. NodeUnavailable (→ 502) on any non-2xx."""
    act = (action or "").strip().lower()
    if act not in _PTZ_ACTIONS:
        raise NodeUnavailable(f"unsupported ptz action: {action!r}")
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/cameras/{camera_id}/ptz/{act}"
    r = await _send("POST", url, headers=_headers(credential), json=body or {})
    _raise_for_node(r)
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
    r = await _send("GET", url, headers=_headers(credential), params=params)
    _raise_for_node(r)
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


# ── operate-THROUGH-node (Phase-3, extended) — recording control, clip export,
# evidence hold, and camera reboot. Each proxies the operator's action to the owning
# NVR, which runs the real op. All mirror ptz_node's POST-with-credential shape and
# raise NodeUnavailable on any non-2xx; the node authorises via X-Node-Credential
# (whose grants now carry recording.control / export.create / evidence.* / camera.reboot).


async def record_start_node(api_url: str, camera_id: str, *, credential: str | None = None) -> dict:
    """POST {api_url}/api/v1/nvr/estate/cameras/{id}/recording/start → the node starts
    recording its own camera. Empty body; returns { status }. NodeUnavailable on non-2xx."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/cameras/{camera_id}/recording/start"
    r = await _send("POST", url, headers=_headers(credential), json={})
    _raise_for_node(r)
    return r.json() or {}


async def record_stop_node(api_url: str, camera_id: str, *, credential: str | None = None) -> dict:
    """POST {api_url}/api/v1/nvr/estate/cameras/{id}/recording/stop → the node stops
    recording its own camera. Empty body; returns { status }. NodeUnavailable on non-2xx."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/cameras/{camera_id}/recording/stop"
    r = await _send("POST", url, headers=_headers(credential), json={})
    _raise_for_node(r)
    return r.json() or {}


async def reboot_camera_node(api_url: str, camera_id: str, *, credential: str | None = None) -> dict:
    """POST {api_url}/api/v1/nvr/estate/cameras/{id}/onvif/reboot → the node reboots its
    own camera via ONVIF. Empty body; returns { "rebooting": true }. NodeUnavailable on non-2xx."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/cameras/{camera_id}/onvif/reboot"
    r = await _send("POST", url, headers=_headers(credential), json={})
    _raise_for_node(r)
    return r.json() or {}


async def create_export_node(
    api_url: str,
    camera_id: str,
    frm: str,
    to: str,
    *,
    watermark: bool = False,
    credential: str | None = None,
) -> dict:
    """POST {api_url}/api/v1/nvr/estate/exports → the node queues a clip export of its own
    camera for [frm, to] (RFC3339). Returns 202 { id, status, ... }. NodeUnavailable on non-2xx.

    ``watermark`` burns a visible provenance stamp (camera, window, recorder, operator)
    into the picture. It forces the recorder to RE-ENCODE — pixels cannot be drawn into
    a stream copy — so the clip is no longer bit-identical to the recorded segments and
    the job takes materially longer. Off by default for that reason.

    It is not an alternative to the signed manifest. The manifest proves the FILE is
    the one this recorder produced; the stamp survives the clip being screenshotted or
    pasted into a slide, where a detached signature does not travel."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/exports"
    body = {"camera_id": camera_id, "from": frm, "to": to, "watermark": bool(watermark)}
    r = await _send("POST", url, headers=_headers(credential), json=body)
    _raise_for_node(r)
    return r.json() or {}


async def list_exports_node(api_url: str, camera_id: str, *, credential: str | None = None) -> dict:
    """GET {api_url}/api/v1/nvr/estate/exports?camera_id={id} → the node's export jobs for a
    camera. Returns { items: [...] }. NodeUnavailable on non-2xx."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/exports"
    r = await _send("GET", url, headers=_headers(credential), params={"camera_id": camera_id})
    _raise_for_node(r)
    return r.json() or {}


async def get_export_node(api_url: str, export_id: str, *, credential: str | None = None) -> dict:
    """GET {api_url}/api/v1/nvr/estate/exports/{export_id} → one export job's status.
    Returns { id, status, ... }. NodeUnavailable on non-2xx."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/exports/{export_id}"
    r = await _send("GET", url, headers=_headers(credential))
    _raise_for_node(r)
    return r.json() or {}


async def list_events_node(
    api_url: str,
    *,
    since: str | None = None,
    limit: int = 200,
    credential: str | None = None,
) -> dict:
    """GET {api_url}/api/v1/nvr/estate/events → the recorder's OWN event ledger,
    { items: [store.Event], total }.

    This is how an estate gets one event feed without a second listener. The recorder
    runs the ONVIF PullPoint subscription for its cameras; a central VMS that opened
    its own would be the SECOND subscriber on a device that commonly permits one, and
    the loser of that race gets nothing — silently, because a camera with no free
    subscription slot simply never delivers.

    ``since`` is RFC3339 and exclusive-ish (the node filters ``created_at >= since``),
    so a poller must dedupe rather than assume no overlap."""
    params: dict = {"limit": max(1, min(int(limit or 200), 500))}
    if since:
        params["since"] = since
    return await _node_json("GET", api_url, "/events", credential=credential, params=params)


async def verify_export_node(
    api_url: str, export_id: str, *, credential: str | None = None
) -> dict:
    """POST {api_url}/api/v1/nvr/estate/exports/{export_id}/verify — the RECORDER re-hashes
    the clip on its own disk and checks the manifest signature, returning
    { valid, reason, public_key, signed_by_this_node, manifest?, expected_sha256?,
    actual_sha256? }.

    The check has to happen on the node and nowhere else: the clip lives on the
    recorder's disk, the VMS never sees those bytes, and re-hashing a copy relayed
    through here would only prove the copy was intact. ``valid:false`` is a 200 with a
    reason — "this cannot be verified" is an answer, not a transport failure."""
    return await _node_json(
        "POST", api_url, f"/exports/{export_id}/verify", credential=credential,
    )


async def export_public_key_node(api_url: str, *, credential: str | None = None) -> dict:
    """GET {api_url}/api/v1/nvr/estate/exports/public-key → { algorithm, key_id, public_key }.

    The recorder's ed25519 signing key. Verifying a manifest against the key EMBEDDED in
    it proves only that whoever holds the matching private key signed it; proving it was
    THIS recorder means pinning the key from somewhere the document does not control."""
    return await _node_json("GET", api_url, "/exports/public-key", credential=credential)


async def export_manifest_node(
    api_url: str, export_id: str, *, credential: str | None = None
) -> tuple[bytes, str, str]:
    """GET {api_url}/api/v1/nvr/estate/exports/{export_id}/manifest → the signed
    chain-of-custody sidecar, relayed byte-for-byte.

    Byte-for-byte matters more here than anywhere else in this file: the signature covers
    the canonical encoding of the document, so re-serialising it through a Python dict
    would invalidate it for the offline verifier this file exists to feed."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/exports/{export_id}/manifest"
    r = await _send("GET", url, headers=_headers(credential))
    _raise_for_node(r)
    media_type = (r.headers.get("content-type") or "application/json").split(";", 1)[0].strip()
    filename = f"export-{export_id}.manifest.json"
    disp = r.headers.get("content-disposition") or ""
    if "filename=" in disp:
        parsed = disp.split("filename=", 1)[1].strip().strip('"').strip()
        if parsed:
            filename = parsed
    return r.content, media_type or "application/json", filename


async def download_export_node(
    api_url: str, export_id: str, *, credential: str | None = None
) -> tuple[bytes, str, str]:
    """GET {api_url}/api/v1/nvr/estate/exports/{export_id}/download → the produced mp4,
    streamed by the node as an attachment. These clips are short, so we load the body into
    memory and return (bytes, media_type, filename); filename is parsed from the node's
    Content-Disposition (falls back to ``export-{id}.mp4``). NodeUnavailable on non-2xx."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/exports/{export_id}/download"
    r = await _send("GET", url, headers=_headers(credential))
    _raise_for_node(r)
    media_type = (r.headers.get("content-type") or "video/mp4").split(";", 1)[0].strip() or "video/mp4"
    filename = f"export-{export_id}.mp4"
    disp = r.headers.get("content-disposition") or ""
    if "filename=" in disp:
        parsed = disp.split("filename=", 1)[1].strip().strip('"').strip()
        if parsed:
            filename = parsed
    return r.content, media_type, filename


async def evidence_hold_node(
    api_url: str, camera_id: str, frm: str, to: str, reason: str, *, credential: str | None = None
) -> dict:
    """POST {api_url}/api/v1/nvr/estate/cameras/{id}/holds → the node places an evidence
    hold on its own camera over [frm, to] with a reason. Returns the node's hold JSON.
    NodeUnavailable on non-2xx."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/cameras/{camera_id}/holds"
    body = {"from": frm, "to": to, "reason": reason}
    r = await _send("POST", url, headers=_headers(credential), json=body)
    _raise_for_node(r)
    return r.json() or {}


async def evidence_release_node(
    api_url: str, camera_id: str, frm: str, to: str, *, credential: str | None = None
) -> dict:
    """DELETE {api_url}/api/v1/nvr/estate/cameras/{id}/holds?from=&to= → the node releases
    the evidence hold on its own camera over [frm, to]. Returns the node's JSON.
    NodeUnavailable on non-2xx."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/cameras/{camera_id}/holds"
    r = await _send("DELETE", url, headers=_headers(credential), params={"from": frm, "to": to})
    _raise_for_node(r)
    return r.json() or {}


async def list_holds_node(api_url: str, camera_id: str, *, credential: str | None = None) -> dict:
    """GET {api_url}/api/v1/nvr/estate/holds?camera_id={id} → the node's active evidence
    holds for a camera. Returns { items: [...] }. NodeUnavailable on non-2xx."""
    url = f"{api_url.rstrip('/')}/api/v1/nvr/estate/holds"
    r = await _send("GET", url, headers=_headers(credential), params={"camera_id": camera_id})
    _raise_for_node(r)
    return r.json() or {}


# ── operate-THROUGH-node (Phase-4) — the per-camera DEVICE surface ────────────
#
# Everything below closed the last gap between Model A — the VMS decrypting a camera's
# own credentials and driving the device itself, which is deleted — and Model B, this
# module, where the owning NVR drives it. The node serves every one of the Go file that owns each handler is named above the function, and the
# request/response shapes are the Go DTOs verbatim — dicts, because the node's own
# handlers answer map[string]any and inventing a Pydantic mirror of a payload whose
# optional keys are the whole point (options_error, tours_supported tri-state,
# latching:null) would flatten exactly the distinctions those fields exist to draw.
#
# Auth: _headers(credential) — the SAME scoped X-Node-Credential the rest of this
# module presents, falling back to the shared-secret service JWT. No second mechanism.
#
# IMPORTANT, and not fixable from this side: every WRITE below is gated node-side on
# core.PermCameraManage, which federationGrants (estate/federation.go) deliberately
# does NOT include. So on a node that issued a scoped credential the reads pass and
# the writes come back 403 → NodeUnavailable → 502. They pass only where the node is
# still on the shared service JWT (superadmin). Widening the node's grant set is a
# node-side decision; this module is the surface that will use it when it lands.

_ESTATE = "/api/v1/nvr/estate"


async def _node_json(
    method: str,
    api_url: str,
    path: str,
    *,
    credential: str | None = None,
    params: dict | None = None,
    json_body: dict | None = None,
) -> dict:
    """One estate call → its JSON body, in this module's established idiom: httpx with
    ``_TIMEOUT``, ``_headers`` auth, and NodeUnavailable on a transport error or any
    non-2xx (the router maps that to a clean 502). A 204/empty body answers ``{}`` —
    the node returns 204 for a preset/tour/OSD/mask delete, which is a success, not a
    missing payload."""
    url = f"{api_url.rstrip('/')}{_ESTATE}{path}"
    r = await _send(method, url, headers=_headers(credential), params=params, json=json_body)
    if r.status_code // 100 != 2:
        # EVERY 4xx is a refusal, not only 401/403. The node answered and said no —
        # a malformed schedule document, an id that is not there, a conflict — and
        # reporting that as NodeUnavailable turns "this schedule is not a shape I
        # can read" into "recorder unavailable", which reads as a network fault,
        # invites a pointless retry, and buries the one sentence that would have
        # fixed it. Only a 5xx or a transport failure means the next try could
        # differ, which is exactly what 503 claims and 502 does not.
        raise (_refusal(r.status_code, r.text) if r.status_code // 100 == 4
                else NodeUnavailable(f"{r.status_code}: {_node_error_message(r, r.text[:160])}"))
    if r.status_code == 204 or not (r.content or b"").strip():
        return {}
    try:
        return r.json() or {}
    except ValueError as e:
        raise NodeUnavailable(f"node returned a non-JSON body: {e}") from e


# ── Image tab (internal/estate/onvifapi/imaging.go) ───────────────────────────


async def get_imaging_node(api_url: str, camera_id: str, *, credential: str | None = None) -> dict:
    """GET …/cameras/{id}/onvif/imaging → imaging.go getImaging:
    { settings, source_token, options, options_error?, focus? { movable, move_options?,
    move_options_error?, status?, status_error?, detail? } }."""
    return await _node_json("GET", api_url, f"/cameras/{camera_id}/onvif/imaging", credential=credential)


async def set_imaging_node(
    api_url: str, camera_id: str, body: dict, *, credential: str | None = None
) -> dict:
    """PUT …/cameras/{id}/onvif/imaging → imaging.go setImaging. Body is
    onvif.ImagingSettings (tt:ImagingSettings20; every child optional — a partial block
    is the normal way to change one setting). Returns { settings }."""
    return await _node_json(
        "PUT", api_url, f"/cameras/{camera_id}/onvif/imaging", credential=credential, json_body=body or {}
    )


async def focus_move_node(
    api_url: str, camera_id: str, body: dict, *, credential: str | None = None
) -> dict:
    """POST …/cameras/{id}/onvif/imaging/focus/move → imaging.go focusMoveReq
    { mode: "relative"|"absolute"|"continuous", distance?, position?, speed?, timeout_ms? }.
    Returns { moved: true, mode, source_token }."""
    return await _node_json(
        "POST", api_url, f"/cameras/{camera_id}/onvif/imaging/focus/move",
        credential=credential, json_body=body or {},
    )


async def focus_stop_node(api_url: str, camera_id: str, *, credential: str | None = None) -> dict:
    """POST …/cameras/{id}/onvif/imaging/focus/stop → imaging.go focusStop.
    Empty body; returns { stopped: true }."""
    return await _node_json(
        "POST", api_url, f"/cameras/{camera_id}/onvif/imaging/focus/stop",
        credential=credential, json_body={},
    )


# ── Video / Audio encoder tabs (internal/estate/onvifapi/video.go, audio.go) ──


async def get_video_node(api_url: str, camera_id: str, *, credential: str | None = None) -> dict:
    """GET …/cameras/{id}/onvif/video → video.go getVideo: { media_service,
    media2_available, media2_error?, configurations, options?, options_error?, … }."""
    return await _node_json("GET", api_url, f"/cameras/{camera_id}/onvif/video", credential=credential)


async def get_audio_node(api_url: str, camera_id: str, *, credential: str | None = None) -> dict:
    """GET …/cameras/{id}/onvif/audio → audio.go getAudio: { configurations, has_audio,
    scoped, scope_reason?, scope_detail?, writable, device_total?, channel_profiles?,
    linked_profiles?, unlisted_encoders?, source? }."""
    return await _node_json("GET", api_url, f"/cameras/{camera_id}/onvif/audio", credential=credential)


async def list_osds_node(api_url: str, camera_id: str, *, credential: str | None = None) -> dict:
    """GET …/cameras/{id}/onvif/osd → overlay.go getOSD:
    { osds: [onvif.OSD], config_token, options, options_error? }."""
    return await _node_json("GET", api_url, f"/cameras/{camera_id}/onvif/osd", credential=credential)


async def list_masks_node(api_url: str, camera_id: str, *, credential: str | None = None) -> dict:
    """GET …/cameras/{id}/onvif/masks → overlay.go getMasks: { masks: [onvif.Mask],
    config_token, coordinate_space { kind:"onvif_normalized", x_min:-1, x_max:1,
    y_min:-1, y_max:1, y_axis:"up" }, options, options_error? }."""
    return await _node_json("GET", api_url, f"/cameras/{camera_id}/onvif/masks", credential=credential)


async def get_backchannel_node(api_url: str, camera_id: str, *, credential: str | None = None) -> dict:
    """GET …/cameras/{id}/onvif/backchannel → overlay.go getBackchannel: whether the
    device can RECEIVE a talk-back stream, so the console enables or honestly disables
    push-to-talk. { support { supported, detail, decoder_formats, … }, …errors }."""
    return await _node_json(
        "GET", api_url, f"/cameras/{camera_id}/onvif/backchannel", credential=credential
    )


# ── camera-side motion detection (internal/estate/onvifapi/motion.go) ─────────


async def get_motion_node(api_url: str, camera_id: str, *, credential: str | None = None) -> dict:
    """GET …/cameras/{id}/onvif/motion → motion.go getMotion: { supported, profile_token,
    columns, rows, sensitivity, active_cells?, zones?, reason? }. ``supported:false`` with
    a ``reason`` is an honest device answer, NOT an error."""
    return await _node_json("GET", api_url, f"/cameras/{camera_id}/onvif/motion", credential=credential)


async def get_io_node(api_url: str, camera_id: str, *, credential: str | None = None) -> dict:
    """GET …/cameras/{id}/onvif/io → io.go getIO. Note ``scope:"device"`` — this payload
    describes the DEVICE, not the channel, and ``channels_on_device`` / ``channel_names``
    say who else is affected by driving a relay. { scope, device_service,
    device_io_service, device_host, channels_on_device, channel_names,
    relay_state_readable, relay_state_detail, digital_input_detail, digital_inputs,
    relay_outputs, device_io_supported, …_error?, …_unknown? }."""
    return await _node_json("GET", api_url, f"/cameras/{camera_id}/onvif/io", credential=credential)


async def set_relay_state_node(
    api_url: str, camera_id: str, token: str, body: dict, *, credential: str | None = None
) -> dict:
    """POST …/cameras/{id}/onvif/io/relays/{token}/state → io.go relayStateReq
    { state: "active"|"inactive" }. The only call in the estate API whose effect is
    PHYSICAL and outside the network. Returns { token, state, mode, latching } — where
    ``latching`` is THREE-valued: null (with mode_unknown) means the device did not
    report its mode, not "this relay does not latch"."""
    return await _node_json(
        "POST", api_url, f"/cameras/{camera_id}/onvif/io/relays/{token}/state",
        credential=credential, json_body=body or {},
    )


# ── PTZ presets / patrol / tours (onvifapi/ptz.go, ptz_patrol.go, ptz_tours.go) ──


async def get_ptz_node(api_url: str, camera_id: str, *, credential: str | None = None) -> dict:
    """GET …/cameras/{id}/onvif/ptz → ptz.go getPtz: the head's capability report
    { profile_token, node?, configuration?, presets, presets_error?, status?,
    status_error?, reason?, detail? }. No ``node`` means no movable head bound to this
    channel — an honest state, with ``detail`` saying which of the two it is."""
    return await _node_json("GET", api_url, f"/cameras/{camera_id}/onvif/ptz", credential=credential)


async def list_ptz_presets_node(api_url: str, camera_id: str, *, credential: str | None = None) -> dict:
    """GET …/cameras/{id}/onvif/ptz/presets → ptz.go ptzListPresets:
    { supported, items: [onvif.Preset], total, detail? }. These are the DEVICE's presets,
    not a stored VMS table."""
    return await _node_json(
        "GET", api_url, f"/cameras/{camera_id}/onvif/ptz/presets", credential=credential
    )


async def save_ptz_preset_node(
    api_url: str, camera_id: str, body: dict, *, credential: str | None = None
) -> dict:
    """POST …/cameras/{id}/onvif/ptz/presets → ptz.go ptzSavePreset { name, token? }.
    Empty token CREATES; a supplied token OVERWRITES that preset with the current
    position — two separate intentions the request must state. Returns { token, name }."""
    return await _node_json(
        "POST", api_url, f"/cameras/{camera_id}/onvif/ptz/presets",
        credential=credential, json_body=body or {},
    )


async def goto_ptz_preset_node(
    api_url: str, camera_id: str, preset: str, body: dict | None = None, *, credential: str | None = None
) -> dict:
    """POST …/cameras/{id}/onvif/ptz/presets/{preset}/goto → ptz.go ptzGotoPreset
    { speed?, zoom_speed? }; ``preset`` is the DEVICE token from the list above.
    Returns { moved: true, preset }."""
    return await _node_json(
        "POST", api_url, f"/cameras/{camera_id}/onvif/ptz/presets/{preset}/goto",
        credential=credential, json_body=body or {},
    )


async def delete_ptz_preset_node(
    api_url: str, camera_id: str, preset: str, *, credential: str | None = None
) -> dict:
    """DELETE …/cameras/{id}/onvif/ptz/presets/{preset} → ptz.go ptzRemovePreset.
    The node answers 204 No Content, so this returns {}."""
    return await _node_json(
        "DELETE", api_url, f"/cameras/{camera_id}/onvif/ptz/presets/{preset}", credential=credential
    )


async def get_patrol_node(api_url: str, camera_id: str, *, credential: str | None = None) -> dict:
    """GET …/cameras/{id}/onvif/ptz/patrol → ptz_patrol.go getPatrol: the HOST-DRIVEN
    patrol (``kind:"host_driven"`` — the recorder drives it, it is not stored on the
    camera). { enabled, stops, default_dwell_seconds, random_order, runnable,
    last_tick_at, last_error, kind, note, native_tours_supported?, native_tours_hint?,
    presets? }. ``native_tours_supported`` ABSENT means unknown, not "no"."""
    return await _node_json(
        "GET", api_url, f"/cameras/{camera_id}/onvif/ptz/patrol", credential=credential
    )


async def set_patrol_node(
    api_url: str, camera_id: str, body: dict, *, credential: str | None = None
) -> dict:
    """PUT …/cameras/{id}/onvif/ptz/patrol → ptz_patrol.go patrolWriteReq
    { enabled?, stops?: [{preset_token, dwell_seconds}], default_dwell_seconds?,
    random_order? }. Absent = leave untouched. Returns { saved, enabled, note? }."""
    return await _node_json(
        "PUT", api_url, f"/cameras/{camera_id}/onvif/ptz/patrol",
        credential=credential, json_body=body or {},
    )


async def operate_patrol_node(
    api_url: str, camera_id: str, body: dict, *, credential: str | None = None
) -> dict:
    """POST …/cameras/{id}/onvif/ptz/patrol/operate → ptz_patrol.go patrolOperate
    { operation: "start"|"stop" }. Returns { operation, enabled }."""
    return await _node_json(
        "POST", api_url, f"/cameras/{camera_id}/onvif/ptz/patrol/operate",
        credential=credential, json_body=body or {},
    )


async def list_ptz_tours_node(api_url: str, camera_id: str, *, credential: str | None = None) -> dict:
    """GET …/cameras/{id}/onvif/ptz/tours → ptz_tours.go ptzListTours — the tours stored
    ON THE DEVICE. { supported, profile_token, tours, presets, tours_supported?,
    tours_error?, device_fault?, options?, options_error?, presets_error?, detail? }.
    ``tours_supported`` is a TRI-STATE: true / false / absent ("we could not ask"), and
    only the last is worth a Retry — do not collapse it to a boolean."""
    return await _node_json(
        "GET", api_url, f"/cameras/{camera_id}/onvif/ptz/tours", credential=credential
    )


async def create_ptz_tour_node(
    api_url: str, camera_id: str, body: dict, *, credential: str | None = None
) -> dict:
    """POST …/cameras/{id}/onvif/ptz/tours → ptz_tours.go ptzCreateTour, body tourReq
    { name?, auto_start?, random_preset_order?, recurring_time? (a COUNT, not a time),
    recurring_duration_seconds?, direction?, spots?: [...] }. Returns
    { token, populated, tour? }; the node's create is deliberately NOT atomic and says
    so in its error when the follow-up modify fails."""
    return await _node_json(
        "POST", api_url, f"/cameras/{camera_id}/onvif/ptz/tours",
        credential=credential, json_body=body or {},
    )


async def modify_ptz_tour_node(
    api_url: str, camera_id: str, tour: str, body: dict, *, credential: str | None = None
) -> dict:
    """PUT …/cameras/{id}/onvif/ptz/tours/{tour} → ptz_tours.go ptzModifyTour (tourReq;
    a nil field leaves the device's own setting alone, but ``spots`` REPLACES the list
    wholesale — an empty array clears it). Returns { token, tour }."""
    return await _node_json(
        "PUT", api_url, f"/cameras/{camera_id}/onvif/ptz/tours/{tour}",
        credential=credential, json_body=body or {},
    )


async def delete_ptz_tour_node(
    api_url: str, camera_id: str, tour: str, *, credential: str | None = None
) -> dict:
    """DELETE …/cameras/{id}/onvif/ptz/tours/{tour} → ptz_tours.go ptzRemoveTour.
    204 No Content → {}."""
    return await _node_json(
        "DELETE", api_url, f"/cameras/{camera_id}/onvif/ptz/tours/{tour}", credential=credential
    )


async def operate_ptz_tour_node(
    api_url: str, camera_id: str, tour: str, body: dict, *, credential: str | None = None
) -> dict:
    """POST …/cameras/{id}/onvif/ptz/tours/{tour}/operate → ptz_tours.go ptzOperateTour
    { operation: "Start"|"Stop"|"Pause"|"Extended" } (onvif.TourOperations; the node
    canonicalises case). Returns { tour, operation, profile_token }."""
    return await _node_json(
        "POST", api_url, f"/cameras/{camera_id}/onvif/ptz/tours/{tour}/operate",
        credential=credential, json_body=body or {},
    )


# ── two-way audio: push-to-talk (onvifapi/talk.go, talk_uplink.go) ────────────


async def talk_begin_node(
    api_url: str, camera_id: str, body: dict | None = None, *, credential: str | None = None
) -> dict:
    """POST …/cameras/{id}/onvif/talk → talk.go postTalk, the BEGIN acknowledgement
    (capability + transport check plus the audited intent). Returns { talking:true,
    half_duplex, transport, support, started_at }. On a node with no talk transport
    configured (VE_TALK_TRANSPORT unset) it answers an honest 501 — surfaced here, like
    every other non-2xx, as NodeUnavailable carrying the node's OWN sentence, so the
    operator reads "the path is not built" rather than a bare status code."""
    return await _node_json(
        "POST", api_url, f"/cameras/{camera_id}/onvif/talk", credential=credential, json_body=body or {}
    )


async def talk_uplink_node(
    api_url: str,
    camera_id: str,
    body_stream,
    *,
    credential: str | None = None,
    timeout: float | None = None,
) -> dict:
    """POST …/cameras/{id}/onvif/talk/uplink → talk_uplink.go postTalkUplink — the
    microphone leg itself, a STREAMED PCM16LE 8 kHz mono body (the node packetizes
    20 ms / 160-sample frames). Returns { talked, half_duplex, codec, frames_sent,
    finished_at }.

    ``body_stream`` is an async byte iterator (FastAPI's ``request.stream()``), passed
    to httpx as a streaming body rather than buffered: a talk press is open-ended, and
    reading it into memory first would both cap how long an operator may hold the
    button and delay every frame until they let go. It is the ONE call in this module
    that does not go through ``_node_json`` — for that reason, and no other.

    The timeout is deliberately NOT ``_TIMEOUT``: 8 s is right for a control call and
    would cut a talk off mid-sentence. ``None`` (the default) means no read timeout —
    the press ends when the operator's body stream ends."""
    url = f"{api_url.rstrip('/')}{_ESTATE}/cameras/{camera_id}/onvif/talk/uplink"
    headers = dict(_headers(credential))
    headers["Content-Type"] = "application/octet-stream"
    r = await _send("POST", url, headers=headers, content=body_stream, timeout=timeout)
    _raise_for_node(r, detailed=True)
    try:
        return r.json() or {}
    except ValueError as e:
        raise NodeUnavailable(f"node returned a non-JSON body: {e}") from e


# ── forensic motion search (internal/estate/motionsearch.go) ─────────────────


async def motion_search_node(
    api_url: str, camera_id: str, body: dict, *, credential: str | None = None
) -> dict:
    """POST …/cameras/{id}/motion-search → motionsearch.go motionSearchRequest
    { from, to (RFC3339, both required), region? {x,y,w,h in 0..1}, sensitivity? (1..100,
    default 50), sample_interval_sec? (default 1), min_duration_sec?, merge_gap_sec? }.

    Returns { hits:[{start,end,duration_sec,score}], examined_from, examined_to,
    frames_examined, sample_interval_sec, complete, notes, gaps, summary, method }.

    ``method`` and ``summary`` are a NON-NEGOTIABLE disclosure the node carries on every
    response: this is region pixel-difference over recorded frames, NOT AI — no object
    detection, no classification. Relay them to the operator verbatim; a hit list
    stripped of them is exactly the output somebody reads as "three intruders".

    ``complete:false`` with ``notes`` means a bound bit (span / frame budget / deadline)
    and the window actually examined is narrower than the one asked for — which is
    precisely when an empty hit list must NOT be read as "the footage is clear".

    Note this is a bare estate route, NOT under /onvif/: it reads the recording index
    and decodes segments; it never touches the camera."""
    # A longer budget than _TIMEOUT: this decodes footage, and 8s is a control-call
    # timeout, not a search one. The node applies its own bounds and reports them.
    url = f"{api_url.rstrip('/')}{_ESTATE}/cameras/{camera_id}/motion-search"
    r = await _send("POST", url, headers=_headers(credential), json=body or {}, timeout=120.0)
    _raise_for_node(r, detailed=True)
    return r.json() or {}


# ── recording schedules (Phase-3, the one config authorship) ─────────────────
#
# "Record this camera 09:00-18:00 on weekdays" is weekly operator work, and until
# the node's grant set was widened it could only be done on the recorder's own
# screen. These call the node's schedule-template library and its per-camera
# recording config.
#
# Gated node-side on ``recording.read`` / ``recording.configure``. The read half a
# federation credential has always carried; the WRITE half arrived with the grant
# set, so a node enrolled before that refuses every write here — and says so, by
# name, through _refusal. That sentence is the whole reason not to flatten a 403
# into "unavailable": the fix is a re-enrolment, not a network.

_SCHEDULE_TEMPLATES = "/recording-schedule-templates"


async def list_schedule_templates(api_url: str, *, credential: str | None = None) -> dict:
    """GET → { items, total }: this recorder's named schedule library."""
    return await _node_json("GET", api_url, _SCHEDULE_TEMPLATES, credential=credential)


async def create_schedule_template(
    api_url: str, body: dict, *, credential: str | None = None
) -> dict:
    """POST → the created template. The node VALIDATES the schedule document, so an
    unusable week is refused here rather than discovered on forty cameras later."""
    return await _node_json("POST", api_url, _SCHEDULE_TEMPLATES, credential=credential, json_body=body)


async def update_schedule_template(
    api_url: str, template_id: str, body: dict, *, credential: str | None = None
) -> dict:
    """PUT → the updated template. Editing does NOT re-write cameras an earlier
    apply set; those hold their own copy. Re-apply to push a new version."""
    return await _node_json(
        "PUT", api_url, f"{_SCHEDULE_TEMPLATES}/{template_id}", credential=credential, json_body=body
    )


async def delete_schedule_template(
    api_url: str, template_id: str, *, credential: str | None = None
) -> dict:
    """DELETE → { deleted, id }. Cameras keep the schedule they were given."""
    return await _node_json(
        "DELETE", api_url, f"{_SCHEDULE_TEMPLATES}/{template_id}", credential=credential
    )


async def apply_schedule_template(
    api_url: str, template_id: str, camera_ids: list[str], *, credential: str | None = None
) -> dict:
    """POST /{id}/apply → a PER-CAMERA outcome, never all-or-nothing: one camera the
    credential may not touch does not cost the other thirty-nine, and the response
    names which changed and which did not."""
    return await _node_json(
        "POST", api_url, f"{_SCHEDULE_TEMPLATES}/{template_id}/apply",
        credential=credential, json_body={"camera_ids": camera_ids},
    )


async def get_camera_recording(
    api_url: str, camera_id: str, *, credential: str | None = None
) -> dict:
    """GET a camera's own recording config — mode, schedule, retention, buffers."""
    return await _node_json(
        "GET", api_url, f"/cameras/{camera_id}/recording", credential=credential
    )


async def put_camera_recording(
    api_url: str, camera_id: str, body: dict, *, credential: str | None = None
) -> dict:
    """PATCH-shaped PUT: a partial config writes only the fields it carries, so
    sending {"schedule": …} cannot silently reset retention to a default."""
    return await _node_json(
        "PUT", api_url, f"/cameras/{camera_id}/recording", credential=credential, json_body=body
    )


# ── archive + restore (cold tier), READ ONLY ────────────────────────────────
#
# The archive makes a durable second copy; retention later removes the LOCAL one,
# leaving footage recoverable only from the archive. Three reads say what that
# posture is, what is recoverable, and how past recoveries went.
#
# There is no write here, and the absence is the design. Starting a restore writes
# footage back to local disk and re-indexes it; configuring the archive decides
# where every future copy lands. Both gate node-side on ``vms.storage.manage``,
# which the federation credential does not carry and is not going to — reading how
# full a disk is and deciding where footage lives are not the same act. A route for
# them here could only ever produce a refusal, so the console links out to the
# recorder instead of offering a button that cannot work.


async def get_node_archive(api_url: str, *, credential: str | None = None) -> dict:
    """GET …/storage/archive → the archive schedule, its destination, when it last
    ran and what it moved, plus the estate's archived/local-only/cold-only counts.

    `blocked_reason` is the field worth surfacing: the recorder says when the
    archive is configured but cannot run (no destination, pool offline), which is
    the difference between "nothing archived yet" and "nothing will be."""
    return await _node_json("GET", api_url, "/storage/archive", credential=credential)


async def get_node_restore_ranges(
    api_url: str,
    *,
    camera_id: str | None = None,
    frm: str | None = None,
    to: str | None = None,
    credential: str | None = None,
) -> dict:
    """GET …/storage/restore/ranges → cold-ONLY manifest entries: footage that no
    longer exists on local disk and survives in the archive alone. This is the
    honest answer to "the timeline is empty here, is the footage gone" — and the
    two answers are very different."""
    return await _node_json(
        "GET", api_url, "/storage/restore/ranges",
        params={"camera_id": camera_id, "from": frm, "to": to},
        credential=credential,
    )


async def get_node_restore_jobs(api_url: str, *, credential: str | None = None) -> dict:
    """GET …/storage/restore/jobs → recent restores with their per-segment counts.

    `requested`/`restored`/`failed` are all carried: a restore that recovered 40 of
    50 segments is not a success and not a failure, and only the counts say so."""
    return await _node_json("GET", api_url, "/storage/restore/jobs", credential=credential)
