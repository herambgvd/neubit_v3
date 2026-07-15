"""OnvifDriver — the default multi-brand driver (ONVIF Profile S / G / T).

Faithful port of gvd_nvr's ``backend/app/cameras/onvif_service.py``,
``onvif_service`` PTZ (``cameras/onvif/ptz.py``) and ``onvif_event_service.py``,
adapted to the ``CameraDriver`` interface + this service's async/typed-DTO
conventions. Covers the overwhelming majority of IP cameras + NVRs (any Profile-S
device), so it is the default the factory returns when no brand-specific driver is
selected.

Ported source → driver method:
  * ``onvif_service.discover`` + ``_wsd_scan`` + ``_autodetect_subnet`` +
    ``_tcp_subnet_scan`` + ``_probe_host`` + ``_is_onvif_endpoint``  → ``discover``.
  * ``onvif_service.get_device_info`` (+ GetCapabilities/GetNetworkInterfaces)     → ``probe``.
  * ``onvif_service.enumerate_channels`` (VideoSource grouping, main/sub by width)  → ``enumerate_channels``.
  * ``onvif_service.get_stream_uris`` + ``get_stream_uris_media2`` (+ fallback)     → ``get_stream_uris``.
  * ``onvif_service.get_capabilities``                                              → ``get_capabilities``.
  * ``onvif_service.fetch_snapshot`` (GetSnapshotUri → HTTP → RTSP-ffmpeg fallback) → ``get_snapshot``.
  * ``cameras/onvif/ptz.py`` (continuous/relative/absolute/stop/presets)            → ``ptz``.
  * ``onvif_service.get_imaging_settings/set_imaging_settings/get_relay_outputs/…`` → ``configure``.
  * ``onvif_event_service._TOPIC_MAP`` + ``_CameraPullWorker``                       → ``event_topic_map`` + ``subscribe_events``.
  * ``onvif_service.search_recordings`` + ``get_replay_uri`` (Profile G)            → ``search_recordings`` + ``get_playback_uri``.

The python-onvif-zeep + WSDiscovery SDKs are OPTIONAL (imported lazily, degrade
gracefully) exactly as in gvd_nvr — SOAP/HTTP-only paths (endpoint verification,
subnet scan) work without them. All blocking zeep calls run in ``asyncio.to_thread``.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import re
import socket
from typing import Any
from datetime import datetime as _dt
from datetime import timezone as _tz
from urllib.parse import quote as _q
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from .base import (
    Capabilities,
    Channel,
    CameraDriver,
    ConfigBackup,
    Credentials,
    DeviceEvent,
    DeviceInfo,
    Discovered,
    DriverError,
    EventCallback,
    FleetOpResult,
    PtzCommand,
    StreamCodecProfile,
    StreamInfo,
    StreamUris,
)

log = logging.getLogger("vision.drivers.onvif")

# Common ONVIF service ports across vendors (gvd_nvr ONVIF_PROBE_PORTS, verbatim).
# Order matters — 80 first since ~99% of cameras serve there.
ONVIF_PROBE_PORTS = (80, 81, 82, 8080, 8000, 8899, 2020, 8081, 8181, 8443, 443, 34567)

# ── Optional SDK imports — gracefully degrade if not installed (gvd_nvr pattern) ──
try:
    from onvif import ONVIFCamera  # type: ignore

    _HAS_ONVIF = True
except ImportError:  # pragma: no cover - env-dependent
    _HAS_ONVIF = False
    ONVIFCamera = None  # type: ignore
    log.info("python-onvif-zeep not installed — ONVIF SDK ops disabled (SOAP-probe paths still work)")

try:
    from wsdiscovery import WSDiscovery  # type: ignore

    _HAS_WSDISCOVERY = True
except ImportError:  # pragma: no cover - env-dependent
    _HAS_WSDISCOVERY = False
    WSDiscovery = None  # type: ignore
    log.info("WSDiscovery not installed — multicast discovery disabled (subnet-scan fallback still works)")


# ── ONVIF topic → (event_type, severity, title) — gvd_nvr _TOPIC_MAP, verbatim ──
ONVIF_TOPIC_MAP: dict[str, tuple[str, str, str]] = {
    # Motion
    "tns1:VideoSource/MotionAlarm": ("motion_detected", "alarm", "Motion detected"),
    "tns1:VideoSource/GlobalSceneChange/IVA": ("motion_detected", "alarm", "Scene change detected"),
    "tns1:VideoAnalytics/Motion/Alarm": ("motion_detected", "alarm", "Motion alarm"),
    # Tamper
    "tns1:VideoSource/ImageTooBlurry": ("camera_tamper", "alarm", "Camera tamper — image too blurry"),
    "tns1:VideoSource/ImageTooDark": ("camera_tamper", "alarm", "Camera tamper — image too dark"),
    "tns1:VideoSource/ImageTooBright": ("camera_tamper", "warning", "Camera tamper — image too bright"),
    "tns1:VideoSource/GlobalSceneChange": ("camera_tamper", "alarm", "Global scene change / possible tamper"),
    # Digital I/O
    "tns1:Device/Trigger/DigitalInput": ("digital_input_change", "alarm", "Digital input triggered"),
    # Analytics
    "tns1:RuleEngine/LineDetector/Crossed": ("line_crossing", "alarm", "Line crossing detected"),
    "tns1:RuleEngine/FieldDetector/ObjectInside": ("zone_intrusion", "alarm", "Intrusion detected"),
    "tns1:RuleEngine/CountAggregation/Alarm": ("zone_intrusion", "warning", "Object count alarm"),
    # Audio
    "tns1:AudioAnalytics/Audio/DetectedSound": ("audio_alarm", "alarm", "Audio alarm detected"),
    # Face
    "tns1:VideoAnalytics/FaceDetection/Alarm": ("face_detected", "info", "Face detected"),
    # Video signal
    "tns1:VideoSource/ConnectionFailed": ("video_loss", "critical", "Video signal lost"),
    # Thermal
    "tns1:ThermalService/TemperatureAlarm": ("system_error", "alarm", "Temperature alarm"),
}


def _is_media2_ns(ns: str) -> bool:
    """True if an ONVIF service namespace denotes the Media2 (Profile T) service.

    gvd_nvr checked ``"media/2" in ns or "media/wsdl/media2" in ns``, but the actual
    ONVIF Media2 WSDL namespace is ``http://www.onvif.org/ver20/media/wsdl`` — so the
    original check missed spec-compliant devices. This corrects it (still matches the
    older forms) rather than porting the bug forward."""
    return "ver20/media" in ns or "media/2" in ns or "media/wsdl/media2" in ns


def _resolve_topic(raw_topic: str) -> tuple[str, str, str] | None:
    """Match a raw ONVIF topic against ONVIF_TOPIC_MAP (exact, then prefix walk).
    Ported from gvd_nvr ``onvif_event_service._resolve_topic``."""
    raw = raw_topic.strip()
    if raw in ONVIF_TOPIC_MAP:
        return ONVIF_TOPIC_MAP[raw]
    parts = raw.rsplit("/", 1)
    while parts:
        candidate = parts[0]
        if candidate in ONVIF_TOPIC_MAP:
            return ONVIF_TOPIC_MAP[candidate]
        if "/" not in candidate:
            break
        parts = candidate.rsplit("/", 1)
    return None


# ── Discovery helpers (gvd_nvr onvif_service module functions, ported) ───────────
def _autodetect_subnet() -> str | None:
    """Return the CIDR to probe. Priority: LAN_SUBNET env → default-route /24
    (refusing Docker bridge ranges) → None. Ported from gvd_nvr ``_autodetect_subnet``."""
    env_subnet = os.environ.get("LAN_SUBNET", "").strip()
    if env_subnet:
        try:
            ipaddress.ip_network(env_subnet, strict=False)
            return env_subnet
        except ValueError:
            log.warning("LAN_SUBNET env var invalid: %s", env_subnet)

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            host_ip = s.getsockname()[0]
        net = ipaddress.ip_network(f"{host_ip}/24", strict=False)
        # Refuse Docker bridge networks (172.16/12) — won't reach LAN cameras.
        if ipaddress.ip_network("172.16.0.0/12").supernet_of(net):
            log.info("Auto-detected subnet %s is a Docker bridge; set LAN_SUBNET explicitly.", net)
            return None
        return str(net)
    except Exception as exc:  # noqa: BLE001
        log.warning("Subnet autodetect failed: %s", exc)
        return None


async def _tcp_reachable(host: str, port: int, timeout: float = 2.0) -> bool:
    """Fast TCP pre-check before invoking the BLOCKING onvif-zeep SDK.

    The onvif-zeep / zeep SDK constructs an ``ONVIFCamera`` synchronously (WSDL load +
    SOAP call) with long internal retry/connect timeouts — against an unreachable host a
    single ``GetProfiles`` can block ~75s. Since the SDK became a runtime dep (P1-E), an
    onboarding request against a down NVR would hang. Gate every SDK-backed method on a
    2s TCP connect first: unreachable → return the graceful empty result immediately;
    reachable → proceed to the (now safe) SDK call. Keeps graceful-on-unreachable FAST."""
    try:
        fut = asyncio.open_connection(host, port)
        _reader, writer = await asyncio.wait_for(fut, timeout=timeout)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass
        return True
    except (asyncio.TimeoutError, OSError):
        return False


async def _probe_host(ip: str, timeout: float) -> dict[str, Any] | None:
    """TCP-probe ONVIF_PROBE_PORTS; first open port → candidate.
    Ported from gvd_nvr ``_probe_host``."""
    for port in ONVIF_PROBE_PORTS:
        try:
            fut = asyncio.open_connection(ip, port)
            _reader, writer = await asyncio.wait_for(fut, timeout=timeout)
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:  # noqa: BLE001
                pass
            return {
                "ip": ip,
                "port": port,
                "xaddr": f"http://{ip}:{port}/onvif/device_service",
            }
        except (asyncio.TimeoutError, OSError):
            continue
    return None


async def _tcp_subnet_scan(subnet: str, timeout: float = 0.8) -> list[dict[str, Any]]:
    """Parallel TCP probe (concurrency 256) across a subnet.
    Ported from gvd_nvr ``_tcp_subnet_scan``."""
    try:
        net = ipaddress.ip_network(subnet, strict=False)
    except ValueError as exc:
        log.warning("Invalid subnet %s: %s", subnet, exc)
        return []
    if net.num_addresses > 1024:
        log.warning("Subnet %s too large (%d hosts); aborting scan", subnet, net.num_addresses)
        return []

    sem = asyncio.Semaphore(256)

    async def _bounded(ip: str) -> dict[str, Any] | None:
        async with sem:
            return await _probe_host(ip, timeout)

    tasks = [_bounded(str(ip)) for ip in net.hosts()]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    return [r for r in results if isinstance(r, dict)]


async def _is_onvif_endpoint(ip: str, port: int, timeout: float = 2.0) -> bool:
    """Verify a host speaks ONVIF SOAP via an unauthenticated GetSystemDateAndTime.
    Ported from gvd_nvr ``_is_onvif_endpoint`` (drops non-camera hits)."""
    import httpx

    body = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">'
        '<s:Body><GetSystemDateAndTime '
        'xmlns="http://www.onvif.org/ver10/device/wsdl"/>'
        "</s:Body></s:Envelope>"
    )
    headers = {
        "Content-Type": "application/soap+xml; charset=utf-8",
        "SOAPAction": '"http://www.onvif.org/ver10/device/wsdl/GetSystemDateAndTime"',
    }
    urls = [
        f"http://{ip}:{port}/onvif/device_service",
        f"http://{ip}:{port}/onvif/services",
    ]
    for url in urls:
        try:
            async with httpx.AsyncClient(timeout=timeout, verify=False) as client:
                r = await client.post(url, content=body, headers=headers)
            text = r.text.lower()
            if "envelope" in text and ("onvif" in text or "getsystemdateandtimeresponse" in text):
                return True
        except Exception:  # noqa: BLE001
            continue
    return False


async def _rtsp_grab_jpeg(rtsp_url: str, timeout: float = 5.0) -> bytes | None:
    """Pull a single JPEG from an RTSP stream via ffmpeg (snapshot fallback).
    Ported from gvd_nvr ``_rtsp_grab_jpeg``."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-rtsp_transport", "tcp",
            "-stimeout", str(int(timeout * 1_000_000)),
            "-y",
            "-i", rtsp_url,
            "-frames:v", "1",
            "-f", "image2pipe",
            "-vcodec", "mjpeg",
            "-q:v", "5",
            "pipe:1",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except (FileNotFoundError, OSError):
        return None
    try:
        stdout, _stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout + 2)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        return None
    if proc.returncode != 0 or not stdout or not stdout.startswith(b"\xff\xd8"):
        return None
    return stdout


