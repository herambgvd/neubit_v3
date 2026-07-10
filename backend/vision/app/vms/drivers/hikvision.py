"""HikvisionDriver — Hikvision ISAPI (HTTP Digest) camera + NVR driver.

Hikvision devices expose the ISAPI REST surface (XML over HTTP Digest). This driver
implements the standard, well-documented ISAPI endpoints for onboarding + config +
PTZ. Hikvision cameras ALSO speak ONVIF, so ``OnvifDriver`` is a valid fallback; this
native driver is preferred for Hik-branded devices because ISAPI exposes NVR channel
proxying + footage search that ONVIF often doesn't surface uniformly on Hik NVRs.

ISAPI endpoint map (all HTTP Digest):
  * device info      GET  ``/ISAPI/System/deviceInfo``               → model/firmware/serial/mac.
  * capabilities     GET  ``/ISAPI/System/capabilities`` (+ PTZ chan) → coarse cap flags.
  * NVR channels     GET  ``/ISAPI/ContentMgmt/InputProxy/channels`` (NVR proxied inputs)
                     GET  ``/ISAPI/Streaming/channels``              (direct camera streams).
  * stream URIs      ``rtsp://host:554/Streaming/Channels/<id>01`` (main) / ``<id>02`` (sub)
                     where ``<id>`` = channel number (Hik convention: ch1 main = 101, sub = 102).
  * snapshot         GET  ``/ISAPI/Streaming/channels/<id>01/picture``.
  * PTZ              PUT  ``/ISAPI/PTZCtrl/channels/<id>/continuous`` (+ presets/momentary).
  * NVR footage      POST ``/ISAPI/ContentMgmt/search`` (CMSearchDescription)  ← P4, documented stub.

LIVE-VALIDATE: endpoint construction + XML shapes below follow Hikvision's published
ISAPI spec, but exact tag names + channel-id math vary by firmware/model. All parsing
is written defensively (namespace-agnostic, fields optional). Confirm against the
owner's real Hik cameras + NVRs — see the ``# LIVE-VALIDATE:`` markers.
"""

from __future__ import annotations

import logging
from typing import Any

from . import _http
from .base import (
    Capabilities,
    Channel,
    CameraDriver,
    ConfigBackup,
    Credentials,
    DeviceInfo,
    Discovered,
    DriverError,
    FleetOpResult,
    PtzCommand,
    StreamCodecProfile,
    StreamInfo,
    StreamUris,
)


def _norm_codec(raw: str | None) -> str | None:
    """Normalize a brand codec token → ``H264`` | ``H265`` | ``MJPEG`` | ..."""
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


# Codec role → normalized token → the value the brand expects in its config write.
_HIK_CODEC_VALUE = {"H264": "H.264", "H265": "H.265", "MJPEG": "MJPEG"}

log = logging.getLogger("vision.drivers.hikvision")


def _xml_escape(value: str) -> str:
    """Minimal XML text escaping for user-supplied preset names in ISAPI bodies."""
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _fps_from_isapi(max_frame_rate: str | None) -> int | None:
    """ISAPI ``maxFrameRate`` is in centi-fps (e.g. 2500 = 25 fps). Convert to fps."""
    if not max_frame_rate:
        return None
    try:
        return int(int(max_frame_rate) / 100)
    except (TypeError, ValueError):
        return None


def _rtsp_channel_id(channel: int, stream: int) -> int:
    """Hikvision channel-id math: main = ``ch*100 + 1``, sub = ``ch*100 + 2``.
    ch1 main = 101, ch1 sub = 102, ch2 main = 201, … (ISAPI Streaming/Channels)."""
    return channel * 100 + stream


# Hik privacy/motion regions ride a normalized 0..1000 grid in ISAPI XML.
_HIK_GRID = 1000


def _region_shapes(payload: dict[str, Any] | None, key: str) -> list[dict[str, Any]]:
    """Extract the normalized (0..1) shape list from a ``{key: [...]}`` config payload."""
    if not payload:
        return []
    shapes = payload.get(key)
    if shapes is None and isinstance(payload, list):
        shapes = payload
    return list(shapes or [])


def _shape_points_1k(shape: dict[str, Any]) -> list[tuple[int, int]]:
    """Normalized (0..1) shape → integer points on Hik's 0..1000 grid.

    Rect ``{x,y,w,h}`` → 4 corners; polygon ``{points:[[x,y],...]}`` preserved.
    """
    def _p(px: float, py: float) -> tuple[int, int]:
        return (
            max(0, min(_HIK_GRID, round(float(px) * _HIK_GRID))),
            max(0, min(_HIK_GRID, round(float(py) * _HIK_GRID))),
        )

    pts = shape.get("points")
    if pts:
        return [_p(p[0], p[1]) for p in pts]
    x, y = float(shape.get("x", 0.0)), float(shape.get("y", 0.0))
    w, h = float(shape.get("w", 0.0)), float(shape.get("h", 0.0))
    return [_p(x, y), _p(x + w, y), _p(x + w, y + h), _p(x, y + h)]


