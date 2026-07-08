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
    Credentials,
    DeviceInfo,
    Discovered,
    DriverError,
    PtzCommand,
    StreamInfo,
    StreamUris,
)

log = logging.getLogger("vision.drivers.hikvision")


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


def _rtsp_url(host: str, creds: Credentials, channel: int, stream: int) -> str:
    """Build a Hikvision RTSP URL with creds injected. stream: 1 = main, 2 = sub."""
    from urllib.parse import quote

    cid = _rtsp_channel_id(channel, stream)
    user = quote(creds.username or "", safe="")
    pw = quote(creds.password or "", safe="")
    auth = f"{user}:{pw}@" if creds.username else ""
    return f"rtsp://{auth}{host}:{creds.rtsp_port}/Streaming/Channels/{cid}"


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
            raise DriverError(f"Hikvision PTZ action not implemented: {cmd.action}")
        except _http.BrandHTTPError as exc:
            raise DriverError(f"Hikvision PTZ {cmd.action} failed for {host}: {exc}") from None

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
        raise DriverError(f"unsupported Hikvision config section: {section}")

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

    # ── NVR footage / playback (P4 — documented stub) ─────────────────────────
    async def search_recordings(
        self,
        host: str,
        creds: Credentials,
        *,
        channel: int | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
    ) -> list[dict[str, Any]]:
        """Hikvision NVR footage search via ISAPI ContentMgmt.

        # LIVE-VALIDATE: NOT implemented — P4 (footage extraction / playback). The real
        # implementation POSTs a ``CMSearchDescription`` to
        # ``/ISAPI/ContentMgmt/search`` (a ``<trackID>`` = channel*100+1, a
        # ``<timeSpanList>`` window) and parses ``<matchList>`` → playbackURI
        # (``rtsp://host/Streaming/tracks/<id>?starttime=...&endtime=...``). Requires a
        # real Hik NVR to validate the search XML + track-id math. Returns [] for now.
        """
        log.info("Hikvision search_recordings is a P4 stub (ISAPI ContentMgmt/search) — returning []")
        return []