def _inject_creds(url: str, username: str, password: str) -> str:
    """Percent-encode + inject rtsp creds so @ / : / # / space survive URL parsing
    downstream (go2rtc / ffmpeg / browsers). gvd_nvr credential-injection, verbatim.
    Idempotent: skips URLs that already carry an ``@`` in the authority."""
    if not username or "://" not in url:
        return url
    proto, rest = url.split("://", 1)
    authority = rest.split("/", 1)[0]
    if "@" in authority:
        return url
    return f"{proto}://{_q(username, safe='')}:{_q(password or '', safe='')}@{rest}"


# ── ONVIF Profile-G (recording/search/replay) helpers ─────────────────────────
# Many NVRs (incl. GVD/GV-* firmware) advertise the recording/search/replay services
# in ``GetServices`` but NOT in the legacy ``GetCapabilities`` that python-onvif's
# ``create_*_service`` relies on — so the SDK raises "device doesn't support service".
# We fix that by injecting the XAddrs from ``GetServices`` before creating the services.
_REC_NS = "http://www.onvif.org/ver10/recording/wsdl"
_SEARCH_NS = "http://www.onvif.org/ver10/search/wsdl"
_REPLAY_NS = "http://www.onvif.org/ver10/replay/wsdl"


def _attach_profileg(cam) -> tuple[Any, Any]:
    """Inject Profile-G XAddrs from GetServices, then create the recording + search
    services. Returns (recording_service, search_service); either may be None."""
    try:
        dev = cam.create_devicemgmt_service()
        xaddr = {s.Namespace: s.XAddr for s in dev.GetServices({"IncludeCapability": False})}
        for ns in (_REC_NS, _SEARCH_NS, _REPLAY_NS):
            if ns in xaddr:
                cam.xaddrs[ns] = xaddr[ns]
    except Exception as exc:  # noqa: BLE001
        log.warning("ONVIF GetServices/XAddr inject failed: %s", exc)
    recording = search = None
    try:
        recording = cam.create_recording_service()
    except Exception:  # noqa: BLE001
        recording = None
    try:
        search = cam.create_search_service()
    except Exception:  # noqa: BLE001
        search = None
    return recording, search


_TOKEN_RE = re.compile(r"_(\d+)_(main|sub)$")


def _tokens_for_channel(recs, channel, *, stream: str = "main") -> list[str]:
    """RecordingTokens (``RecordingToken_<n>_<stream>``) for a channel. The token index
    ``n`` is the ONVIF **video-source index** == our ``nvr_channel_number`` (NOT a 1-based
    physical channel) — e.g. our "Channel 4" (nvr_channel_number 6) → ``RecordingToken_6``.
    Numeric-index match (no lexical sort). ``channel`` None → all tokens for the stream."""
    pairs: list[tuple[int, str]] = []
    for r in recs:
        tok = str(getattr(r, "RecordingToken", "") or "")
        m = _TOKEN_RE.search(tok)
        if m and m.group(2) == stream:
            pairs.append((int(m.group(1)), tok))
    pairs.sort()
    if channel is None:
        return [t for _, t in pairs]
    ch = int(channel)
    for i, t in pairs:
        if i == ch:
            return [t]
    return []