def _hik_region_xml(idx: int, shape: dict[str, Any], *, tag: str = "PrivacyMaskRegion") -> str:
    """Build one Hik region XML element from a normalized shape (0..1000 grid)."""
    pts = _shape_points_1k(shape)
    coords = "".join(f"<RegionCoordinates><positionX>{px}</positionX><positionY>{py}</positionY></RegionCoordinates>" for px, py in pts)
    return (
        f"<{tag}><id>{idx}</id><enabled>true</enabled>"
        f"<RegionCoordinatesList>{coords}</RegionCoordinatesList></{tag}>"
    )


def _rtsp_url(host: str, creds: Credentials, channel: int, stream: int) -> str:
    """Build a Hikvision RTSP URL with creds injected. stream: 1 = main, 2 = sub."""
    from urllib.parse import quote

    cid = _rtsp_channel_id(channel, stream)
    user = quote(creds.username or "", safe="")
    pw = quote(creds.password or "", safe="")
    auth = f"{user}:{pw}@" if creds.username else ""
    return f"rtsp://{auth}{host}:{creds.rtsp_port}/Streaming/Channels/{cid}"


def _to_hik_time(iso: str | None) -> str | None:
    """Normalise an ISO-8601 time to Hikvision's ISAPI form ``YYYY-MM-DDTHH:MM:SSZ``.

    ISAPI CMSearch ``<startTime>``/``<endTime>`` want a UTC ISO string with a ``Z``. We
    parse a variety of inputs (``…Z`` / ``…+00:00`` / naive) and re-emit the canonical
    seconds-resolution UTC form. Returns None on unparseable input."""
    if not iso:
        return None
    from datetime import datetime, timezone

    try:
        s = str(iso).strip().replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, TypeError):
        return None


def _to_rtsp_time(iso: str | None) -> str | None:
    """Hik RTSP playback ``starttime``/``endtime`` use the basic form ``YYYYMMDDTHHMMSSZ``."""
    hik = _to_hik_time(iso)
    if not hik:
        return None
    # 2026-07-09T10:00:00Z → 20260709T100000Z
    return hik.replace("-", "").replace(":", "")


