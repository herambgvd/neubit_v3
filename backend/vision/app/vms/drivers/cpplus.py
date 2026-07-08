"""CpPlusDriver — CP-Plus (Dahua-lineage) HTTP-CGI driver (HTTP Digest).

CP-Plus is Dahua-lineage OEM hardware, so it speaks the Dahua HTTP-CGI protocol
(``/cgi-bin/*.cgi`` with ``key=value`` text responses over HTTP Digest). This driver
implements the standard, well-documented Dahua CGI endpoints. CP-Plus devices also
speak ONVIF, so ``OnvifDriver`` remains a valid fallback; this native driver is
preferred because Dahua CGI exposes product/channel definition + snapshot per channel
uniformly.

Dahua/CP-Plus CGI endpoint map (all HTTP Digest, responses are ``key=value`` lines):
  * device info   GET ``/cgi-bin/magicBox.cgi?action=getSystemInfo``      → serial/deviceType.
                  GET ``/cgi-bin/magicBox.cgi?action=getMachineName``       → name.
                  GET ``/cgi-bin/magicBox.cgi?action=getSoftwareVersion``   → firmware.
  * channels      GET ``/cgi-bin/magicBox.cgi?action=getProductDefinition`` → MaxRemoteInputChannels / channel count.
                  GET ``/cgi-bin/devVideoInput.cgi?action=getCollect``      → per-input detail (best-effort).
  * stream URIs   ``rtsp://host:554/cam/realmonitor?channel=<n>&subtype=0`` (main) / ``subtype=1`` (sub).
  * snapshot      GET ``/cgi-bin/snapshot.cgi?channel=<n>``.
  * PTZ           GET ``/cgi-bin/ptz.cgi?action=start&channel=<n>&code=<Up|Down|...>&arg1=&arg2=&arg3=``.
  * NVR footage   ``/cgi-bin/mediaFileFind.cgi`` (Dahua RPC/CGI find)       ← P4, documented stub.

LIVE-VALIDATE: Dahua CGI is well documented, but CP-Plus firmware can rename/relocate
keys (``getProductDefinition`` field names especially) and some CP-Plus SKUs restrict
CGI in favour of ONVIF. All parsing is defensive. Confirm channel-count keys, PTZ code
names, and snapshot channel indexing against the owner's real CP-Plus devices + NVRs —
see the ``# LIVE-VALIDATE:`` markers.
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

log = logging.getLogger("vision.drivers.cpplus")

# Dahua PTZ direction codes (ptz.cgi ``code=`` values). continuous move maps the
# driver's pan/tilt/zoom sign → a Dahua direction code + speed arg.
# LIVE-VALIDATE: code names + which arg carries speed can differ on CP-Plus firmware.
_PTZ_CONTINUOUS_CODES = {
    ("pan", 1): "Right",
    ("pan", -1): "Left",
    ("tilt", 1): "Up",
    ("tilt", -1): "Down",
    ("zoom", 1): "ZoomTele",
    ("zoom", -1): "ZoomWide",
}


def _rtsp_url(host: str, creds: Credentials, channel: int, subtype: int) -> str:
    """Dahua/CP-Plus RTSP: ``/cam/realmonitor?channel=<n>&subtype=<0 main|1 sub>``."""
    from urllib.parse import quote

    user = quote(creds.username or "", safe="")
    pw = quote(creds.password or "", safe="")
    auth = f"{user}:{pw}@" if creds.username else ""
    return f"rtsp://{auth}{host}:{creds.rtsp_port}/cam/realmonitor?channel={channel}&subtype={subtype}"


class CpPlusDriver(CameraDriver):
    """CP-Plus / Dahua HTTP-CGI driver (HTTP Digest). Onboarding + config + PTZ
    implemented; NVR footage search is a documented P4 stub."""

    brand = "cpplus"

    def _base(self, host: str, creds: Credentials) -> str:
        scheme = "https" if creds.verify_tls else "http"
        return f"{scheme}://{host}:{creds.port}"

    # ── discovery ────────────────────────────────────────────────────────────
    async def discover(
        self, network: str | None = None, *, creds: Credentials | None = None, timeout: int = 5
    ) -> list[Discovered]:
        """CP-Plus/Dahua discovery uses ONVIF WS-Discovery (Dahua's native ``ConfigManager``
        multicast is proprietary). Delegates to ``OnvifDriver.discover`` then tags
        ``brand='cpplus'``. Never raises.

        # LIVE-VALIDATE: native Dahua multicast discovery not implemented — ONVIF path used.
        """
        from .onvif import OnvifDriver

        found = await OnvifDriver().discover(network, creds=creds, timeout=timeout)
        for d in found:
            d.brand = "cpplus"
        return found

    # ── probe / identity ─────────────────────────────────────────────────────
    async def probe(self, host: str, creds: Credentials) -> DeviceInfo:
        """magicBox.cgi getSystemInfo + getMachineName + getSoftwareVersion. Never raises."""
        base = self._base(host, creds)
        sysinfo = await _http.get_text(
            f"{base}/cgi-bin/magicBox.cgi?action=getSystemInfo", creds.username, creds.password
        )
        if sysinfo is None:
            return DeviceInfo(reachable=False, error="Dahua CGI getSystemInfo unreachable or auth failed")
        kv = _http.parse_cgi_kv(sysinfo)
        # Keys: deviceType, serialNumber, hardwareVersion (dotted/flat vary by model).
        serial = kv.get("serialNumber") or kv.get("sn")
        model = kv.get("deviceType") or kv.get("updateSerial")

        name_body = await _http.get_text(
            f"{base}/cgi-bin/magicBox.cgi?action=getMachineName", creds.username, creds.password
        )
        machine_name = _http.parse_cgi_kv(name_body or "").get("name")

        ver_body = await _http.get_text(
            f"{base}/cgi-bin/magicBox.cgi?action=getSoftwareVersion", creds.username, creds.password
        )
        firmware = _http.parse_cgi_kv(ver_body or "").get("version")

        info = DeviceInfo(
            reachable=True,
            manufacturer="CP-Plus",
            model=model,
            firmware=firmware,
            serial_number=serial,
            raw={"machine_name": machine_name, **kv},
        )
        # Channel count from product definition (best-effort).
        info.channel_count = await self._channel_count(host, creds)
        return info

    async def _channel_count(self, host: str, creds: Credentials) -> int:
        """getProductDefinition → MaxRemoteInputChannels / VideoInChannels (best-effort).

        # LIVE-VALIDATE: exact key names differ across Dahua/CP-Plus firmware
        # (``MaxRemoteInputChannels`` on NVRs vs ``VideoInputChannels`` on cameras).
        """
        body = await _http.get_text(
            f"{self._base(host, creds)}/cgi-bin/magicBox.cgi?action=getProductDefinition",
            creds.username,
            creds.password,
        )
        kv = _http.parse_cgi_kv(body or "")
        for key in (
            "table.ProductDefinition.MaxRemoteInputChannels",
            "table.ProductDefinition.VideoInChannels",
            "MaxRemoteInputChannels",
            "VideoInChannels",
            "VideoInputChannels",
        ):
            if key in kv:
                try:
                    return int(kv[key])
                except ValueError:
                    continue
        return 0

    # ── channel enumeration ───────────────────────────────────────────────────
    async def enumerate_channels(self, host: str, creds: Credentials) -> list[Channel]:
        """Enumerate channels from the product-definition channel count, building the
        Dahua RTSP URLs per channel. Standalone camera → 1 channel; NVR → N. Never raises.

        # LIVE-VALIDATE: channel numbering is 1-based here (Dahua ``channel=1..N``).
        # Confirm the owner's CP-Plus NVR uses 1-based ``channel=`` in realmonitor.
        """
        count = await self._channel_count(host, creds)
        if count <= 0:
            # Fall back to probing: reachable single-camera → 1 channel.
            info = await self.probe(host, creds)
            count = 1 if info.reachable else 0
        out: list[Channel] = []
        for ch in range(1, count + 1):
            out.append(
                Channel(
                    channel=ch,
                    name=f"Channel {ch}",
                    channel_number=ch,
                    main=StreamInfo(stream_url=_rtsp_url(host, creds, ch, 0)),
                    sub=StreamInfo(stream_url=_rtsp_url(host, creds, ch, 1)),
                    snapshot_url=f"{self._base(host, creds)}/cgi-bin/snapshot.cgi?channel={ch}",
                )
            )
        return out

    # ── stream URIs ──────────────────────────────────────────────────────────
    async def get_stream_uris(
        self, host: str, creds: Credentials, *, profile: str | None = None
    ) -> StreamUris:
        """Build CP-Plus/Dahua RTSP URIs for a channel (``profile`` = channel number).
        Constructed from convention — no device round-trip. Never raises."""
        try:
            channel = int(profile) if profile else 1
        except (TypeError, ValueError):
            channel = 1
        return StreamUris(
            main=_rtsp_url(host, creds, channel, 0),
            sub=_rtsp_url(host, creds, channel, 1),
            media_version=1,
        )

    # ── capability detection ──────────────────────────────────────────────────
    async def get_capabilities(self, host: str, creds: Credentials) -> Capabilities:
        """Probe Dahua CGI capability endpoints. Never raises.

        # LIVE-VALIDATE: capability CGI actions (``getCaps``/``getPTZCameraCaps``) and
        # their response keys vary by model. PTZ presence is inferred from ptz.cgi
        # getCurrentProtocolCaps responding. Confirm on real devices.
        """
        base = self._base(host, creds)
        caps = Capabilities()
        # PTZ probe.
        ptz_body = await _http.get_text(
            f"{base}/cgi-bin/ptz.cgi?action=getCurrentProtocolCaps&channel=1", creds.username, creds.password
        )
        caps.ptz = ptz_body is not None and "error" not in (ptz_body or "").lower()
        # Encode / audio caps.
        enc = await _http.get_text(
            f"{base}/cgi-bin/encode.cgi?action=getCaps", creds.username, creds.password
        )
        if enc:
            low = enc.lower()
            caps.audio = "audio" in low
            caps.raw = {"encode_caps_len": len(enc)}
        # Dahua NVRs expose footage find (mediaFileFind) → recording search available.
        caps.recording_search = True  # LIVE-VALIDATE: assumed; confirm mediaFileFind on NVR.
        caps.imaging = True  # Dahua exposes configManager VideoInOptions (imaging); confirm live.
        return caps

    # ── snapshot ──────────────────────────────────────────────────────────────
    async def get_snapshot(
        self, host: str, creds: Credentials, *, profile: str | None = None
    ) -> bytes | None:
        """GET /cgi-bin/snapshot.cgi?channel=<n> (JPEG). Never raises."""
        try:
            channel = int(profile) if profile else 1
        except (TypeError, ValueError):
            channel = 1
        return await _http.get_bytes(
            f"{self._base(host, creds)}/cgi-bin/snapshot.cgi?channel={channel}", creds.username, creds.password
        )

    # ── PTZ (operator action — raises DriverError) ────────────────────────────
    async def ptz(self, host: str, creds: Credentials, cmd: PtzCommand) -> Any:
        """PTZ via ptz.cgi. Raises ``DriverError`` on failure.

        # LIVE-VALIDATE: Dahua ptz.cgi uses discrete direction codes + start/stop,
        # not a velocity vector. This maps the dominant axis of a continuous command to
        # a direction code; ``stop`` issues action=stop with the same code. Confirm code
        # names + speed args (arg1/arg2) on the owner's CP-Plus PTZ camera.
        """
        base = self._base(host, creds)
        channel = int(cmd.profile_token) if (cmd.profile_token or "").isdigit() else 1
        speed = int(max(1, min(8, round(cmd.speed * 8)))) or 1
        try:
            if cmd.action in ("continuous", "relative", "absolute"):
                code = self._dominant_code(cmd)
                if not code:
                    return None  # zero-vector → no-op
                url = (
                    f"{base}/cgi-bin/ptz.cgi?action=start&channel={channel}"
                    f"&code={code}&arg1=0&arg2={speed}&arg3=0"
                )
                await _http.request_strict("GET", url, creds.username, creds.password, verify_tls=creds.verify_tls)
                return None
            if cmd.action == "stop":
                # Dahua stop repeats the last code with action=stop; a generic Up/stop halts.
                url = f"{base}/cgi-bin/ptz.cgi?action=stop&channel={channel}&code=Up&arg1=0&arg2=0&arg3=0"
                await _http.request_strict("GET", url, creds.username, creds.password, verify_tls=creds.verify_tls)
                return None
            if cmd.action == "goto_preset":
                url = (
                    f"{base}/cgi-bin/ptz.cgi?action=start&channel={channel}"
                    f"&code=GotoPreset&arg1=0&arg2={cmd.preset_token}&arg3=0"
                )
                await _http.request_strict("GET", url, creds.username, creds.password, verify_tls=creds.verify_tls)
                return None
            if cmd.action == "set_preset":
                url = (
                    f"{base}/cgi-bin/ptz.cgi?action=start&channel={channel}"
                    f"&code=SetPreset&arg1=0&arg2={cmd.preset_token or ''}&arg3=0"
                )
                await _http.request_strict("GET", url, creds.username, creds.password, verify_tls=creds.verify_tls)
                return None
            raise DriverError(f"CP-Plus PTZ action not implemented: {cmd.action}")
        except _http.BrandHTTPError as exc:
            raise DriverError(f"CP-Plus PTZ {cmd.action} failed for {host}: {exc}") from None

    @staticmethod
    def _dominant_code(cmd: PtzCommand) -> str | None:
        """Pick the Dahua direction code for the largest-magnitude axis of a PTZ vector."""
        axes = [("pan", cmd.pan), ("tilt", cmd.tilt), ("zoom", cmd.zoom)]
        axis, value = max(axes, key=lambda a: abs(a[1]))
        if value == 0:
            return None
        return _PTZ_CONTINUOUS_CODES.get((axis, 1 if value > 0 else -1))

    # ── configuration (operator action) ──────────────────────────────────────
    async def configure(
        self, host: str, creds: Credentials, section: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Read/write config over Dahua configManager CGI. Raises ``DriverError`` on failure.

        Sections:
          * ``imaging`` — GET/SET ``/cgi-bin/configManager.cgi?action=getConfig&name=VideoInOptions``.
          * ``io``      — GET ``/cgi-bin/configManager.cgi?action=getConfig&name=Alarm``.

        # LIVE-VALIDATE: configManager config names + the setConfig ``key=value`` param
        # form vary by model. Read paths parsed to kv; write is passthrough. Confirm live.
        """
        base = self._base(host, creds)
        if section == "imaging":
            if payload:
                params = "&".join(f"{k}={v}" for k, v in payload.items())
                url = f"{base}/cgi-bin/configManager.cgi?action=setConfig&{params}"
                try:
                    await _http.request_strict("GET", url, creds.username, creds.password, verify_tls=creds.verify_tls)
                except _http.BrandHTTPError as exc:
                    raise DriverError(f"CP-Plus imaging write failed: {exc}") from None
            body = await _http.get_text(
                f"{base}/cgi-bin/configManager.cgi?action=getConfig&name=VideoInOptions",
                creds.username,
                creds.password,
            )
            return _http.parse_cgi_kv(body or "")
        if section == "io":
            body = await _http.get_text(
                f"{base}/cgi-bin/configManager.cgi?action=getConfig&name=Alarm", creds.username, creds.password
            )
            return _http.parse_cgi_kv(body or "")
        raise DriverError(f"unsupported CP-Plus config section: {section}")

    # ── event topic map ───────────────────────────────────────────────────────
    def event_topic_map(self) -> dict[str, tuple[str, str, str]]:
        """Dahua/CP-Plus ``eventManager`` code → (event_type, severity, title).

        These are the ``Code=`` values from the Dahua CGI event stream
        (``/cgi-bin/eventManager.cgi?action=attach&codes=[All]``). Ingestion is P5
        (Go nvr); the map is provided now so the seam is complete.

        # LIVE-VALIDATE: event code strings vary by firmware. Confirm against the
        # eventManager attach stream on a real CP-Plus device.
        """
        return {
            "VideoMotion": ("motion_detected", "alarm", "Motion detected"),
            "VideoBlind": ("camera_tamper", "alarm", "Camera blinded / tampered"),
            "VideoLoss": ("video_loss", "critical", "Video signal lost"),
            "CrossLineDetection": ("line_crossing", "alarm", "Line crossing detected"),
            "CrossRegionDetection": ("zone_intrusion", "alarm", "Intrusion detected"),
            "AlarmLocal": ("digital_input_change", "alarm", "Local alarm input triggered"),
            "FaceDetection": ("face_detected", "info", "Face detected"),
            "AudioMutation": ("audio_alarm", "alarm", "Audio anomaly detected"),
            "AudioAnomaly": ("audio_alarm", "alarm", "Audio anomaly detected"),
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
        """CP-Plus/Dahua NVR footage search.

        # LIVE-VALIDATE: NOT implemented — P4 (footage extraction / playback). The real
        # implementation uses the Dahua ``mediaFileFind`` CGI/RPC lifecycle:
        # ``factory.create`` → ``findFile`` (a ``condition`` with channel + time window)
        # → repeated ``findNextFile`` → ``close``, then builds a playback RTSP URL
        # (``rtsp://host/cam/playback?channel=<n>&starttime=...&endtime=...``). Requires
        # a real CP-Plus NVR to validate the RPC object lifecycle. Returns [] for now.
        """
        log.info("CP-Plus search_recordings is a P4 stub (Dahua mediaFileFind) — returning []")
        return []