def _onvif_iso(dt) -> str | None:
    """A zeep datetime (or str) → 'YYYY-MM-DDTHH:MM:SSZ'."""
    if dt is None:
        return None
    if isinstance(dt, str):
        return _nvr_time(dt)
    try:
        return dt.astimezone(_tz.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:  # noqa: BLE001
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _nvr_time(iso: str | None) -> str | None:
    """Any ISO-8601 string → 'YYYY-MM-DDTHH:MM:SSZ' (the NVR replay-URI format; drops
    fractional seconds so string comparison against recorded spans is uniform)."""
    if not iso:
        return None
    try:
        d = _dt.fromisoformat(str(iso).replace("Z", "+00:00"))
        return d.astimezone(_tz.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:  # noqa: BLE001
        return str(iso)


def _recording_span(search, recording, token: str) -> tuple[str, str] | None:
    """(from, until) recorded span for a token via GetRecordingInformation. None if N/A."""
    for svc in (search, recording):
        if svc is None:
            continue
        try:
            info = svc.GetRecordingInformation({"RecordingToken": token})
            frm = _onvif_iso(getattr(info, "EarliestRecording", None))
            until = _onvif_iso(getattr(info, "LatestRecording", None))
            if frm and until:
                return frm, until
        except Exception:  # noqa: BLE001
            continue
    return None


def _rewrite_replay_window(
    url: str, start_time: str | None, end_time: str | None, subtype: int | None = None
) -> str:
    """Rewrite starttime/endtime (and optionally subtype) query params in an NVR replay
    RTSP URI. ``subtype`` override is needed because this NVR's ``GetReplayUri`` returns
    ``subtype=0`` (main) for BOTH the main and sub recording tokens — so to actually play
    the H.264 sub stream we must force ``subtype=1`` in the URL ourselves."""
    if not (start_time or end_time or subtype is not None):
        return url
    p = urlparse(url)
    q = parse_qs(p.query)
    if start_time and _nvr_time(start_time):
        q["starttime"] = [_nvr_time(start_time)]
    if end_time and _nvr_time(end_time):
        q["endtime"] = [_nvr_time(end_time)]
    if subtype is not None:
        q["subtype"] = [str(subtype)]
    return urlunparse(p._replace(query=urlencode(q, doseq=True)))


class OnvifDriver(CameraDriver):
    """Default ONVIF driver — Profile S (live) + G (recording/playback) + T (H.265)."""

    brand = "onvif"

    # ── discovery ────────────────────────────────────────────────────────────
    async def discover(
        self, network: str | None = None, *, creds: Credentials | None = None, timeout: int = 5
    ) -> list[Discovered]:
        """WS-Discovery (multicast 239.255.255.250:3702) → TCP subnet-scan fallback →
        enrichment (device info + ONVIF-endpoint verification). Ported from
        gvd_nvr ``onvif_service.discover``. Never raises."""
        candidates: list[dict[str, Any]] = []

        if _HAS_WSDISCOVERY:
            try:
                candidates = await asyncio.to_thread(self._wsd_scan, timeout)
            except Exception as exc:  # noqa: BLE001
                log.warning("WS-Discovery scan failed: %s", exc)
                candidates = []

        if not candidates:
            target = network or _autodetect_subnet()
            if target:
                log.info("WS-Discovery empty; TCP subnet scan on %s", target)
                candidates = await _tcp_subnet_scan(target, timeout=2.0)
            else:
                log.warning("Could not auto-detect subnet for fallback scan")

        # Enrich: try device info with operator creds; else confirm ONVIF-endpoint.
        username = (creds.username if creds else None) or "admin"
        password = (creds.password if creds else None) or "admin"
        out: list[Discovered] = []
        for cand in candidates:
            ip, port = cand["ip"], cand["port"]
            info = await self.probe(ip, Credentials(username=username, password=password, port=port))
            if info.reachable:
                out.append(
                    Discovered(
                        ip=ip,
                        port=port,
                        xaddr=cand.get("xaddr"),
                        name=info.model,
                        manufacturer=info.manufacturer,
                        model=info.model,
                        firmware=info.firmware,
                        serial_number=info.serial_number,
                        mac=info.mac,
                        brand="onvif",
                    )
                )
                continue
            # No info from probe creds → confirm it actually speaks ONVIF.
            if await _is_onvif_endpoint(ip, port):
                out.append(Discovered(ip=ip, port=port, xaddr=cand.get("xaddr"), brand="onvif", auth_required=True))
            # else: silently drop — not an ONVIF device.
        return out

    def _wsd_scan(self, timeout: int) -> list[dict[str, Any]]:
        """Synchronous WS-Discovery scan (runs in thread). gvd_nvr ``_wsd_scan``, verbatim."""
        results: list[dict[str, Any]] = []
        wsd = WSDiscovery()
        wsd.start()
        try:
            for svc in wsd.searchServices(timeout=timeout):
                if not any("NetworkVideoTransmitter" in str(t) for t in svc.getTypes()):
                    continue
                for xaddr in svc.getXAddrs():
                    try:
                        parsed = urlparse(xaddr)
                        results.append({"ip": parsed.hostname, "port": parsed.port or 80, "xaddr": xaddr})
                    except Exception:  # noqa: BLE001
                        pass
        finally:
            wsd.stop()
        return results

    # ── probe / identity ─────────────────────────────────────────────────────
    async def probe(self, host: str, creds: Credentials) -> DeviceInfo:
        """GetDeviceInformation + GetCapabilities + GetNetworkInterfaces.
        Ported from gvd_nvr ``get_device_info``. Never raises."""
        if not _HAS_ONVIF:
            # SDK-free fallback: at least confirm ONVIF SOAP reachability.
            reachable = await _is_onvif_endpoint(host, creds.port)
            return DeviceInfo(
                reachable=reachable,
                error=None if reachable else "python-onvif-zeep not installed; SOAP probe failed",
            )

        # Fast TCP gate: skip the ~75s blocking SDK call when the host is down.
        if not await _tcp_reachable(host, creds.port):
            return DeviceInfo(reachable=False, error=f"host {host}:{creds.port} unreachable (TCP connect failed)")

        def _query() -> DeviceInfo:
            try:
                cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
                info = cam.devicemgmt.GetDeviceInformation()
                out = DeviceInfo(
                    reachable=True,
                    manufacturer=getattr(info, "Manufacturer", None),
                    model=getattr(info, "Model", None),
                    firmware=getattr(info, "FirmwareVersion", None),
                    serial_number=getattr(info, "SerialNumber", None),
                    hardware_id=getattr(info, "HardwareId", None),
                )
                try:
                    caps = cam.devicemgmt.GetCapabilities({"Category": "All"})
                    out.has_ptz = bool(getattr(caps, "PTZ", None))
                    out.has_imaging = bool(getattr(caps, "Imaging", None))
                    out.has_analytics = bool(getattr(caps, "Analytics", None))
                    out.has_events = bool(getattr(caps, "Events", None))
                except Exception:  # noqa: BLE001
                    pass
                try:
                    ifaces = cam.devicemgmt.GetNetworkInterfaces()
                    for iface in ifaces or []:
                        info_obj = getattr(iface, "Info", None)
                        if info_obj and getattr(info_obj, "HwAddress", None):
                            out.mac = info_obj.HwAddress
                            break
                except Exception:  # noqa: BLE001
                    pass
                # Best-effort channel count = distinct video sources.
                try:
                    media = cam.create_media_service()
                    out.channel_count = len(media.GetVideoSources() or [])
                except Exception:  # noqa: BLE001
                    pass
                return out
            except Exception as exc:  # noqa: BLE001
                log.warning("ONVIF probe failed for %s: %s", host, exc)
                return DeviceInfo(reachable=False, error=str(exc))

        return await asyncio.to_thread(_query)

    # ── channel enumeration ───────────────────────────────────────────────────
    async def enumerate_channels(self, host: str, creds: Credentials) -> list[Channel]:
        """Group ONVIF profiles by VideoSource → one channel each, main/sub by width.
        Ported from gvd_nvr ``enumerate_channels`` (VideoSource grouping + generic-name
        cleanup + main/sub-by-resolution). Never raises."""
        if not _HAS_ONVIF:
            log.warning("enumerate_channels: python-onvif-zeep not installed")
            return []

        # Fast TCP gate: skip the ~75s blocking SDK call when the host is down.
        if not await _tcp_reachable(host, creds.port):
            log.info("enumerate_channels: %s:%s unreachable (TCP) — []", host, creds.port)
            return []

        username, password = creds.username, creds.password

        def _enumerate() -> list[Channel]:
            try:
                cam = ONVIFCamera(host, creds.port, username, password)
                media = cam.create_media_service()
                profiles = media.GetProfiles()
            except Exception as exc:  # noqa: BLE001
                log.warning("enumerate_channels: GetProfiles failed for %s: %s", host, exc)
                return []
            if not profiles:
                return []

            def _source_key(profile: Any) -> str:
                try:
                    vsc = getattr(profile, "VideoSourceConfiguration", None)
                    if vsc and getattr(vsc, "SourceToken", None):
                        return str(vsc.SourceToken)
                except Exception:  # noqa: BLE001
                    pass
                name = str(getattr(profile, "Name", "") or "")
                m = re.search(r"\d+", name)
                if m:
                    return m.group(0)
                return str(getattr(profile, "token", profile))

            groups: dict[str, list] = {}
            for p in profiles:
                groups.setdefault(_source_key(p), []).append(p)

            def _stream_url(profile: Any) -> str | None:
                try:
                    resp = media.GetStreamUri(
                        {
                            "StreamSetup": {"Stream": "RTP-Unicast", "Transport": {"Protocol": "RTSP"}},
                            "ProfileToken": profile.token,
                        }
                    )
                    url = str(getattr(resp, "Uri", "") or "")
                    return _inject_creds(url, username, password) if url else None
                except Exception as exc:  # noqa: BLE001
                    log.debug("enumerate_channels: GetStreamUri failed for %s: %s", getattr(profile, "token", "?"), exc)
                    return None

            def _snapshot_url(profile: Any) -> str | None:
                try:
                    resp = media.GetSnapshotUri({"ProfileToken": profile.token})
                    return str(getattr(resp, "Uri", "") or "") or None
                except Exception:  # noqa: BLE001
                    return None

            def _resolution(profile: Any) -> str | None:
                try:
                    res = profile.VideoEncoderConfiguration.Resolution
                    return f"{res.Width}x{res.Height}"
                except Exception:  # noqa: BLE001
                    return None

            def _width(profile: Any) -> int:
                try:
                    return int(profile.VideoEncoderConfiguration.Resolution.Width)
                except Exception:  # noqa: BLE001
                    return 0

            def _fps(profile: Any) -> int | None:
                try:
                    return int(profile.VideoEncoderConfiguration.RateControl.FrameRateLimit)
                except Exception:  # noqa: BLE001
                    return None

            def _codec(profile: Any) -> str | None:
                try:
                    return str(profile.VideoEncoderConfiguration.Encoding).upper() or None
                except Exception:  # noqa: BLE001
                    return None

            _generic_name_re = re.compile(
                r"^(profile[_\s]?\d+([_\s]?(main|sub|stream))?|MediaProfile.*|Channel.?\d+)$",
                re.IGNORECASE,
            )

            def _display_name(raw_name: str, channel_num: int, source_key: str) -> str:
                stripped = raw_name.strip()
                if not stripped or _generic_name_re.match(stripped) or stripped == source_key:
                    return f"Channel {channel_num}"
                return stripped

            def _stream_info(profile: Any) -> StreamInfo:
                return StreamInfo(
                    profile_token=str(profile.token),
                    stream_url=_stream_url(profile),
                    resolution=_resolution(profile),
                    fps=_fps(profile),
                    codec=_codec(profile),
                )

            def _ptz_capable(profile: Any) -> bool:
                try:
                    return bool(getattr(profile, "PTZConfiguration", None))
                except Exception:  # noqa: BLE001
                    return False

            results: list[Channel] = []
            for ch_idx, (source_key, ch_profiles) in enumerate(groups.items(), start=1):
                # Sort descending by width → first = main, second = sub.
                sorted_profiles = sorted(ch_profiles, key=_width, reverse=True)
                main_profile = sorted_profiles[0]
                sub_profile = sorted_profiles[1] if len(sorted_profiles) > 1 else None

                name_raw = str(getattr(main_profile, "Name", "") or "")
                dname = _display_name(name_raw, ch_idx, source_key)
                ch_hint_m = re.search(r"(\d+)", name_raw)
                ch_hint = int(ch_hint_m.group(1)) if ch_hint_m else None

                results.append(
                    Channel(
                        channel=ch_idx,
                        name=dname,
                        source_token=source_key,
                        channel_number=ch_hint,
                        main=_stream_info(main_profile),
                        sub=_stream_info(sub_profile) if sub_profile else None,
                        snapshot_url=_snapshot_url(main_profile),
                        ptz_capable=_ptz_capable(main_profile),
                        extra={"profile_name_raw": name_raw},
                    )
                )
            return results

        try:
            return await asyncio.to_thread(_enumerate)
        except Exception as exc:  # noqa: BLE001
            log.warning("enumerate_channels: unexpected error for %s: %s", host, exc)
            return []

    # ── stream URIs (Media2/Profile T → Media/Profile S fallback) ─────────────
    async def get_stream_uris(
        self, host: str, creds: Credentials, *, profile: str | None = None
    ) -> StreamUris:
        """Try ONVIF Media2 (Profile T, H.265) first, fall back to Media (Profile S).
        Ported from gvd_nvr ``get_stream_uris_with_media2_fallback`` +
        ``get_stream_uris_media2`` + ``get_stream_uris``. Never raises."""
        if not _HAS_ONVIF:
            return StreamUris()
        # Fast TCP gate: skip the ~75s blocking SDK call when the host is down.
        if not await _tcp_reachable(host, creds.port):
            return StreamUris()
        media2 = await asyncio.to_thread(self._stream_uris_media2, host, creds)
        if media2 and media2.main:
            media2.media_version = 2
            return media2
        result = await asyncio.to_thread(self._stream_uris_media1, host, creds, profile)
        result.media_version = 1
        return result

    def _stream_uris_media1(self, host: str, creds: Credentials, profile: str | None) -> StreamUris:
        """ONVIF Media (Profile S) main/sub URIs. gvd_nvr ``get_stream_uris`` logic."""
        try:
            cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
            media = cam.create_media_service()
            profiles = media.GetProfiles()
            if not profiles:
                return StreamUris()

            # First two distinct-named profiles per channel (gvd_nvr behaviour).
            channel_profiles: list[Any] = []
            seen: set[str] = set()
            for p in profiles:
                ch = str(getattr(p, "Name", "") or "")
                if ch not in seen:
                    seen.add(ch)
                    channel_profiles.append(p)
                if len(channel_profiles) >= 2:
                    break

            uris = StreamUris()
            for i, prof in enumerate(channel_profiles):
                try:
                    resp = media.GetStreamUri(
                        {
                            "StreamSetup": {"Stream": "RTP-Unicast", "Transport": {"Protocol": "RTSP"}},
                            "ProfileToken": prof.token,
                        }
                    )
                    url = _inject_creds(str(resp.Uri), creds.username, creds.password)
                    if i == 0:
                        uris.main = url
                    else:
                        uris.sub = url
                except Exception as exc:  # noqa: BLE001
                    log.warning("get_stream_uris: profile %s failed: %s", i, exc)
            return uris
        except Exception as exc:  # noqa: BLE001
            log.error("get_stream_uris failed for %s: %s", host, exc)
            return StreamUris()

    def _stream_uris_media2(self, host: str, creds: Credentials) -> StreamUris | None:
        """ONVIF Media2 (Profile T). gvd_nvr ``get_stream_uris_media2`` logic.
        Returns None if Media2 unsupported."""
        try:
            cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
            media2_addr = None
            try:
                for svc in cam.devicemgmt.GetServices({"IncludeCapability": False}):
                    ns = str(getattr(svc, "Namespace", ""))
                    if _is_media2_ns(ns):
                        media2_addr = str(svc.XAddr)
                        break
            except Exception:  # noqa: BLE001
                return None
            if not media2_addr:
                return None

            media2 = cam.create_media2_service()
            profiles = media2.GetProfiles({"Type": ["All"]})
            if not profiles:
                return None

            uris = StreamUris()
            for i, prof in enumerate(profiles[:2]):
                try:
                    resp = media2.GetStreamUri(
                        {
                            "StreamSetup": {"Stream": "RTP-Unicast", "Transport": {"Protocol": "RTSP"}},
                            "ProfileToken": prof.token,
                        }
                    )
                    url = str(resp.Uri) if hasattr(resp, "Uri") else str(resp[0].Uri)
                    url = _inject_creds(url, creds.username, creds.password)
                    if i == 0:
                        uris.main = url
                    else:
                        uris.sub = url
                except Exception:  # noqa: BLE001
                    pass
            try:
                enc = profiles[0].VideoEncoderConfiguration
                uris.codec = str(enc.Encoding).upper() if enc else None
            except Exception:  # noqa: BLE001
                pass
            return uris
        except Exception as exc:  # noqa: BLE001
            log.debug("Media2 query failed for %s: %s", host, exc)
            return None

    # ── capability detection ───────────────────────────────────────────────────
    async def get_capabilities(self, host: str, creds: Credentials) -> Capabilities:
        """Query ONVIF GetCapabilities + GetServices (Media2 detect). Ported from
        gvd_nvr ``get_capabilities`` + probe flags. Never raises."""
        if not _HAS_ONVIF:
            return Capabilities()

        # Fast TCP gate: skip the ~75s blocking SDK call when the host is down.
        if not await _tcp_reachable(host, creds.port):
            return Capabilities()

        def _caps() -> Capabilities:
            try:
                cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
                dm = cam.devicemgmt
                caps = dm.GetCapabilities()
                out = Capabilities(raw={})
                out.ptz = bool(getattr(caps, "PTZ", None))
                out.imaging = bool(getattr(caps, "Imaging", None))
                out.events = bool(getattr(caps, "Events", None))
                out.analytics = bool(getattr(caps, "Analytics", None))
                try:
                    svcs = dm.GetServices({"IncludeCapability": False})
                    out.services = [str(getattr(s, "Namespace", "")) for s in svcs]
                    out.media2 = any(_is_media2_ns(ns) for ns in out.services)
                    out.recording_search = any("recording" in ns for ns in out.services)
                except Exception:  # noqa: BLE001
                    pass
                # Audio / IO / backchannel best-effort via media service.
                try:
                    media = cam.create_media_service()
                    profiles = media.GetProfiles() or []
                    out.audio = any(getattr(p, "AudioEncoderConfiguration", None) for p in profiles)
                    out.backchannel = any(getattr(p, "AudioOutputConfiguration", None) for p in profiles)
                except Exception:  # noqa: BLE001
                    pass
                try:
                    out.io = bool(dm.GetRelayOutputs())
                except Exception:  # noqa: BLE001
                    pass
                return out
            except Exception as exc:  # noqa: BLE001
                log.error("get_capabilities failed for %s: %s", host, exc)
                return Capabilities()

        return await asyncio.to_thread(_caps)

    # ── snapshot (GetSnapshotUri → HTTP → RTSP-ffmpeg fallback) ────────────────
    async def get_snapshot(
        self, host: str, creds: Credentials, *, profile: str | None = None
    ) -> bytes | None:
        """Fetch a JPEG: ONVIF GetSnapshotUri + (anon|basic|digest) HTTP, then RTSP
        single-frame via ffmpeg. Ported from gvd_nvr ``fetch_snapshot``. Never raises."""
        import httpx

        # Fast TCP gate: skip the blocking SDK snapshot-URI call when the host is down.
        if not await _tcp_reachable(host, creds.port):
            return None

        uri = await asyncio.to_thread(self._snapshot_uri, host, creds, profile)
        if uri:
            try:
                async with httpx.AsyncClient(timeout=4.0, verify=False) as client:
                    for auth in (None, (creds.username, creds.password), httpx.DigestAuth(creds.username, creds.password)):
                        try:
                            r = await client.get(uri, auth=auth)
                        except Exception:  # noqa: BLE001
                            continue
                        if r.status_code == 200 and r.content and r.content.startswith(b"\xff\xd8"):
                            return r.content
            except Exception as exc:  # noqa: BLE001
                log.debug("HTTP snapshot fetch failed for %s: %s", host, exc)

        try:
            uris = await self.get_stream_uris(host, creds, profile=profile)
            if uris.main:
                jpeg = await _rtsp_grab_jpeg(uris.main, timeout=4.0)
                if jpeg:
                    return jpeg
        except Exception as exc:  # noqa: BLE001
            log.debug("RTSP snapshot fallback failed for %s: %s", host, exc)
        return None

    def _snapshot_uri(self, host: str, creds: Credentials, profile: str | None) -> str | None:
        """ONVIF GetSnapshotUri for the given (or first) profile. gvd_nvr ``get_snapshot_uri``."""
        try:
            cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
            media = cam.create_media_service()
            token = profile
            if not token:
                profiles = media.GetProfiles()
                if not profiles:
                    return None
                token = profiles[0].token
            resp = media.GetSnapshotUri({"ProfileToken": token})
            return getattr(resp, "Uri", None)
        except Exception as exc:  # noqa: BLE001
            log.warning("ONVIF snapshot URI query failed for %s: %s", host, exc)
            return None

    # ── PTZ (gvd_nvr cameras/onvif/ptz.py, ported) ────────────────────────────
    async def ptz(self, host: str, creds: Credentials, cmd: PtzCommand) -> Any:
        """Dispatch a PTZ command. Raises ``DriverError`` on failure (operator action).
        Ported from gvd_nvr PTZ module (continuous/relative/absolute/stop/presets)."""
        if not _HAS_ONVIF:
            raise DriverError("python-onvif-zeep not installed — PTZ unavailable")

        def _run() -> Any:
            try:
                cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
                media = cam.create_media_service()
                ptz = cam.create_ptz_service()
                token = cmd.profile_token or media.GetProfiles()[0].token

                if cmd.action == "continuous":
                    req = ptz.create_type("ContinuousMove")
                    req.ProfileToken = token
                    req.Velocity = {
                        "PanTilt": {"x": cmd.pan * cmd.speed, "y": cmd.tilt * cmd.speed},
                        "Zoom": {"x": cmd.zoom * cmd.speed},
                    }
                    ptz.ContinuousMove(req)
                    return None
                if cmd.action == "relative":
                    req = ptz.create_type("RelativeMove")
                    req.ProfileToken = token
                    req.Translation = {"PanTilt": {"x": cmd.pan, "y": cmd.tilt}, "Zoom": {"x": cmd.zoom}}
                    ptz.RelativeMove(req)
                    return None
                if cmd.action == "absolute":
                    req = ptz.create_type("AbsoluteMove")
                    req.ProfileToken = token
                    req.Position = {"PanTilt": {"x": cmd.pan, "y": cmd.tilt}, "Zoom": {"x": cmd.zoom}}
                    ptz.AbsoluteMove(req)
                    return None
                if cmd.action == "zoom":
                    # Zoom-only continuous move (pan/tilt velocity held at 0).
                    req = ptz.create_type("ContinuousMove")
                    req.ProfileToken = token
                    req.Velocity = {"Zoom": {"x": cmd.zoom * cmd.speed}}
                    ptz.ContinuousMove(req)
                    return None
                if cmd.action == "focus":
                    # Focus is an Imaging-service continuous move (not PTZ). ``zoom`` field
                    # carries the focus velocity (-1..1); requires the ImagingService.
                    imaging = cam.create_imaging_service()
                    media_svc = cam.create_media_service()
                    vs_token = media_svc.GetVideoSources()[0].token
                    move = imaging.create_type("Move")
                    move.VideoSourceToken = vs_token
                    move.Focus = {"Continuous": {"Speed": cmd.zoom}}
                    imaging.Move(move)
                    return None
                if cmd.action == "stop":
                    ptz.Stop({"ProfileToken": token, "PanTilt": True, "Zoom": True})
                    return None
                if cmd.action == "get_presets":
                    presets = ptz.GetPresets({"ProfileToken": token})
                    return [{"token": str(p.token), "name": str(p.Name)} for p in presets]
                if cmd.action == "goto_preset":
                    ptz.GotoPreset({"ProfileToken": token, "PresetToken": cmd.preset_token})
                    return None
                if cmd.action == "set_preset":
                    result = ptz.SetPreset({"ProfileToken": token, "PresetName": cmd.preset_name})
                    tok = getattr(result, "PresetToken", None) or getattr(result, "token", None)
                    return str(tok) if tok else None
                if cmd.action == "delete_preset":
                    ptz.RemovePreset({"ProfileToken": token, "PresetToken": cmd.preset_token})
                    return None
                if cmd.action == "get_status":
                    st = ptz.GetStatus({"ProfileToken": token})
                    pos = getattr(st, "Position", None)
                    pt = getattr(pos, "PanTilt", None) if pos is not None else None
                    zm = getattr(pos, "Zoom", None) if pos is not None else None
                    mv = getattr(st, "MoveStatus", None)
                    return {
                        "pan": getattr(pt, "x", None) if pt is not None else None,
                        "tilt": getattr(pt, "y", None) if pt is not None else None,
                        "zoom": getattr(zm, "x", None) if zm is not None else None,
                        "moving": str(getattr(mv, "PanTilt", "") or getattr(mv, "Zoom", "") or "IDLE"),
                    }
                raise DriverError(f"unknown PTZ action: {cmd.action}")
            except DriverError:
                raise
            except Exception as exc:  # noqa: BLE001
                raise DriverError(f"PTZ {cmd.action} failed for {host}: {exc}") from None

        return await asyncio.to_thread(_run)

    # ── configuration (imaging / io / ntp / …) ────────────────────────────────
    async def configure(
        self,
        host: str,
        creds: Credentials,
        section: str,
        payload: dict[str, Any],
        *,
        channel: int | None = None,
    ) -> dict[str, Any]:
        """Read (empty payload) or write an ONVIF config ``section``. Ported from
        gvd_nvr imaging + I/O + system-time services. Raises ``DriverError`` on
        write failure / unsupported section.

        Sections:
          * ``imaging`` — GetImagingSettings (read) / SetImagingSettings (write patch).
          * ``io``      — GetRelayOutputs + GetDigitalInputs (read) / SetRelayOutputState (write).
          * ``ntp``     — GetSystemDateAndTime (read) / SetSystemDateAndTime sync (write).
          * ``privacy_masks`` — Media2 SetMask/CreateMask (Profile T). Normalized (0..1)
            rect/polygon shapes → ONVIF ``Polygon`` points. Store-only fallback when the
            device lacks Media2 masking (raises DriverError → service records ``pushed=False``).
          * ``motion_zones`` — SetVideoAnalyticsConfiguration ``MotionRegionDetector`` /
            ``CellMotionDetector`` region. Same normalized shape. Store-only fallback when
            the device lacks a motion analytics config.
        """
        if not _HAS_ONVIF:
            raise DriverError("python-onvif-zeep not installed — configure unavailable")

        write = bool(payload)

        def _run() -> dict[str, Any]:
            cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
            if section == "imaging":
                return self._configure_imaging(cam, payload, write, channel=channel)
            if section == "io":
                return self._configure_io(cam, payload, write)
            if section == "encoder":
                return self._configure_encoder(cam, payload, write, channel=channel)
            if section == "osd":
                return self._configure_osd(cam, payload, write, channel=channel)
            if section == "ntp":
                return self._configure_ntp(cam, payload, write)
            if section == "privacy_masks":
                return self._configure_privacy_masks(cam, payload)
            if section == "motion_zones":
                return self._configure_motion_zones(cam, payload)
            raise DriverError(f"unsupported ONVIF config section: {section}")

        try:
            return await asyncio.to_thread(_run)
        except DriverError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise DriverError(f"configure({section}) failed for {host}: {exc}") from None

    def _imaging_vs_token(self, media: Any, channel: int | None) -> str:
        """Resolve the ONVIF VideoSourceToken for a specific NVR channel.

        A multi-channel NVR exposes one VideoSource per channel (``VideoSourceToken_0``,
        ``_1``, …). Imaging is per-source, so we must target the channel's own source —
        matching the same numeric index the recording/stream tokens use
        (== ``Camera.nvr_channel_number``) — not blindly the first source. Falls back to
        positional index, then the first source (a standalone camera).
        """
        sources = media.GetVideoSources() or []
        if not sources:
            raise DriverError("device exposes no video sources")
        if channel is not None:
            want = f"VideoSourceToken_{channel}"
            for vs in sources:
                if str(vs.token) == want:
                    return vs.token
            if 0 <= channel < len(sources):
                return sources[channel].token
        return sources[0].token

    def _configure_imaging(
        self, cam: Any, payload: dict[str, Any], write: bool, *, channel: int | None = None
    ) -> dict[str, Any]:
        media = cam.create_media_service()
        vs_token = self._imaging_vs_token(media, channel)
        imaging = cam.create_imaging_service()
        current = imaging.GetImagingSettings({"VideoSourceToken": vs_token})
        if write:
            for key, attr, cast in (
                ("brightness", "Brightness", float),
                ("contrast", "Contrast", float),
                ("color_saturation", "ColorSaturation", float),
                ("sharpness", "Sharpness", float),
                ("ir_cut_filter", "IrCutFilter", str),
            ):
                if payload.get(key) is not None and hasattr(current, attr):
                    setattr(current, attr, cast(payload[key]))
            if "wide_dynamic_range" in payload and getattr(current, "WideDynamicRange", None):
                wdr = payload["wide_dynamic_range"] or {}
                current.WideDynamicRange.Mode = wdr.get("mode", "OFF")
                if wdr.get("level") is not None:
                    current.WideDynamicRange.Level = float(wdr["level"])
            imaging.SetImagingSettings(
                {"VideoSourceToken": vs_token, "ImagingSettings": current, "ForcePersistence": True}
            )
            current = imaging.GetImagingSettings({"VideoSourceToken": vs_token})

        wdr_obj = getattr(current, "WideDynamicRange", None)
        out: dict[str, Any] = {
            "video_source_token": vs_token,
            "brightness": getattr(current, "Brightness", None),
            "contrast": getattr(current, "Contrast", None),
            "color_saturation": getattr(current, "ColorSaturation", None),
            "sharpness": getattr(current, "Sharpness", None),
            "ir_cut_filter": str(getattr(current, "IrCutFilter", "")) or None,
            "wide_dynamic_range": {
                "mode": str(getattr(wdr_obj, "Mode", "")) or None,
                "level": getattr(wdr_obj, "Level", None),
            }
            if wdr_obj is not None
            else None,
            "supported": {
                "brightness": hasattr(current, "Brightness"),
                "contrast": hasattr(current, "Contrast"),
                "color_saturation": hasattr(current, "ColorSaturation"),
                "sharpness": hasattr(current, "Sharpness"),
                "wide_dynamic_range": wdr_obj is not None,
                "ir_cut_filter": hasattr(current, "IrCutFilter"),
            },
        }
        # Slider ranges (min/max) from GetOptions — best-effort so the UI can bound the
        # inputs; a device that doesn't advertise options just gets no ranges.
        try:
            opts = imaging.GetOptions({"VideoSourceToken": vs_token})

            def _rng(node):
                if node is None:
                    return None
                mn, mx = getattr(node, "Min", None), getattr(node, "Max", None)
                return {"min": mn, "max": mx} if mn is not None and mx is not None else None

            out["ranges"] = {
                "brightness": _rng(getattr(opts, "Brightness", None)),
                "contrast": _rng(getattr(opts, "Contrast", None)),
                "color_saturation": _rng(getattr(opts, "ColorSaturation", None)),
                "sharpness": _rng(getattr(opts, "Sharpness", None)),
            }
            wdr_opts = getattr(opts, "WideDynamicRange", None)
            if wdr_opts is not None:
                out["ranges"]["wide_dynamic_range_modes"] = [str(m) for m in (getattr(wdr_opts, "Mode", None) or [])]
            ircut = getattr(opts, "IrCutFilterModes", None)
            if ircut:
                out["ranges"]["ir_cut_filter_modes"] = [str(m) for m in ircut]
        except Exception as exc:  # noqa: BLE001 — options are optional
            log.debug("GetOptions failed for %s: %s", vs_token, exc)
            out["ranges"] = {}
        return out

    def _configure_io(self, cam: Any, payload: dict[str, Any], write: bool) -> dict[str, Any]:
        dm = cam.devicemgmt
        # A relay toggle IS an explicit operator action — surface its failure. But the
        # READ side (enumerate) must stay graceful: many cameras/NVRs simply expose no
        # relay/digital-I/O ONVIF service and fault on GetRelayOutputs ("get system config
        # failed") — that's "no I/O", not an error. So each read is best-effort → empty.
        if write:
            dm.SetRelayOutputState(
                {
                    "RelayOutputToken": payload.get("relay_token", "RelayOut1"),
                    "LogicalState": payload.get("state", "active"),
                }
            )
        outputs = []
        try:
            for out in dm.GetRelayOutputs() or []:
                outputs.append(
                    {
                        "token": str(out.token),
                        "mode": str(getattr(out.Properties, "Mode", "")),
                        "idle_state": str(getattr(out.Properties, "IdleState", "")),
                    }
                )
        except Exception as exc:  # noqa: BLE001 — device exposes no relay outputs
            log.debug("GetRelayOutputs unsupported on this device: %s", exc)
        inputs = []
        try:
            for inp in dm.GetDigitalInputs() or []:
                inputs.append({"token": str(inp.token), "idle_state": str(getattr(inp, "IdleState", ""))})
        except Exception:  # noqa: BLE001
            pass
        return {"relay_outputs": outputs, "digital_inputs": inputs}

    # ── video encoder (resolution / fps / bitrate / GOP) ──────────────────────
    def _profile_for_role(self, service: Any, is_media2: bool, role: str) -> Any | None:
        """Pick the profile for a role (main=highest-res, sub=next, third=…)."""
        profiles = self._list_profiles(service, is_media2)
        if not profiles:
            return None

        def _width(p: Any) -> int:
            try:
                return int(self._enc_of(p).Resolution.Width)
            except Exception:  # noqa: BLE001
                return 0

        ordered = sorted(profiles, key=_width, reverse=True)
        idx = {"main": 0, "sub": 1, "third": 2}.get(role, 0)
        return ordered[min(idx, len(ordered) - 1)]

    def _configure_encoder(
        self, cam: Any, payload: dict[str, Any], write: bool, *, channel: int | None = None
    ) -> dict[str, Any]:
        """Read/write the VideoEncoderConfiguration (resolution/fps/bitrate/GOP/codec) of
        the ``main`` (default) or ``sub`` stream. ONVIF SetVideoEncoderConfiguration —
        many NVR channels reject writes; that surfaces as a DriverError (graceful)."""
        media2 = self._media2_service(cam)
        service = media2 or self._media1_service(cam)
        if service is None:
            raise DriverError("device has no ONVIF media service")
        is_media2 = media2 is not None
        role = (payload.get("role") if payload else None) or "main"
        prof = self._profile_for_role(service, is_media2, role)
        if prof is None:
            raise DriverError("device exposes no media profiles")
        enc = self._enc_of(prof)
        if enc is None:
            raise DriverError("profile has no VideoEncoderConfiguration")

        if write:
            res = payload.get("resolution")
            if res and "x" in str(res) and getattr(enc, "Resolution", None) is not None:
                w, h = str(res).lower().split("x")
                enc.Resolution.Width, enc.Resolution.Height = int(w), int(h)
            rc = getattr(enc, "RateControl", None)
            if rc is not None:
                if payload.get("fps") is not None:
                    rc.FrameRateLimit = int(payload["fps"])
                if payload.get("bitrate") is not None:
                    rc.BitrateLimit = int(payload["bitrate"])
            if payload.get("gov_length") is not None:
                h264 = getattr(enc, "H264", None)
                if h264 is not None:
                    h264.GovLength = int(payload["gov_length"])
                elif hasattr(enc, "GovLength"):
                    enc.GovLength = int(payload["gov_length"])
            if is_media2:
                service.SetVideoEncoderConfiguration({"Configuration": enc})
            else:
                service.SetVideoEncoderConfiguration({"Configuration": enc, "ForcePersistence": True})
            prof = self._profile_for_role(service, is_media2, role)
            enc = self._enc_of(prof)

        res_obj = getattr(enc, "Resolution", None)
        rc = getattr(enc, "RateControl", None)
        h264 = getattr(enc, "H264", None)
        out: dict[str, Any] = {
            "role": role,
            "codec": self._norm_codec(getattr(enc, "Encoding", None)),
            "resolution": (
                f"{int(res_obj.Width)}x{int(res_obj.Height)}" if res_obj is not None else None
            ),
            "fps": int(getattr(rc, "FrameRateLimit", 0)) or None if rc is not None else None,
            "bitrate": int(getattr(rc, "BitrateLimit", 0)) or None if rc is not None else None,
            "gov_length": int(getattr(h264, "GovLength", 0)) or None
            if h264 is not None
            else (int(getattr(enc, "GovLength", 0)) or None),
        }
        # Options (allowed resolutions + fps/bitrate ranges) — best-effort.
        try:
            tok = getattr(enc, "token", None) or getattr(enc, "_token", None)
            opts = service.GetVideoEncoderConfigurationOptions(
                {"ConfigurationToken": tok, "ProfileToken": getattr(prof, "token", None)}
                if is_media2
                else {"ConfigurationToken": tok}
            )
            resolutions: list[str] = []
            node = getattr(opts, "H264", None) or getattr(opts, "JPEG", None) or opts
            for r in getattr(node, "ResolutionsAvailable", None) or []:
                resolutions.append(f"{int(r.Width)}x{int(r.Height)}")
            frng = getattr(node, "FrameRateRange", None)
            out["options"] = {
                "resolutions": resolutions,
                "fps": {"min": getattr(frng, "Min", None), "max": getattr(frng, "Max", None)}
                if frng is not None
                else None,
            }
        except Exception as exc:  # noqa: BLE001 — options optional
            log.debug("GetVideoEncoderConfigurationOptions failed: %s", exc)
            out["options"] = {}
        return out

    # ── OSD / text overlay (camera name + timestamp) ──────────────────────────
    def _configure_osd(
        self, cam: Any, payload: dict[str, Any], write: bool, *, channel: int | None = None
    ) -> dict[str, Any]:
        """Read/write OSD text + timestamp overlays via Media2 (Profile T). Read returns
        the current OSD items; write updates the first text/datetime OSD. Graceful — a
        device without Media2 OSD support raises DriverError → service records unsupported."""
        media2 = self._media2_service(cam)
        if media2 is None:
            raise DriverError("device has no ONVIF Media2 (OSD) service")
        prof = self._profile_for_role(media2, True, (payload.get("role") if payload else None) or "main")
        vs_token = None
        if prof is not None:
            cfgs = getattr(prof, "Configurations", None)
            vsc = getattr(cfgs, "VideoSource", None) if cfgs is not None else None
            if isinstance(vsc, list):
                vsc = vsc[0] if vsc else None
            vs_token = getattr(vsc, "token", None) if vsc is not None else None

        osds = list(media2.GetOSDs({}) or [])

        def _text_of(o: Any) -> str | None:
            tt = getattr(getattr(o, "TextString", None), "PlainText", None)
            return str(tt) if tt else None

        def _type_of(o: Any) -> str:
            return str(getattr(getattr(o, "TextString", None), "Type", "") or "")

        if write:
            want_text = payload.get("text")
            want_dt = payload.get("show_datetime")
            for o in osds:
                ts = getattr(o, "TextString", None)
                if ts is None:
                    continue
                typ = _type_of(o)
                if want_text is not None and typ in ("Plain", ""):
                    ts.PlainText = str(want_text)
                    ts.Type = "Plain"
                    media2.SetOSD({"OSD": o})
                if want_dt is not None and typ in ("DateAndTime", "Date", "Time"):
                    ts.Type = "DateAndTime" if want_dt else "Plain"
                    if not want_dt:
                        ts.PlainText = getattr(ts, "PlainText", "") or ""
                    media2.SetOSD({"OSD": o})
            osds = list(media2.GetOSDs({}) or [])

        items = []
        for o in osds:
            items.append(
                {
                    "token": str(getattr(o, "token", "")),
                    "type": _type_of(o),
                    "text": _text_of(o),
                }
            )
        return {"video_source_token": vs_token, "osds": items, "supported": True}

    def _configure_ntp(self, cam: Any, payload: dict[str, Any], write: bool) -> dict[str, Any]:
        from datetime import datetime

        dm = cam.devicemgmt
        if write:
            now = datetime.utcnow()
            req = dm.create_type("SetSystemDateAndTime")
            req.DateTimeType = "Manual"
            req.DaylightSavings = False
            req.UTCDateTime = {
                "Date": {"Year": now.year, "Month": now.month, "Day": now.day},
                "Time": {"Hour": now.hour, "Minute": now.minute, "Second": now.second},
            }
            dm.SetSystemDateAndTime(req)
        dt = dm.GetSystemDateAndTime()
        return {
            "timezone": str(dt.TimeZone.TZ) if getattr(dt, "TimeZone", None) else None,
            "ntp_enabled": getattr(dt, "NTP", None),
            "datetime_type": str(getattr(dt, "DateTimeType", "")),
        }

    @staticmethod
    def _norm_shapes(payload: dict[str, Any], key: str) -> list[dict[str, Any]]:
        """Extract the normalized (0..1) shape list from a ``{key: [...]}`` payload."""
        shapes = payload.get(key)
        if shapes is None and isinstance(payload, list):  # tolerate a bare list
            shapes = payload
        return list(shapes or [])

    @staticmethod
    def _shape_to_polygon(shape: dict[str, Any]) -> list[tuple[float, float]]:
        """Convert one normalized shape → ONVIF polygon points ([-1..1] space).

        Accepts a rect ``{x,y,w,h}`` or a polygon ``{points:[[x,y],...]}`` in the
        top-left-origin 0..1 image space and maps to the ONVIF analytics/geometry
        coordinate frame (x∈[-1,1], y∈[-1,1], origin centre, y up).
        """
        def _map(px: float, py: float) -> tuple[float, float]:
            return (2.0 * float(px) - 1.0, 1.0 - 2.0 * float(py))

        pts = shape.get("points")
        if pts:
            return [_map(p[0], p[1]) for p in pts]
        x, y = float(shape.get("x", 0.0)), float(shape.get("y", 0.0))
        w, h = float(shape.get("w", 0.0)), float(shape.get("h", 0.0))
        return [_map(x, y), _map(x + w, y), _map(x + w, y + h), _map(x, y + h)]

    def _configure_privacy_masks(self, cam: Any, payload: dict[str, Any]) -> dict[str, Any]:
        """Push privacy masks via ONVIF Media2 masking (Profile T).

        Best-effort: replaces existing masks with the supplied normalized shapes. Raises
        ``DriverError`` when the device has no Media2 masking surface — the service then
        records the save as store-only (``pushed=False``). Read (empty payload) returns
        the current device masks where available.

        # LIVE-VALIDATE: Media2 GetMasks/CreateMask/DeleteMask availability + the exact
        # Mask/PolygonConfiguration shape vary by vendor — confirm on a Profile-T device.
        """
        shapes = self._norm_shapes(payload, "privacy_masks")
        try:
            media2 = cam.create_media2_service()
        except Exception as exc:  # noqa: BLE001 — no Media2 → store-only
            raise DriverError(f"device has no Media2 masking surface: {exc}") from None
        try:
            vs_token = cam.create_media_service().GetVideoSources()[0].token
        except Exception as exc:  # noqa: BLE001
            raise DriverError(f"could not resolve video source token: {exc}") from None

        applied = False
        try:
            # Clear existing masks for this source, then create one per shape.
            existing = []
            try:
                existing = media2.GetMasks({"ConfigurationToken": vs_token}) or []
            except Exception:  # noqa: BLE001 — GetMasks optional
                existing = []
            for m in existing:
                try:
                    media2.DeleteMask({"Token": m.token})
                except Exception:  # noqa: BLE001
                    pass
            for shape in shapes:
                poly = self._shape_to_polygon(shape)
                req = {
                    "Mask": {
                        "ConfigurationToken": vs_token,
                        "Polygon": {"Point": [{"x": px, "y": py} for px, py in poly]},
                        "Type": "Color",
                        "Enabled": True,
                    }
                }
                media2.CreateMask(req)
                applied = True
        except Exception as exc:  # noqa: BLE001
            raise DriverError(f"privacy-mask write failed: {exc}") from None
        return {"applied": applied or not shapes, "count": len(shapes), "video_source_token": str(vs_token)}

    def _configure_motion_zones(self, cam: Any, payload: dict[str, Any]) -> dict[str, Any]:
        """Push motion-detection regions via ONVIF VideoAnalytics (Motion/CellMotion).

        Best-effort: locates the VideoAnalyticsConfiguration's motion detector and
        rewrites its region polygon from the supplied normalized shapes. Raises
        ``DriverError`` when the device exposes no analytics/motion config — the service
        records the save as store-only (``pushed=False``).

        # LIVE-VALIDATE: the analytics module name (``tt:MotionRegionDetector`` vs
        # ``tt:CellMotionDetector``) + the ``SetVideoAnalyticsConfiguration`` region
        # SimpleItem/ElementItem shape are vendor-specific — confirm on a real device.
        """
        shapes = self._norm_shapes(payload, "motion_zones")
        try:
            analytics = cam.create_analytics_service()
        except Exception as exc:  # noqa: BLE001 — no analytics → store-only
            raise DriverError(f"device has no VideoAnalytics surface: {exc}") from None
        try:
            configs = analytics.GetVideoAnalyticsConfigurations() or []
        except Exception as exc:  # noqa: BLE001
            raise DriverError(f"could not read analytics configurations: {exc}") from None
        if not configs:
            raise DriverError("device exposes no VideoAnalytics configuration")

        cfg = configs[0]
        try:
            # Rewrite the motion detector's region polygon(s). Vendors differ on whether
            # the region rides in the AnalyticsEngineConfiguration or RuleEngine; we set
            # the polygon on the first motion-detector module we find.
            polygons = [
                {"Point": [{"x": px, "y": py} for px, py in self._shape_to_polygon(s)]}
                for s in shapes
            ]
            modules = getattr(getattr(cfg, "AnalyticsEngineConfiguration", None), "AnalyticsModule", []) or []
            touched = False
            for mod in modules:
                if "Motion" in str(getattr(mod, "Type", "")):
                    for param in getattr(getattr(mod, "Parameters", None), "ElementItem", []) or []:
                        if str(getattr(param, "Name", "")) in ("Region", "Field"):
                            param.Value = {"PolygonConfiguration": polygons}
                            touched = True
            analytics.SetVideoAnalyticsConfiguration(
                {"Configuration": cfg, "ForcePersistence": True}
            )
            applied = touched
        except Exception as exc:  # noqa: BLE001
            raise DriverError(f"motion-zone write failed: {exc}") from None
        return {"applied": applied or not shapes, "count": len(shapes), "config_token": str(getattr(cfg, "token", ""))}

    # ── device / fleet management (G7) — ONVIF Device Management service ───────
    #
    # These build faithful ONVIF SOAP calls via the onvif-zeep Device service. The blocking
    # SDK work runs under ``asyncio.to_thread`` (same discipline as ``configure``), gated on
    # a fast TCP pre-check + ``_HAS_ONVIF``. Graceful: unreachable / no-SDK / unsupported →
    # ``FleetOpResult(ok=False, supported=...)`` — never raises. # LIVE-VALIDATE: on-device
    # effect (reboot/restore reboot the camera; SetUser policies vary by vendor).

    async def reboot(self, host: str, creds: Credentials) -> FleetOpResult:
        """ONVIF ``SystemReboot`` (Device service). Returns the device's reboot message."""
        if not _HAS_ONVIF:
            return FleetOpResult(ok=False, supported=False, detail="python-onvif-zeep not installed")
        if not await _tcp_reachable(host, creds.port):
            return FleetOpResult(ok=False, detail="device unreachable")

        def _run() -> str:
            cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
            return str(cam.devicemgmt.SystemReboot() or "reboot requested")

        try:
            msg = await asyncio.to_thread(_run)
            return FleetOpResult(ok=True, detail=msg)
        except Exception as exc:  # noqa: BLE001 — graceful
            return FleetOpResult(ok=False, detail=f"reboot failed: {exc}")

    async def set_ntp(self, host: str, creds: Credentials, server: str) -> FleetOpResult:
        """ONVIF ``SetNTP`` — set the device's NTP server (Manual, IPv4/DNS)."""
        if not _HAS_ONVIF:
            return FleetOpResult(ok=False, supported=False, detail="python-onvif-zeep not installed")
        if not await _tcp_reachable(host, creds.port):
            return FleetOpResult(ok=False, detail="device unreachable")

        import ipaddress as _ip

        def _run() -> None:
            cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
            dm = cam.devicemgmt
            # DNS name vs IPv4 → the right NTPInformation shape.
            try:
                _ip.ip_address(server)
                addr = {"Type": "IPv4", "IPv4Address": server}
            except ValueError:
                addr = {"Type": "DNS", "DNSname": server}
            req = dm.create_type("SetNTP")
            req.FromDHCP = False
            req.NTPManual = [addr]
            dm.SetNTP(req)

        try:
            await asyncio.to_thread(_run)
            return FleetOpResult(ok=True, detail=f"ntp set to {server}", data={"server": server})
        except Exception as exc:  # noqa: BLE001
            return FleetOpResult(ok=False, detail=f"set_ntp failed: {exc}")

    async def set_password(
        self, host: str, creds: Credentials, *, user: str, new_password: str
    ) -> FleetOpResult:
        """ONVIF ``SetUser`` — change the password of an existing device account ``user``.

        Resolves the user's UserLevel from ``GetUsers`` (SetUser requires it); leaves the
        level unchanged. # LIVE-VALIDATE: some devices need CreateUsers vs SetUser, and
        password policy varies."""
        if not _HAS_ONVIF:
            return FleetOpResult(ok=False, supported=False, detail="python-onvif-zeep not installed")
        if not await _tcp_reachable(host, creds.port):
            return FleetOpResult(ok=False, detail="device unreachable")

        def _run() -> None:
            cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
            dm = cam.devicemgmt
            level = "Administrator"
            for u in dm.GetUsers() or []:
                if str(getattr(u, "Username", "")) == user:
                    level = str(getattr(u, "UserLevel", level)) or level
                    break
            dm.SetUser({"User": [{"Username": user, "Password": new_password, "UserLevel": level}]})

        try:
            await asyncio.to_thread(_run)
            return FleetOpResult(ok=True, detail=f"password changed for {user}", data={"user": user})
        except Exception as exc:  # noqa: BLE001
            return FleetOpResult(ok=False, detail=f"set_password failed: {exc}")

    # ── ONVIF user management (GetUsers / CreateUsers / DeleteUsers) ──────────
    async def list_users(self, host: str, creds: Credentials) -> FleetOpResult:
        """ONVIF ``GetUsers`` — the device's account list (username + level)."""
        if not _HAS_ONVIF:
            return FleetOpResult(ok=False, supported=False, detail="python-onvif-zeep not installed")
        if not await _tcp_reachable(host, creds.port):
            return FleetOpResult(ok=False, detail="device unreachable")

        def _run() -> list[dict[str, str]]:
            cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
            out = []
            for u in cam.devicemgmt.GetUsers() or []:
                out.append(
                    {
                        "username": str(getattr(u, "Username", "")),
                        "level": str(getattr(u, "UserLevel", "") or ""),
                    }
                )
            return out

        try:
            users = await asyncio.to_thread(_run)
            return FleetOpResult(ok=True, detail=f"{len(users)} user(s)", data={"users": users})
        except Exception as exc:  # noqa: BLE001
            return FleetOpResult(ok=False, supported=False, detail=f"GetUsers failed: {exc}")

    async def add_user(
        self, host: str, creds: Credentials, *, user: str, password: str, level: str = "User"
    ) -> FleetOpResult:
        """ONVIF ``CreateUsers`` — add a device account at ``level``
        (Administrator|Operator|User|Anonymous)."""
        if not _HAS_ONVIF:
            return FleetOpResult(ok=False, supported=False, detail="python-onvif-zeep not installed")
        if not await _tcp_reachable(host, creds.port):
            return FleetOpResult(ok=False, detail="device unreachable")

        def _run() -> None:
            cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
            cam.devicemgmt.CreateUsers(
                {"User": [{"Username": user, "Password": password, "UserLevel": level}]}
            )

        try:
            await asyncio.to_thread(_run)
            return FleetOpResult(ok=True, detail=f"user {user} created", data={"user": user})
        except Exception as exc:  # noqa: BLE001
            return FleetOpResult(ok=False, supported=True, detail=f"CreateUsers failed: {exc}")

    async def delete_user(self, host: str, creds: Credentials, *, user: str) -> FleetOpResult:
        """ONVIF ``DeleteUsers`` — remove a device account by username."""
        if not _HAS_ONVIF:
            return FleetOpResult(ok=False, supported=False, detail="python-onvif-zeep not installed")
        if not await _tcp_reachable(host, creds.port):
            return FleetOpResult(ok=False, detail="device unreachable")

        def _run() -> None:
            cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
            cam.devicemgmt.DeleteUsers({"Username": [user]})

        try:
            await asyncio.to_thread(_run)
            return FleetOpResult(ok=True, detail=f"user {user} deleted", data={"user": user})
        except Exception as exc:  # noqa: BLE001
            return FleetOpResult(ok=False, supported=True, detail=f"DeleteUsers failed: {exc}")

    async def backup_config(self, host: str, creds: Credentials) -> ConfigBackup:
        """ONVIF ``GetSystemBackup`` — returns the device's backup files (concatenated).

        ONVIF returns a list of ``BackupFile`` attachments; this concatenates their data
        into one blob. # LIVE-VALIDATE: not all devices implement GetSystemBackup."""
        if not _HAS_ONVIF:
            return ConfigBackup(supported=False, detail="python-onvif-zeep not installed")
        if not await _tcp_reachable(host, creds.port):
            return ConfigBackup(supported=False, detail="device unreachable")

        def _run() -> bytes:
            cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
            files = cam.devicemgmt.GetSystemBackup() or []
            chunks: list[bytes] = []
            for f in files:
                data = getattr(f, "Data", None)
                if data is not None:
                    chunks.append(data if isinstance(data, bytes) else str(data).encode())
            return b"".join(chunks)

        try:
            blob = await asyncio.to_thread(_run)
            if not blob:
                return ConfigBackup(supported=False, detail="device returned no backup files")
            return ConfigBackup(
                supported=True, blob=blob, filename=f"onvif-{host}-backup.bin", detail="config exported"
            )
        except Exception as exc:  # noqa: BLE001
            return ConfigBackup(supported=False, detail=f"backup failed: {exc}")

    async def restore_config(self, host: str, creds: Credentials, blob: bytes) -> FleetOpResult:
        """ONVIF ``RestoreSystem`` — restore a previously-exported backup blob.
        # LIVE-VALIDATE: RestoreSystem reboots the device; the BackupFile name/shape varies."""
        if not _HAS_ONVIF:
            return FleetOpResult(ok=False, supported=False, detail="python-onvif-zeep not installed")
        if not await _tcp_reachable(host, creds.port):
            return FleetOpResult(ok=False, detail="device unreachable")

        def _run() -> None:
            cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
            cam.devicemgmt.RestoreSystem({"BackupFiles": [{"Name": "config.bin", "Data": blob}]})

        try:
            await asyncio.to_thread(_run)
            return FleetOpResult(ok=True, detail="config restore requested (device will reboot)")
        except Exception as exc:  # noqa: BLE001
            return FleetOpResult(ok=False, detail=f"restore_config failed: {exc}")

    # ── stream codec policy (G8) — ONVIF Set/GetVideoEncoderConfiguration ──────
    #
    # Force the SUB profile's video encoder to H.264 so browsers play live with zero
    # transcode (main stays H.265 for storage-efficient recording). We prefer Media2
    # (Profile T) since it is the H.265-capable service; fall back to Media (Profile S).
    # The profiles are sorted by width → the SMALLEST is the sub (matches
    # ``enumerate_channels``' main/sub-by-resolution convention). # LIVE-VALIDATE: many
    # NVRs reject SetVideoEncoderConfiguration for proxied channels (need their own web
    # UI) — reported honestly (ok=False, supported=True).

    @staticmethod
    def _norm_codec(raw: Any) -> str | None:
        """Normalize an ONVIF encoding value → ``H264`` | ``H265`` | ``MJPEG`` | ..."""
        if not raw:
            return None
        s = str(raw).upper().replace("-", "").replace(".", "")
        if "265" in s or "HEVC" in s:
            return "H265"
        if "264" in s or s == "AVC":
            return "H264"
        if "JPEG" in s or "MJPEG" in s:
            return "MJPEG"
        return s or None

    async def get_stream_codecs(self, host: str, creds: Credentials) -> list[StreamCodecProfile]:
        """Read each profile's current VideoEncoderConfiguration.Encoding (main/sub).
        Media2 first, then Media. Never raises — ``[]`` on unreachable/unsupported."""
        if not _HAS_ONVIF:
            return []
        if not await _tcp_reachable(host, creds.port):
            return []
        return await asyncio.to_thread(self._get_stream_codecs_sync, host, creds)

    def _get_stream_codecs_sync(self, host: str, creds: Credentials) -> list[StreamCodecProfile]:
        try:
            cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
        except Exception as exc:  # noqa: BLE001
            log.debug("get_stream_codecs: connect failed for %s: %s", host, exc)
            return []

        # Prefer Media2 (Profile T) when the device advertises it.
        media2 = self._media2_service(cam)
        service = media2 or self._media1_service(cam)
        if service is None:
            return []
        try:
            profiles = self._list_profiles(service, media2 is not None)
        except Exception as exc:  # noqa: BLE001
            log.debug("get_stream_codecs: GetProfiles failed for %s: %s", host, exc)
            return []
        if not profiles:
            return []

        def _width(p: Any) -> int:
            try:
                return int(self._enc_of(p).Resolution.Width)
            except Exception:  # noqa: BLE001
                return 0

        ordered = sorted(profiles, key=_width, reverse=True)  # main first, sub last
        out: list[StreamCodecProfile] = []
        for idx, prof in enumerate(ordered):
            role = "main" if idx == 0 else ("sub" if idx == 1 else "third")
            enc = self._enc_of(prof)
            codec = self._norm_codec(getattr(enc, "Encoding", None)) if enc is not None else None
            try:
                res = f"{enc.Resolution.Width}x{enc.Resolution.Height}" if enc is not None else None
            except Exception:  # noqa: BLE001
                res = None
            out.append(
                StreamCodecProfile(
                    role=role,
                    codec=codec,
                    token=str(getattr(prof, "token", "") or "") or None,
                    resolution=res,
                    extra={"enc_token": str(getattr(enc, "token", "") or "") if enc is not None else ""},
                )
            )
        return out

    async def set_stream_codec(
        self, host: str, creds: Credentials, *, profile: str = "sub", codec: str = "h264"
    ) -> FleetOpResult:
        """Set the ``profile`` (role: main/sub/third) VideoEncoderConfiguration.Encoding
        to ``codec``. ONVIF ``SetVideoEncoderConfiguration`` (Media / Media2). Graceful."""
        if not _HAS_ONVIF:
            return FleetOpResult(ok=False, supported=False, detail="python-onvif-zeep not installed")
        if not await _tcp_reachable(host, creds.port):
            return FleetOpResult(ok=False, detail="device unreachable")
        target = self._norm_codec(codec) or "H264"
        return await asyncio.to_thread(self._set_stream_codec_sync, host, creds, profile, target)

    def _set_stream_codec_sync(
        self, host: str, creds: Credentials, role: str, target: str
    ) -> FleetOpResult:
        try:
            cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
        except Exception as exc:  # noqa: BLE001
            return FleetOpResult(ok=False, detail=f"connect failed: {exc}")

        media2 = self._media2_service(cam)
        service = media2 or self._media1_service(cam)
        if service is None:
            return FleetOpResult(ok=False, supported=False, detail="device has no ONVIF media service")
        try:
            profiles = self._list_profiles(service, media2 is not None)
        except Exception as exc:  # noqa: BLE001
            return FleetOpResult(ok=False, detail=f"GetProfiles failed: {exc}")
        if not profiles:
            return FleetOpResult(ok=False, supported=False, detail="device exposes no media profiles")

        def _width(p: Any) -> int:
            try:
                return int(self._enc_of(p).Resolution.Width)
            except Exception:  # noqa: BLE001
                return 0

        ordered = sorted(profiles, key=_width, reverse=True)
        want_idx = {"main": 0, "sub": 1, "third": 2}.get(role, 1)
        if want_idx >= len(ordered):
            return FleetOpResult(
                ok=False, supported=True,
                detail=f"device has no '{role}' stream (only {len(ordered)} profile(s))",
            )
        prof = ordered[want_idx]
        enc = self._enc_of(prof)
        if enc is None:
            return FleetOpResult(ok=False, supported=True, detail="profile has no VideoEncoderConfiguration")

        current = self._norm_codec(getattr(enc, "Encoding", None))
        if current == target:
            return FleetOpResult(
                ok=True, detail=f"{role} stream already {target}", data={"already": True, "codec": target}
            )
        try:
            self._apply_encoding(service, enc, target, media2 is not None)
        except Exception as exc:  # noqa: BLE001 — device rejected (common on NVRs)
            return FleetOpResult(ok=False, supported=True, detail=f"device rejected codec change: {exc}")
        return FleetOpResult(
            ok=True, detail=f"{role} stream set to {target}", data={"codec": target, "role": role}
        )

    # -- media-service resolution helpers (Media2 preferred) ---------------------
    @staticmethod
    def _media2_service(cam: Any) -> Any | None:
        try:
            for svc in cam.devicemgmt.GetServices({"IncludeCapability": False}):
                if _is_media2_ns(str(getattr(svc, "Namespace", ""))):
                    return cam.create_media2_service()
        except Exception:  # noqa: BLE001
            return None
        return None

    @staticmethod
    def _media1_service(cam: Any) -> Any | None:
        try:
            return cam.create_media_service()
        except Exception:  # noqa: BLE001
            return None

    @staticmethod
    def _list_profiles(service: Any, is_media2: bool) -> list[Any]:
        if is_media2:
            return list(service.GetProfiles({"Type": ["All"]}) or [])
        return list(service.GetProfiles() or [])

    @staticmethod
    def _enc_of(profile: Any) -> Any | None:
        """The VideoEncoderConfiguration of a profile (Media2 nests it in a list)."""
        enc = getattr(profile, "VideoEncoderConfiguration", None)
        if enc is None:
            # Media2 profiles carry ``Configurations.VideoEncoder``.
            cfgs = getattr(profile, "Configurations", None)
            enc = getattr(cfgs, "VideoEncoder", None) if cfgs is not None else None
        if isinstance(enc, list):
            enc = enc[0] if enc else None
        return enc

    def _apply_encoding(self, service: Any, enc: Any, target: str, is_media2: bool) -> None:
        """Mutate the encoder config's Encoding + call SetVideoEncoderConfiguration.

        Media1 encoding is the enum ``H264``/``H265``/``JPEG``; Media2 uses the same
        short forms on ``VideoEncoder2Configuration.Encoding``. We set the field on the
        fetched config object (preserving all other fields) and persist it."""
        setattr(enc, "Encoding", target)
        if is_media2:
            service.SetVideoEncoderConfiguration({"Configuration": enc})
        else:
            service.SetVideoEncoderConfiguration(
                {"Configuration": enc, "ForcePersistence": True}
            )

    # ── event topic map (control-side) ────────────────────────────────────────
    def event_topic_map(self) -> dict[str, tuple[str, str, str]]:
        """Return the ONVIF topic → (event_type, severity, title) map (gvd_nvr
        ``_TOPIC_MAP``, verbatim). Used by ``subscribe_events`` + the Go nvr ingestor."""
        return dict(ONVIF_TOPIC_MAP)

    async def subscribe_events(self, host: str, creds: Credentials, callback: EventCallback) -> None:
        """Control-side ONVIF PullPoint subscription loop:
        CreatePullPointSubscription → PullMessages (2s) → Renew (45s) → Unsubscribe.
        Ported from gvd_nvr ``onvif_event_service._CameraPullWorker``. Runs until
        cancelled; the CALLER supervises (restart on permanent failure). At scale,
        the Go ``nvr`` service owns high-throughput ingestion (P5) — this is the
        low-volume control-side path (test-connection / a single camera).
        """
        if not _HAS_ONVIF:
            raise NotImplementedError("python-onvif-zeep not installed — event subscribe unavailable")

        self._events_running = True
        while getattr(self, "_events_running", False):
            try:
                await self._pull_loop(host, creds, callback)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.warning("[%s] ONVIF event pull failed: %s. Retrying in 30s", host, exc)
                await asyncio.sleep(30)

    async def stop_events(self) -> None:
        self._events_running = False

    async def _pull_loop(self, host: str, creds: Credentials, callback: EventCallback) -> None:
        pullpoint, sub_ref = await asyncio.to_thread(self._create_subscription, host, creds)
        if pullpoint is None:
            log.warning("[%s] Could not create ONVIF PullPoint subscription", host)
            await asyncio.sleep(60)
            return
        log.info("[%s] ONVIF PullPoint subscription active", host)
        last_renewal = asyncio.get_event_loop().time()
        try:
            while getattr(self, "_events_running", False):
                now = asyncio.get_event_loop().time()
                if (now - last_renewal) >= 45:
                    try:
                        await asyncio.to_thread(self._renew_subscription, host, creds, sub_ref)
                        last_renewal = now
                    except Exception as exc:  # noqa: BLE001
                        log.warning("[%s] Subscription renewal failed: %s — recreating", host, exc)
                        break
                messages = await asyncio.to_thread(self._pull_messages, pullpoint)
                for msg in messages:
                    evt = self._parse_message(msg)
                    if evt:
                        await callback(evt)
                await asyncio.sleep(2)
        finally:
            try:
                await asyncio.to_thread(self._unsubscribe, host, creds, sub_ref)
            except Exception:  # noqa: BLE001
                pass

    def _create_subscription(self, host: str, creds: Credentials) -> tuple[Any, Any]:
        try:
            cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
            event_service = cam.create_events_service()
            result = event_service.CreatePullPointSubscription({"InitialTerminationTime": "PT60S"})
            try:
                sub_ref = result.SubscriptionReference
                sub_address = sub_ref.Address._value_1
            except Exception:  # noqa: BLE001
                sub_ref = getattr(result, "SubscriptionReference", None)
                sub_address = str(sub_ref.Address) if sub_ref else None
            pullpoint = cam.create_pullpoint_service()
            if sub_address:
                try:
                    pullpoint.xaddr = sub_address
                except Exception:  # noqa: BLE001
                    pass
            return pullpoint, sub_ref
        except Exception as exc:  # noqa: BLE001
            log.error("[%s] CreatePullPointSubscription error: %s", host, exc)
            return None, None

    def _pull_messages(self, pullpoint: Any) -> list:
        try:
            result = pullpoint.PullMessages({"Timeout": "PT5S", "MessageLimit": 50})
            return result.NotificationMessage or []
        except Exception as exc:  # noqa: BLE001
            log.debug("PullMessages error: %s", exc)
            return []

    def _renew_subscription(self, host: str, creds: Credentials, sub_ref: Any) -> None:
        cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
        sub_mgr = cam.create_subscription_service()
        if sub_ref is not None:
            try:
                sub_mgr.xaddr = sub_ref.Address._value_1
            except Exception:  # noqa: BLE001
                pass
        sub_mgr.Renew({"TerminationTime": "PT60S"})

    def _unsubscribe(self, host: str, creds: Credentials, sub_ref: Any) -> None:
        try:
            cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
            sub_mgr = cam.create_subscription_service()
            if sub_ref is not None:
                try:
                    sub_mgr.xaddr = sub_ref.Address._value_1
                except Exception:  # noqa: BLE001
                    pass
            sub_mgr.Unsubscribe()
        except Exception:  # noqa: BLE001
            pass

    def _parse_message(self, msg: Any) -> DeviceEvent | None:
        """Parse an ONVIF NotificationMessage → DeviceEvent. Ported from gvd_nvr
        ``_extract_topic_from_message`` + ``_resolve_topic`` + ``_extract_metadata``."""
        topic_raw = None
        try:
            topic_raw = str(msg.Topic._value_1)
        except Exception:  # noqa: BLE001
            try:
                topic_raw = str(msg.Topic)
            except Exception:  # noqa: BLE001
                return None
        if not topic_raw:
            return None
        mapping = _resolve_topic(topic_raw)
        if not mapping:
            log.debug("Unhandled ONVIF topic: %s", topic_raw)
            return None
        event_type, severity, title = mapping

        meta: dict[str, Any] = {"onvif_topic": topic_raw}
        try:
            if getattr(msg, "ProducerReference", None):
                meta["source"] = str(msg.ProducerReference.Address)
        except Exception:  # noqa: BLE001
            pass
        try:
            data = msg.Message.Message.Data
            if data and hasattr(data, "SimpleItem"):
                for item in data.SimpleItem or []:
                    meta[item.Name] = item.Value
        except Exception:  # noqa: BLE001
            pass
        return DeviceEvent(
            event_type=event_type, severity=severity, title=title, raw_topic=topic_raw, metadata=meta
        )

    # ── recording search / playback (Profile G — gvd_nvr, ported) ─────────────
    async def search_recordings(
        self,
        host: str,
        creds: Credentials,
        *,
        channel: int | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
    ) -> list[dict[str, Any]]:
        """ONVIF Profile-G recording search. Injects the recording/search XAddrs from
        GetServices (NVRs like GVD omit them from GetCapabilities → SDK can't create the
        services otherwise), then reads each channel's recorded span via
        GetRecordingInformation. ``channel`` is the 1-based physical channel. Never raises."""
        if not _HAS_ONVIF:
            return []

        req_from = _nvr_time(start_time)
        req_until = _nvr_time(end_time)

        def _search() -> list[dict[str, Any]]:
            try:
                cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
                recording, search = _attach_profileg(cam)
                if recording is None:
                    log.warning("[%s] ONVIF recording service unavailable", host)
                    return []
                try:
                    recs = recording.GetRecordings() or []
                except Exception as exc:  # noqa: BLE001
                    log.warning("[%s] GetRecordings failed: %s", host, exc)
                    return []
                out: list[dict[str, Any]] = []
                for token in _tokens_for_channel(recs, channel, stream="main"):
                    span = _recording_span(search, recording, token)
                    if not span:
                        continue
                    rec_from, rec_until = span
                    seg_from = max(rec_from, req_from) if req_from else rec_from
                    seg_until = min(rec_until, req_until) if req_until else rec_until
                    if seg_from and seg_until and seg_from < seg_until:
                        out.append(
                            {
                                "recording_token": token,
                                "channel": channel,
                                "start_time": seg_from,
                                "end_time": seg_until,
                            }
                        )
                return out
            except Exception as exc:  # noqa: BLE001
                log.warning("[%s] ONVIF recording search failed: %s", host, exc)
                return []

        return await asyncio.to_thread(_search)

    async def get_playback_uri(
        self,
        host: str,
        creds: Credentials,
        *,
        channel: int | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
        recording_token: str | None = None,
    ) -> str | None:
        """ONVIF Profile-G GetReplayUri → an RTSP-with-time-window playback URI. Resolves
        the ``RecordingToken`` for the 1-based physical ``channel`` (or uses an explicit
        one), then rewrites the URI's starttime/endtime to the requested window so playback
        starts at the right instant. Injects Profile-G XAddrs first. Never raises."""
        if not _HAS_ONVIF:
            return None

        def _get() -> str | None:
            try:
                cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
                recording, _search = _attach_profileg(cam)
                token = recording_token
                # Prefer the SUB stream (H.264, browser-decodable) over MAIN (often
                # H.265/HEVC, which browsers can't play) so footage plays regardless of the
                # main-stream codec. want_subtype forces the RTSP subtype (GetReplayUri
                # always returns subtype=0, so we override it to 1 for the sub stream).
                want_subtype = 0
                if not token and recording is not None:
                    try:
                        recs = recording.GetRecordings() or []
                    except Exception:  # noqa: BLE001
                        recs = []
                    sub = _tokens_for_channel(recs, channel, stream="sub")
                    if sub:
                        token, want_subtype = sub[0], 1
                    else:
                        main = _tokens_for_channel(recs, channel, stream="main")
                        token, want_subtype = (main[0] if main else None), 0
                if not token:
                    return None
                try:
                    replay = cam.create_replay_service()
                except Exception as exc:  # noqa: BLE001
                    log.warning("[%s] ONVIF replay service unavailable: %s", host, exc)
                    return None
                uri = replay.GetReplayUri(
                    {
                        "StreamSetup": {"Stream": "RTP-Unicast", "Transport": {"Protocol": "RTSP"}},
                        "RecordingToken": token,
                    }
                )
                # GetReplayUri may return a plain RTSP string OR an object with ``.Uri``.
                url = getattr(uri, "Uri", None) or (uri if isinstance(uri, str) else None)
                if not url:
                    return None
                url = _rewrite_replay_window(url, start_time, end_time, subtype=want_subtype)
                return _inject_creds(url, creds.username, creds.password)
            except Exception as exc:  # noqa: BLE001
                log.warning("[%s] GetReplayUri failed: %s", host, exc)
                return None

        return await asyncio.to_thread(_get)