class HikvisionDriver(CameraDriver):
    """Hikvision ISAPI driver (HTTP Digest). Onboarding + config + PTZ implemented;
    NVR footage search is a documented P4 stub."""

    brand = "hikvision"

    def _base(self, host: str, creds: Credentials) -> str:
        scheme = "https" if creds.verify_tls else "http"
        return f"{scheme}://{host}:{creds.port}"

    # ── discovery ────────────────────────────────────────────────────────────
    async def discover(
        self, network: str | None = None, *, creds: Credentials | None = None, timeout: int = 5
    ) -> list[Discovered]:
        """Hikvision devices are discovered via ONVIF WS-Discovery / SADP (UDP 37020).
        SADP is a proprietary binary protocol; the practical cross-brand discovery path
        is ONVIF. Delegates to ``OnvifDriver.discover`` (Hik cameras answer ONVIF), then
        tags results ``brand='hikvision'``. Never raises.

        # LIVE-VALIDATE: native SADP discovery (UDP 37020 broadcast) is NOT implemented —
        # ONVIF discovery is used. Confirm Hik devices appear via ONVIF on the owner's LAN.
        """
        from .onvif import OnvifDriver

        found = await OnvifDriver().discover(network, creds=creds, timeout=timeout)
        for d in found:
            d.brand = "hikvision"
        return found

    # ── probe / identity ─────────────────────────────────────────────────────
    async def probe(self, host: str, creds: Credentials) -> DeviceInfo:
        """GET /ISAPI/System/deviceInfo → identity. Never raises."""
        body = await _http.get_text(f"{self._base(host, creds)}/ISAPI/System/deviceInfo", creds.username, creds.password)
        if body is None:
            return DeviceInfo(reachable=False, error="ISAPI deviceInfo unreachable or auth failed")
        info = DeviceInfo(
            reachable=True,
            manufacturer="Hikvision",
            model=_http.xml_text(body, "model"),
            firmware=_http.xml_text(body, "firmwareVersion"),
            serial_number=_http.xml_text(body, "serialNumber"),
            mac=_http.xml_text(body, "macAddress"),
            raw={"deviceInfo_len": len(body)},
        )
        # deviceType hints NVR vs camera; channel count comes from channels enum.
        dev_type = _http.xml_text(body, "deviceType")
        if dev_type:
            info.raw["device_type"] = dev_type
        return info

    # ── channel enumeration ───────────────────────────────────────────────────
    async def enumerate_channels(self, host: str, creds: Credentials) -> list[Channel]:
        """Enumerate channels. NVRs proxy inputs at
        ``/ISAPI/ContentMgmt/InputProxy/channels``; standalone cameras / the direct
        stream view live at ``/ISAPI/Streaming/channels``. Tries InputProxy first
        (NVR), falls back to Streaming (camera). Never raises.

        # LIVE-VALIDATE: InputProxy channel-id ↔ RTSP channel-id mapping. On some Hik
        # NVR firmware the RTSP channel is the InputProxy ``id`` directly; on others it
        # is a separate ``Streaming/channels`` id. Verify against a real Hik NVR.
        """
        base = self._base(host, creds)
        # ── NVR path: proxied input channels ──
        body = await _http.get_text(f"{base}/ISAPI/ContentMgmt/InputProxy/channels", creds.username, creds.password)
        if body:
            channels = self._parse_input_proxy(host, creds, body)
            if channels:
                return channels
        # ── Camera path: direct streaming channels ──
        body = await _http.get_text(f"{base}/ISAPI/Streaming/channels", creds.username, creds.password)
        if body:
            return self._parse_streaming_channels(host, creds, body)
        return []

    def _parse_input_proxy(self, host: str, creds: Credentials, body: str) -> list[Channel]:
        """Parse ``InputProxyChannel`` elements (Hik NVR proxied inputs)."""
        out: list[Channel] = []
        for idx, el in enumerate(_http.xml_findall(body, "InputProxyChannel"), start=1):
            chan_id = _http.el_text(el, "id")
            name = _http.el_text(el, "name") or f"Channel {idx}"
            try:
                ch_num = int(chan_id) if chan_id else idx
            except ValueError:
                ch_num = idx
            out.append(
                Channel(
                    channel=idx,
                    name=name,
                    source_token=chan_id,
                    channel_number=ch_num,
                    main=StreamInfo(stream_url=_rtsp_url(host, creds, ch_num, 1)),
                    sub=StreamInfo(stream_url=_rtsp_url(host, creds, ch_num, 2)),
                    snapshot_url=f"{self._base(host, creds)}/ISAPI/Streaming/channels/{_rtsp_channel_id(ch_num, 1)}/picture",
                )
            )
        return out

    def _parse_streaming_channels(self, host: str, creds: Credentials, body: str) -> list[Channel]:
        """Parse ``StreamingChannel`` elements. Hik lists main+sub as separate
        StreamingChannel entries (id 101, 102, 201, 202, …) — group by ``id // 100``."""
        by_channel: dict[int, dict[int, dict[str, Any]]] = {}
        for el in _http.xml_findall(body, "StreamingChannel"):
            sid = _http.el_text(el, "id")
            if not sid or not sid.isdigit():
                continue
            sid_int = int(sid)
            channel = sid_int // 100
            stream = sid_int % 100  # 1 = main, 2 = sub
            res_w = _http.el_text(el, "videoResolutionWidth")
            res_h = _http.el_text(el, "videoResolutionHeight")
            by_channel.setdefault(channel, {})[stream] = {
                "codec": _http.el_text(el, "videoCodecType"),
                "resolution": f"{res_w}x{res_h}" if res_w and res_h else None,
                "fps": _fps_from_isapi(_http.el_text(el, "maxFrameRate")),
            }
        out: list[Channel] = []
        for idx, channel in enumerate(sorted(by_channel), start=1):
            streams = by_channel[channel]
            main_meta = streams.get(1, {})
            sub_meta = streams.get(2)
            out.append(
                Channel(
                    channel=idx,
                    name=f"Channel {channel}",
                    channel_number=channel,
                    main=StreamInfo(
                        stream_url=_rtsp_url(host, creds, channel, 1),
                        resolution=main_meta.get("resolution"),
                        fps=main_meta.get("fps"),
                        codec=main_meta.get("codec"),
                    ),
                    sub=StreamInfo(
                        stream_url=_rtsp_url(host, creds, channel, 2),
                        resolution=sub_meta.get("resolution") if sub_meta else None,
                        fps=sub_meta.get("fps") if sub_meta else None,
                        codec=sub_meta.get("codec") if sub_meta else None,
                    )
                    if sub_meta
                    else None,
                    snapshot_url=f"{self._base(host, creds)}/ISAPI/Streaming/channels/{_rtsp_channel_id(channel, 1)}/picture",
                )
            )
        return out

    # ── stream URIs ──────────────────────────────────────────────────────────
    async def get_stream_uris(
        self, host: str, creds: Credentials, *, profile: str | None = None
    ) -> StreamUris:
        """Build Hik RTSP URIs for a channel. ``profile`` = channel number as a string
        (default channel 1). Constructed from convention — no device round-trip. Never raises."""
        try:
            channel = int(profile) if profile else 1
        except (TypeError, ValueError):
            channel = 1
        return StreamUris(
            main=_rtsp_url(host, creds, channel, 1),
            sub=_rtsp_url(host, creds, channel, 2),
            media_version=1,
        )

    # ── capability detection ──────────────────────────────────────────────────
    async def get_capabilities(self, host: str, creds: Credentials) -> Capabilities:
        """GET /ISAPI/System/capabilities + /ISAPI/PTZCtrl/channels probe. Never raises.

        # LIVE-VALIDATE: capability XML tag names vary by firmware; PTZ presence is
        # inferred from the PTZCtrl endpoint responding. Confirm on real Hik devices.
        """
        base = self._base(host, creds)
        caps = Capabilities()
        body = await _http.get_text(f"{base}/ISAPI/System/capabilities", creds.username, creds.password)
        if body:
            low = body.lower()
            caps.ptz = "ptz" in low or "isSupportPTZ".lower() in low
            caps.imaging = "imaging" in low or "isSupportImageEnhancement".lower() in low
            caps.events = "event" in low
            caps.io = "ioport" in low or "isSupportInput".lower() in low
            caps.audio = "audio" in low
            caps.recording_search = "cmsearch" in low or "contentmgmt" in low
            caps.raw = {"capabilities_len": len(body)}
        # PTZ confirm: PTZCtrl channel status endpoint responds on PTZ devices.
        ptz_probe = await _http.get_text(f"{base}/ISAPI/PTZCtrl/channels/1/status", creds.username, creds.password)
        if ptz_probe is not None:
            caps.ptz = True
        return caps

    # ── snapshot ──────────────────────────────────────────────────────────────
    async def get_snapshot(
        self, host: str, creds: Credentials, *, profile: str | None = None
    ) -> bytes | None:
        """GET /ISAPI/Streaming/channels/<id>01/picture (JPEG). Never raises."""
        try:
            channel = int(profile) if profile else 1
        except (TypeError, ValueError):
            channel = 1
        cid = _rtsp_channel_id(channel, 1)
        return await _http.get_bytes(
            f"{self._base(host, creds)}/ISAPI/Streaming/channels/{cid}/picture", creds.username, creds.password
        )

    # ── PTZ (operator action — raises DriverError) ────────────────────────────
    async def ptz(self, host: str, creds: Credentials, cmd: PtzCommand) -> Any:
        """PTZ via ISAPI PTZCtrl. Raises ``DriverError`` on failure.

        # LIVE-VALIDATE: pan/tilt/zoom value ranges. ISAPI ``continuous`` expects
        # integer -100..100; this maps the driver's -1.0..1.0 floats accordingly.
        # Confirm direction signs + preset XML on the owner's Hik PTZ camera.
        """
        base = self._base(host, creds)
        channel = int(cmd.profile_token) if (cmd.profile_token or "").isdigit() else 1
        headers = {"Content-Type": "application/xml"}
        try:
            if cmd.action == "continuous" or cmd.action == "relative":
                pan = int(max(-100, min(100, cmd.pan * 100)))
                tilt = int(max(-100, min(100, cmd.tilt * 100)))
                zoom = int(max(-100, min(100, cmd.zoom * 100)))
                xml = f"<PTZData><pan>{pan}</pan><tilt>{tilt}</tilt><zoom>{zoom}</zoom></PTZData>"
                await _http.request_strict(
                    "PUT", f"{base}/ISAPI/PTZCtrl/channels/{channel}/continuous",
                    creds.username, creds.password, content=xml, headers=headers, verify_tls=creds.verify_tls,
                )
                return None
            if cmd.action == "stop":
                xml = "<PTZData><pan>0</pan><tilt>0</tilt><zoom>0</zoom></PTZData>"
                await _http.request_strict(
                    "PUT", f"{base}/ISAPI/PTZCtrl/channels/{channel}/continuous",
                    creds.username, creds.password, content=xml, headers=headers, verify_tls=creds.verify_tls,
                )
                return None
            if cmd.action == "zoom":
                # Zoom-only continuous move (pan/tilt held at 0). Direction/speed from cmd.zoom.
                zoom = int(max(-100, min(100, cmd.zoom * 100)))
                xml = f"<PTZData><pan>0</pan><tilt>0</tilt><zoom>{zoom}</zoom></PTZData>"
                await _http.request_strict(
                    "PUT", f"{base}/ISAPI/PTZCtrl/channels/{channel}/continuous",
                    creds.username, creds.password, content=xml, headers=headers, verify_tls=creds.verify_tls,
                )
                return None
            if cmd.action == "goto_preset":
                await _http.request_strict(
                    "PUT", f"{base}/ISAPI/PTZCtrl/channels/{channel}/presets/{cmd.preset_token}/goto",
                    creds.username, creds.password, content="", headers=headers, verify_tls=creds.verify_tls,
                )
                return None
            if cmd.action == "get_presets":
                body = await _http.get_text(
                    f"{base}/ISAPI/PTZCtrl/channels/{channel}/presets", creds.username, creds.password
                )
                presets = []
                for el in _http.xml_findall(body or "", "PTZPreset"):
                    presets.append({"token": _http.el_text(el, "id"), "name": _http.el_text(el, "presetName", "name")})
                return presets
            if cmd.action == "set_preset":
                # ISAPI stores a preset by id. The caller supplies the target id in
                # ``preset_token`` (the driver picks the next free id if omitted); the current
                # position is captured by the device. Returns the id used as the token.
                pid = cmd.preset_token or await self._next_preset_id(base, channel, creds)
                name = cmd.preset_name or f"preset {pid}"
                xml = (
                    f"<PTZPreset><id>{pid}</id><presetName>{_xml_escape(name)}</presetName></PTZPreset>"
                )
                await _http.request_strict(
                    "PUT", f"{base}/ISAPI/PTZCtrl/channels/{channel}/presets/{pid}",
                    creds.username, creds.password, content=xml, headers=headers, verify_tls=creds.verify_tls,
                )
                return str(pid)
            if cmd.action == "delete_preset":
                await _http.request_strict(
                    "DELETE", f"{base}/ISAPI/PTZCtrl/channels/{channel}/presets/{cmd.preset_token}",
                    creds.username, creds.password, content="", headers=headers, verify_tls=creds.verify_tls,
                )
                return None
            raise DriverError(f"Hikvision PTZ action not implemented: {cmd.action}")
        except _http.BrandHTTPError as exc:
            raise DriverError(f"Hikvision PTZ {cmd.action} failed for {host}: {exc}") from None

    async def _next_preset_id(self, base: str, channel: int, creds: Credentials) -> int:
        """Pick the next free preset id (1..255) by reading the current preset list.

        # LIVE-VALIDATE: Hik preset id space + PUT-to-create semantics vary by firmware.
        """
        try:
            body = await _http.get_text(
                f"{base}/ISAPI/PTZCtrl/channels/{channel}/presets", creds.username, creds.password
            )
            used = set()
            for el in _http.xml_findall(body or "", "PTZPreset"):
                try:
                    used.add(int(_http.el_text(el, "id") or 0))
                except (TypeError, ValueError):
                    continue
            for candidate in range(1, 256):
                if candidate not in used:
                    return candidate
        except Exception:  # noqa: BLE001 — best-effort; fall back to id 1
            pass
        return 1

    # ── configuration (operator action) ──────────────────────────────────────
    async def configure(
        self, host: str, creds: Credentials, section: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Read/write a config section over ISAPI. Raises ``DriverError`` on failure.

        Sections (read = empty payload):
          * ``imaging`` — GET/PUT ``/ISAPI/Image/channels/1/color``.
          * ``io``      — GET ``/ISAPI/System/IO/inputs`` + ``/outputs``.

        # LIVE-VALIDATE: ISAPI Image + IO XML schemas vary by firmware — read paths are
        # best-effort parsed; write is passthrough. Confirm against real devices.
        """
        base = self._base(host, creds)
        if section == "imaging":
            url = f"{base}/ISAPI/Image/channels/1/color"
            if payload:
                body = "<Color>" + "".join(f"<{k}>{v}</{k}>" for k, v in payload.items()) + "</Color>"
                try:
                    await _http.request_strict(
                        "PUT", url, creds.username, creds.password,
                        content=body, headers={"Content-Type": "application/xml"}, verify_tls=creds.verify_tls,
                    )
                except _http.BrandHTTPError as exc:
                    raise DriverError(f"Hikvision imaging write failed: {exc}") from None
            current = await _http.get_text(url, creds.username, creds.password)
            return {"raw_xml": current}
        if section == "io":
            inputs = await _http.get_text(f"{base}/ISAPI/System/IO/inputs", creds.username, creds.password)
            outputs = await _http.get_text(f"{base}/ISAPI/System/IO/outputs", creds.username, creds.password)
            return {"inputs_xml": inputs, "outputs_xml": outputs}
        if section == "privacy_masks":
            return await self._configure_privacy_masks(base, creds, payload)
        if section == "motion_zones":
            return await self._configure_motion_zones(base, creds, payload)
        raise DriverError(f"unsupported Hikvision config section: {section}")

    # ── privacy / motion region push (ISAPI) ──────────────────────────────────
    async def _configure_privacy_masks(
        self, base: str, creds: Credentials, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Push privacy masks via ISAPI ``/ISAPI/System/Video/inputs/channels/1/privacyMask``.

        Hik privacy masks are AXIS-ALIGNED rectangles on a normalized 704x576 grid.
        Normalized (0..1) rects map directly; polygons collapse to their bounding box
        (Hik privacy mask has no polygon surface). Read (empty payload) returns raw XML.

        # LIVE-VALIDATE: the privacyMask/regionList XML schema + whether the grid is
        # 704x576 or the channel resolution vary by firmware — confirm on a real device.
        """
        ch = int((payload or {}).get("channel", 1))
        url = f"{base}/ISAPI/System/Video/inputs/channels/{ch}/privacyMask"
        region_url = f"{url}/regions"
        shapes = _region_shapes(payload, "privacy_masks")
        if shapes:
            regions = "".join(
                _hik_region_xml(i, s) for i, s in enumerate(shapes, start=1)
            )
            body = (
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<PrivacyMaskRegionList xmlns="http://www.hikvision.com/ver20/XMLSchema">'
                f"{regions}</PrivacyMaskRegionList>"
            )
            try:
                await _http.request_strict(
                    "PUT", region_url, creds.username, creds.password,
                    content=body, headers={"Content-Type": "application/xml"}, verify_tls=creds.verify_tls,
                )
                # Ensure masking is enabled on the channel.
                await _http.request_strict(
                    "PUT", url, creds.username, creds.password,
                    content='<?xml version="1.0" encoding="UTF-8"?>'
                    '<PrivacyMask xmlns="http://www.hikvision.com/ver20/XMLSchema">'
                    "<enabled>true</enabled></PrivacyMask>",
                    headers={"Content-Type": "application/xml"}, verify_tls=creds.verify_tls,
                )
            except _http.BrandHTTPError as exc:
                raise DriverError(f"Hikvision privacy-mask write failed: {exc}") from None
        current = await _http.get_text(region_url, creds.username, creds.password)
        return {"applied": bool(shapes), "count": len(shapes), "raw_xml": current}

    async def _configure_motion_zones(
        self, base: str, creds: Credentials, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Push motion regions via ISAPI ``/ISAPI/System/Video/inputs/channels/1/motionDetection``.

        Hik motion detection uses a grid-region model (``MotionDetectionRegionList`` with
        a 22x18 or 32x18 cell grid) OR a normalized regionList on newer firmware. We send
        the normalized ``RegionCoordinatesList`` form (704x576 grid) — polygons preserved,
        rects expanded to 4 corners. Read (empty payload) returns raw XML.

        # LIVE-VALIDATE: grid-cell vs regionList model + the exact motionDetection XML
        # schema vary widely by firmware — confirm on a real Hik device.
        """
        ch = int((payload or {}).get("channel", 1))
        url = f"{base}/ISAPI/System/Video/inputs/channels/{ch}/motionDetection"
        shapes = _region_shapes(payload, "motion_zones")
        if shapes:
            regions = "".join(
                _hik_region_xml(i, s, tag="MotionDetectionRegion") for i, s in enumerate(shapes, start=1)
            )
            body = (
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<MotionDetection xmlns="http://www.hikvision.com/ver20/XMLSchema">'
                "<enabled>true</enabled>"
                '<MotionDetectionLayout><targetType>region</targetType>'
                f"<MotionDetectionRegionList>{regions}</MotionDetectionRegionList>"
                "</MotionDetectionLayout></MotionDetection>"
            )
            try:
                await _http.request_strict(
                    "PUT", url, creds.username, creds.password,
                    content=body, headers={"Content-Type": "application/xml"}, verify_tls=creds.verify_tls,
                )
            except _http.BrandHTTPError as exc:
                raise DriverError(f"Hikvision motion-region write failed: {exc}") from None
        current = await _http.get_text(url, creds.username, creds.password)
        return {"applied": bool(shapes), "count": len(shapes), "raw_xml": current}

    # ── device / fleet management (G7) — ISAPI System endpoints ───────────────
    async def reboot(self, host: str, creds: Credentials) -> FleetOpResult:
        """PUT /ISAPI/System/reboot. # LIVE-VALIDATE: real reboot effect."""
        try:
            await _http.request_strict(
                "PUT", f"{self._base(host, creds)}/ISAPI/System/reboot",
                creds.username, creds.password, content="", verify_tls=creds.verify_tls,
            )
            return FleetOpResult(ok=True, detail="reboot requested")
        except _http.BrandHTTPError as exc:
            return FleetOpResult(ok=False, detail=f"reboot failed: {exc}")

    async def set_ntp(self, host: str, creds: Credentials, server: str) -> FleetOpResult:
        """PUT /ISAPI/System/time/ntpServers/1 with an ``<NTPServer>`` body, then flip
        the time-mode to NTP via /ISAPI/System/time. # LIVE-VALIDATE: exact NTP XML +
        ntpServer id vary by firmware."""
        base = self._base(host, creds)
        ntp_xml = (
            "<NTPServer><id>1</id><addressingFormatType>hostname</addressingFormatType>"
            f"<hostName>{_xml_escape(server)}</hostName><portNo>123</portNo>"
            "<synchronizeInterval>60</synchronizeInterval></NTPServer>"
        )
        time_xml = "<Time><timeMode>NTP</timeMode></Time>"
        headers = {"Content-Type": "application/xml"}
        try:
            await _http.request_strict(
                "PUT", f"{base}/ISAPI/System/time/ntpServers/1",
                creds.username, creds.password, content=ntp_xml, headers=headers, verify_tls=creds.verify_tls,
            )
            # Best-effort switch to NTP mode; not fatal if it 4xxs (some firmware auto-flips).
            try:
                await _http.request_strict(
                    "PUT", f"{base}/ISAPI/System/time",
                    creds.username, creds.password, content=time_xml, headers=headers, verify_tls=creds.verify_tls,
                )
            except _http.BrandHTTPError:
                pass
            return FleetOpResult(ok=True, detail=f"ntp set to {server}", data={"server": server})
        except _http.BrandHTTPError as exc:
            return FleetOpResult(ok=False, detail=f"set_ntp failed: {exc}")

    async def set_password(
        self, host: str, creds: Credentials, *, user: str, new_password: str
    ) -> FleetOpResult:
        """Resolve the Hik user id for ``user`` via GET /ISAPI/Security/users, then
        PUT /ISAPI/Security/users/{id} with a ``<User>`` body carrying the new password.
        # LIVE-VALIDATE: user-id resolution + password policy + re-auth after change."""
        base = self._base(host, creds)
        # Resolve the numeric user id (ISAPI keys users by id, not name).
        listing = await _http.get_text(f"{base}/ISAPI/Security/users", creds.username, creds.password)
        uid: str | None = None
        for el in _http.xml_findall(listing or "", "User"):
            uname = _http.el_text(el, "userName", "name")
            if uname and uname == user:
                uid = _http.el_text(el, "id")
                break
        if uid is None:
            return FleetOpResult(ok=False, detail=f"user '{user}' not found on device")
        body = (
            f"<User><id>{_xml_escape(uid)}</id><userName>{_xml_escape(user)}</userName>"
            f"<password>{_xml_escape(new_password)}</password></User>"
        )
        try:
            await _http.request_strict(
                "PUT", f"{base}/ISAPI/Security/users/{uid}",
                creds.username, creds.password, content=body,
                headers={"Content-Type": "application/xml"}, verify_tls=creds.verify_tls,
            )
            return FleetOpResult(ok=True, detail=f"password changed for {user}", data={"user": user})
        except _http.BrandHTTPError as exc:
            return FleetOpResult(ok=False, detail=f"set_password failed: {exc}")

    async def backup_config(self, host: str, creds: Credentials) -> ConfigBackup:
        """GET /ISAPI/System/configurationData → the binary device config blob.
        # LIVE-VALIDATE: some firmware wants ?model=... or an encryption secret."""
        blob = await _http.get_bytes(
            f"{self._base(host, creds)}/ISAPI/System/configurationData",
            creds.username, creds.password, verify_tls=creds.verify_tls,
        )
        if not blob:
            return ConfigBackup(supported=False, detail="configurationData unavailable or unreachable")
        return ConfigBackup(
            supported=True, blob=blob, content_type="application/octet-stream",
            filename=f"hikvision-{host}-config.bin", detail="config exported",
        )

    async def restore_config(self, host: str, creds: Credentials, blob: bytes) -> FleetOpResult:
        """PUT /ISAPI/System/configurationData with the previously-exported blob.
        # LIVE-VALIDATE: restore reboots the device; some firmware needs a multipart form."""
        try:
            await _http.request_strict(
                "PUT", f"{self._base(host, creds)}/ISAPI/System/configurationData",
                creds.username, creds.password, content=blob,
                headers={"Content-Type": "application/octet-stream"}, verify_tls=creds.verify_tls,
            )
            return FleetOpResult(ok=True, detail="config restore requested (device will reboot)")
        except _http.BrandHTTPError as exc:
            return FleetOpResult(ok=False, detail=f"restore_config failed: {exc}")

    # ── stream codec policy (G8) — ISAPI per-channel videoCodecType ────────────
    #
    # Hik streams live at ``/ISAPI/Streaming/channels/<id>`` where ``<id>`` = ``ch*100+1``
    # (main) / ``ch*100+2`` (sub). The stream's ``<videoCodecType>`` carries the codec
    # (``H.264`` | ``H.265`` | ``MJPEG``). To force the sub (web) stream to H.264 we GET
    # the sub channel's config, rewrite ``videoCodecType`` → ``H.264``, and PUT it back.
    # # LIVE-VALIDATE: the exact StreamingChannel XML + whether an NVR proxies the sub
    # channel's codec vary by firmware — confirm on a real Hik device/NVR.

    async def get_stream_codecs(self, host: str, creds: Credentials) -> list[StreamCodecProfile]:
        """Read the main (id ``<ch>01``) + sub (id ``<ch>02``) videoCodecType for channel 1.
        Never raises — ``[]`` on unreachable."""
        base = self._base(host, creds)
        out: list[StreamCodecProfile] = []
        for role, stream in (("main", 1), ("sub", 2)):
            cid = _rtsp_channel_id(1, stream)
            body = await _http.get_text(
                f"{base}/ISAPI/Streaming/channels/{cid}", creds.username, creds.password
            )
            if not body:
                continue
            out.append(
                StreamCodecProfile(
                    role=role,
                    codec=_norm_codec(_http.xml_text(body, "videoCodecType")),
                    token=str(cid),
                )
            )
        return out

    async def set_stream_codec(
        self, host: str, creds: Credentials, *, profile: str = "sub", codec: str = "h264"
    ) -> FleetOpResult:
        """Rewrite the ``profile`` (sub/main) channel's ``videoCodecType`` via ISAPI.

        GET ``/ISAPI/Streaming/channels/<id>`` → replace the ``<videoCodecType>`` value →
        PUT it back. Graceful. # LIVE-VALIDATE: a real Hik camera/NVR may require a
        reboot or reject a codec change on a proxied NVR channel."""
        target = _norm_codec(codec) or "H264"
        hik_value = _HIK_CODEC_VALUE.get(target, "H.264")
        stream = {"main": 1, "sub": 2, "third": 3}.get(profile, 2)
        cid = _rtsp_channel_id(1, stream)
        base = self._base(host, creds)
        url = f"{base}/ISAPI/Streaming/channels/{cid}"

        body = await _http.get_text(url, creds.username, creds.password)
        if not body:
            return FleetOpResult(
                ok=False, detail=f"could not read stream channel {cid} (unreachable or no such stream)"
            )
        current = _norm_codec(_http.xml_text(body, "videoCodecType"))
        if current == target:
            return FleetOpResult(
                ok=True, detail=f"{profile} stream already {target}", data={"already": True, "codec": target}
            )
        import re as _re

        new_body, n = _re.subn(
            r"(<videoCodecType>)(.*?)(</videoCodecType>)",
            lambda m: f"{m.group(1)}{hik_value}{m.group(3)}",
            body,
            count=1,
        )
        if n == 0:
            return FleetOpResult(
                ok=False, supported=True,
                detail=f"stream channel {cid} config exposes no videoCodecType to rewrite",
            )
        try:
            await _http.request_strict(
                "PUT", url, creds.username, creds.password,
                content=new_body, headers={"Content-Type": "application/xml"},
                verify_tls=creds.verify_tls,
            )
        except _http.BrandHTTPError as exc:
            return FleetOpResult(ok=False, supported=True, detail=f"device rejected codec change: {exc}")
        return FleetOpResult(
            ok=True, detail=f"{profile} stream set to {target}", data={"codec": target, "channel_id": cid}
        )

    # ── event topic map ───────────────────────────────────────────────────────
    def event_topic_map(self) -> dict[str, tuple[str, str, str]]:
        """Hik ISAPI alarm-stream event types → (event_type, severity, title).

        These are the ``eventType`` strings from the ISAPI ``/ISAPI/Event/notification/
        alertStream`` multipart feed. Ingestion of that stream is P5 (Go nvr); the map
        is provided now so the seam is complete + consistent with the ONVIF driver.

        # LIVE-VALIDATE: exact eventType strings vary by firmware. Confirm against the
        # alertStream feed on a real Hik device before wiring ingestion.
        """
        return {
            "VMD": ("motion_detected", "alarm", "Motion detected"),
            "vmd": ("motion_detected", "alarm", "Motion detected"),
            "shelteralarm": ("camera_tamper", "alarm", "Camera tamper / video tampering"),
            "tamperdetection": ("camera_tamper", "alarm", "Tamper detection"),
            "videoloss": ("video_loss", "critical", "Video signal lost"),
            "linedetection": ("line_crossing", "alarm", "Line crossing detected"),
            "fielddetection": ("zone_intrusion", "alarm", "Intrusion detected"),
            "regionEntrance": ("zone_intrusion", "alarm", "Region entrance"),
            "regionExiting": ("zone_intrusion", "alarm", "Region exiting"),
            "IO": ("digital_input_change", "alarm", "Digital input triggered"),
            "facedetection": ("face_detected", "info", "Face detected"),
            "audioexception": ("audio_alarm", "alarm", "Audio exception detected"),
        }

    # ── NVR footage / playback (P4-B) ─────────────────────────────────────────
    async def search_recordings(
        self,
        host: str,
        creds: Credentials,
        *,
        channel: int | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
    ) -> list[dict[str, Any]]:
        """Hikvision NVR footage search via ISAPI ``POST /ISAPI/ContentMgmt/search``.

        POSTs a ``CMSearchDescription`` (a ``<trackID>`` = ``channel*100+1``, a
        ``<timeSpanList>`` window) and parses the ``CMSearchResult`` → one dict per
        ``searchMatchItem`` with its ``timeSpan`` (start/end) + ``playbackURI``. Never
        raises — ``[]`` on unreachable / no matches.

        # LIVE-VALIDATE: exact tag names (``searchMatchItem`` / ``timeSpan`` /
        # ``playbackURI``) + the ``trackID`` math (main track = channel*100+1) follow
        # Hikvision's published ISAPI spec but vary by firmware/model. Confirm the search
        # XML shape + track-id against a real Hik NVR.
        """
        ch = channel or 1
        track_id = _rtsp_channel_id(ch, 1)  # main track = channel*100+1
        s = _to_hik_time(start_time) or _to_hik_time("1970-01-01T00:00:00Z")
        e = _to_hik_time(end_time) or _to_hik_time("2038-01-01T00:00:00Z")
        # A CMSearchDescription for one track's time window (namespaced per ISAPI spec).
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<CMSearchDescription xmlns="http://www.hikvision.com/ver20/XMLSchema">'
            "<searchID>vms-p4b-search</searchID>"
            "<trackIDList>"
            f"<trackID>{track_id}</trackID>"
            "</trackIDList>"
            "<timeSpanList><timeSpan>"
            f"<startTime>{s}</startTime>"
            f"<endTime>{e}</endTime>"
            "</timeSpan></timeSpanList>"
            "<maxResults>200</maxResults>"
            "<searchResultPostion>0</searchResultPostion>"
            "<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com"
            "</metadataDescriptor></metadataList>"
            "</CMSearchDescription>"
        )
        xml = await _http.post_text(
            f"{self._base(host, creds)}/ISAPI/ContentMgmt/search",
            creds.username, creds.password,
            content=body, headers={"Content-Type": "application/xml"},
            verify_tls=creds.verify_tls,
        )
        if not xml:
            return []
        out: list[dict[str, Any]] = []
        for item in _http.xml_findall(xml, "searchMatchItem"):
            span_start = _http.el_text(item, "startTime")
            span_end = _http.el_text(item, "endTime")
            playback_uri = _http.el_text(item, "playbackURI")
            out.append(
                {
                    "channel": ch,
                    "track_id": track_id,
                    "start_time": span_start,
                    "end_time": span_end,
                    "playback_uri": playback_uri,
                }
            )
        return out

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
        """Build the Hik RTSP playback URI for a channel + [start, end] window.

        Hikvision serves time-addressed playback on the *tracks* endpoint:
        ``rtsp://host:554/Streaming/tracks/<trackID>?starttime=<t>&endtime=<t>`` where
        ``<trackID>`` = ``channel*100+1`` (main track) and the times are the basic
        ISO form ``YYYYMMDDTHHMMSSZ``. Creds are percent-encoded + injected. Returns
        ``None`` when the window is missing. Never raises.

        # LIVE-VALIDATE: the ``Streaming/tracks/<id>`` playback path + ``starttime``/
        # ``endtime`` query params follow the ISAPI RTSP-playback spec; confirm the exact
        # param names + whether the NVR wants ``&name=`` on the owner's Hik NVR.
        """
        from urllib.parse import quote

        ch = channel or 1
        track_id = _rtsp_channel_id(ch, 1)
        st = _to_rtsp_time(start_time)
        et = _to_rtsp_time(end_time)
        if not st or not et:
            return None
        user = quote(creds.username or "", safe="")
        pw = quote(creds.password or "", safe="")
        auth = f"{user}:{pw}@" if creds.username else ""
        return (
            f"rtsp://{auth}{host}:{creds.rtsp_port}/Streaming/tracks/{track_id}"
            f"?starttime={st}&endtime={et}"
        )
