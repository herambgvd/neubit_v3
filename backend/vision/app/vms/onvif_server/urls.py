"""URL resolution for the ONVIF server responses (P6-C).

The ONVIF StreamUri / SnapshotUri / ReplayUri must point an external client at OUR
externally-reachable media, NOT at the internal docker hostnames. The rules:

  * **StreamUri (live)** → the MediaMTX RTSP form the Go ``nvr`` publishes:
    ``rtsp://<host>:<rtsp_port>/cameras/<tenant>/<camera>/<profile>`` (matches
    ``mediamtx.RTSPURL`` + ``PathName`` in the Go nvr — an ONVIF client pulls RTSP, so
    we hand back the RTSP transport form of the same path the HLS/WHEP flow uses).
  * **SnapshotUri** → OUR gateway-routed snapshot endpoint for the camera.
  * **ReplayUri (recorded)** → the gateway-routed MediaMTX recorded-playback ``/get``
    URL for the segment/time-range (the P4 playback path).

Host/ports come from the tenant's ``OnvifServerConfig`` (advertised_*) when set, else
from the SOAP request host (behind the gateway) + env defaults
(``VE_MEDIAMTX_RTSP_BASE``). No credential is embedded in the RTSP URL — the MediaMTX
path is already provisioned server-side; the client just pulls it.
"""

from __future__ import annotations

import os
from urllib.parse import urlsplit


def _rtsp_defaults() -> tuple[str, int]:
    """(host, port) parsed from ``VE_MEDIAMTX_RTSP_BASE`` (default rtsp://localhost:8554)."""
    base = os.environ.get("VE_MEDIAMTX_RTSP_BASE", "rtsp://localhost:8554").strip()
    parts = urlsplit(base)
    host = parts.hostname or "localhost"
    port = parts.port or 8554
    return host, port


def request_host(headers, url_hostname: str | None) -> str:
    """The externally-reachable host from the forwarded/host header (no port)."""
    fwd = headers.get("x-forwarded-host") or headers.get("host") or ""
    host = fwd or (url_hostname or "localhost")
    return host.split(":")[0]


def http_base(config, headers, url_hostname: str | None, scheme: str) -> str:
    """Base ``http(s)://host[:port]`` for SOAP XAddrs + snapshot URLs."""
    host = config.advertised_host or request_host(headers, url_hostname)
    port = config.advertised_http_port
    if port and int(port) not in (80, 443):
        return f"{scheme}://{host}:{int(port)}"
    return f"{scheme}://{host}"


def rtsp_stream_uri(config, headers, url_hostname: str | None, *, tenant, camera_id, profile) -> str:
    """The MediaMTX RTSP URL for a live camera/profile (Profile-S StreamUri)."""
    default_host, default_port = _rtsp_defaults()
    host = config.advertised_host or request_host(headers, url_hostname) or default_host
    port = config.advertised_rtsp_port or default_port
    tenant_seg = str(tenant) if tenant else "platform"
    path = f"cameras/{tenant_seg}/{camera_id}/{profile}"
    return f"rtsp://{host}:{int(port)}/{path}"


def snapshot_uri(config, headers, url_hostname: str | None, scheme: str, camera_id: str) -> str:
    """OUR gateway-routed snapshot endpoint for the camera."""
    base = http_base(config, headers, url_hostname, scheme)
    return f"{base}/api/v1/vms/cameras/{camera_id}/snapshot"


def replay_uri(
    config,
    headers,
    url_hostname: str | None,
    scheme: str,
    *,
    tenant,
    camera_id: str,
    profile: str,
    start_iso: str | None,
    duration_s: float | None,
) -> str:
    """The gateway-routed MediaMTX recorded-playback ``/get`` URL for a time range.

    Mirrors the P4 playback path the browser uses: ``/media/playback/get?path=…`` with
    the MediaMTX path name + ISO start + duration. An ONVIF replay client can pull this
    as the recorded stream for the requested window.
    """
    base = http_base(config, headers, url_hostname, scheme)
    tenant_seg = str(tenant) if tenant else "platform"
    path = f"cameras/{tenant_seg}/{camera_id}/{profile}"
    qs = f"path={path}"
    if start_iso:
        qs += f"&start={start_iso}"
    if duration_s:
        qs += f"&duration={int(duration_s)}"
    return f"{base}/media/playback/get?{qs}"
