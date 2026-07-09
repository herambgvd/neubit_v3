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
from urllib.parse import quote as _q
from urllib.parse import urlparse

from .base import (
    Capabilities,
    Channel,
    CameraDriver,
    Credentials,
    DeviceEvent,
    DeviceInfo,
    Discovered,
    DriverError,
    EventCallback,
    PtzCommand,
    StreamInfo,
    StreamUris,
)

log = logging.getLogger("vision.drivers.onvif")

# Common ONVIF service ports across vendors (gvd_nvr ONVIF_PROBE_PORTS, verbatim).
# Order matters — 80 first since ~99% of cameras serve there.
ONVIF_PROBE_PORTS = (80, 8080, 8000, 8899, 2020, 8081, 8443, 443)

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
                raise DriverError(f"unknown PTZ action: {cmd.action}")
            except DriverError:
                raise
            except Exception as exc:  # noqa: BLE001
                raise DriverError(f"PTZ {cmd.action} failed for {host}: {exc}") from None

        return await asyncio.to_thread(_run)

    # ── configuration (imaging / io / ntp / …) ────────────────────────────────
    async def configure(
        self, host: str, creds: Credentials, section: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Read (empty payload) or write an ONVIF config ``section``. Ported from
        gvd_nvr imaging + I/O + system-time services. Raises ``DriverError`` on
        write failure / unsupported section.

        Sections:
          * ``imaging`` — GetImagingSettings (read) / SetImagingSettings (write patch).
          * ``io``      — GetRelayOutputs + GetDigitalInputs (read) / SetRelayOutputState (write).
          * ``ntp``     — GetSystemDateAndTime (read) / SetSystemDateAndTime sync (write).
        """
        if not _HAS_ONVIF:
            raise DriverError("python-onvif-zeep not installed — configure unavailable")

        write = bool(payload)

        def _run() -> dict[str, Any]:
            cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
            if section == "imaging":
                return self._configure_imaging(cam, payload, write)
            if section == "io":
                return self._configure_io(cam, payload, write)
            if section == "ntp":
                return self._configure_ntp(cam, payload, write)
            raise DriverError(f"unsupported ONVIF config section: {section}")

        try:
            return await asyncio.to_thread(_run)
        except DriverError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise DriverError(f"configure({section}) failed for {host}: {exc}") from None

    def _configure_imaging(self, cam: Any, payload: dict[str, Any], write: bool) -> dict[str, Any]:
        media = cam.create_media_service()
        vs_token = media.GetVideoSources()[0].token
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
                if key in payload and hasattr(current, attr):
                    setattr(current, attr, cast(payload[key]))
            if "wide_dynamic_range" in payload and getattr(current, "WideDynamicRange", None):
                wdr = payload["wide_dynamic_range"]
                current.WideDynamicRange.Mode = wdr.get("mode", "OFF")
                if "level" in wdr:
                    current.WideDynamicRange.Level = float(wdr["level"])
            imaging.SetImagingSettings(
                {"VideoSourceToken": vs_token, "ImagingSettings": current, "ForcePersistence": True}
            )
            current = imaging.GetImagingSettings({"VideoSourceToken": vs_token})
        return {
            "video_source_token": vs_token,
            "brightness": getattr(current, "Brightness", None),
            "contrast": getattr(current, "Contrast", None),
            "color_saturation": getattr(current, "ColorSaturation", None),
            "sharpness": getattr(current, "Sharpness", None),
            "ir_cut_filter": str(getattr(current, "IrCutFilter", "")) or None,
        }

    def _configure_io(self, cam: Any, payload: dict[str, Any], write: bool) -> dict[str, Any]:
        dm = cam.devicemgmt
        if write:
            dm.SetRelayOutputState(
                {
                    "RelayOutputToken": payload.get("relay_token", "RelayOut1"),
                    "LogicalState": payload.get("state", "active"),
                }
            )
        outputs = []
        for out in dm.GetRelayOutputs() or []:
            outputs.append(
                {
                    "token": str(out.token),
                    "mode": str(getattr(out.Properties, "Mode", "")),
                    "idle_state": str(getattr(out.Properties, "IdleState", "")),
                }
            )
        inputs = []
        try:
            for inp in dm.GetDigitalInputs() or []:
                inputs.append({"token": str(inp.token), "idle_state": str(getattr(inp, "IdleState", ""))})
        except Exception:  # noqa: BLE001
            pass
        return {"relay_outputs": outputs, "digital_inputs": inputs}

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
        """ONVIF Profile G recording search (GetRecordings → FindRecordings fallback).
        Ported from gvd_nvr ``search_recordings``. Never raises."""
        if not _HAS_ONVIF:
            return []

        def _search() -> list[dict[str, Any]]:
            try:
                cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
                try:
                    recording = cam.create_recording_service()
                except Exception:  # noqa: BLE001
                    return []
                try:
                    recs = recording.GetRecordings()
                    if recs:
                        out = []
                        for rec in recs:
                            token = getattr(rec, "RecordingToken", None) or str(rec)
                            out.append(
                                {"recording_token": str(token), "start_time": start_time, "end_time": end_time}
                            )
                        return out
                except Exception:  # noqa: BLE001
                    pass
                # Fallback: FindRecordings search API.
                scope = {"IncludedSources": [], "IncludedRecordings": [], "RecordingInformationFilter": None}
                if start_time and end_time:
                    scope["StartTime"] = start_time
                    scope["EndTime"] = end_time
                result = recording.FindRecordings({"Scope": scope})
                search_token = getattr(result, "SearchToken", None)
                if not search_token:
                    return []
                results = recording.GetRecordingSearchResults(
                    {"SearchToken": search_token, "MinResults": 1, "MaxResults": 100, "WaitTime": "PT5S"}
                )
                out = []
                for rec in getattr(results, "RecordingResult", []) or []:
                    token = getattr(rec, "RecordingToken", None)
                    if token:
                        out.append(
                            {"recording_token": str(token), "start_time": start_time, "end_time": end_time}
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
        """ONVIF Profile G GetReplayUri. Ported from gvd_nvr ``get_replay_uri``. Never raises.

        Profile G replay is keyed by a ``RecordingToken``, not a channel+window: when no
        explicit ``recording_token`` is given we first ``search_recordings`` (for the
        channel/window) and replay the first match's token. The replay stream position is
        then driven by the RTSP Range header (playback control), not the URI — so the URI
        is the recording's replay endpoint. Returns ``None`` when nothing matches.
        """
        if not _HAS_ONVIF:
            return None

        token = recording_token
        if not token:
            matches = await self.search_recordings(
                host, creds, channel=channel, start_time=start_time, end_time=end_time
            )
            for m in matches:
                if m.get("recording_token"):
                    token = m["recording_token"]
                    break
        if not token:
            return None

        def _get() -> str | None:
            try:
                cam = ONVIFCamera(host, creds.port, creds.username, creds.password)
                try:
                    replay = cam.create_replay_service()
                except Exception:  # noqa: BLE001
                    return None
                uri = replay.GetReplayUri(
                    {
                        "StreamSetup": {"Stream": "RTP_Unicast", "Transport": {"Protocol": "RTSP"}},
                        "RecordingToken": token,
                    }
                )
                url = getattr(uri, "Uri", None)
                return _inject_creds(url, creds.username, creds.password) if url else None
            except Exception as exc:  # noqa: BLE001
                log.warning("[%s] GetReplayUri failed: %s", host, exc)
                return None

        return await asyncio.to_thread(_get)
