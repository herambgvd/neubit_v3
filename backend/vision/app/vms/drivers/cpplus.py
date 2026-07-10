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


# Dahua privacy/motion regions ride an 8192x8192 normalized grid in configManager.
_DAHUA_GRID = 8192


def _region_shapes(payload: dict[str, Any] | None, key: str) -> list[dict[str, Any]]:
    """Extract the normalized (0..1) shape list from a ``{key: [...]}`` config payload."""
    if not payload:
        return []
    shapes = payload.get(key)
    if shapes is None and isinstance(payload, list):
        shapes = payload
    return list(shapes or [])


def _shape_bbox_grid(shape: dict[str, Any], grid: int) -> tuple[int, int, int, int]:
    """Normalized (0..1) shape → integer bounding box ``(x0,y0,x1,y1)`` on a grid.

    Rect ``{x,y,w,h}`` maps directly; polygon ``{points:[...]}`` collapses to its
    axis-aligned bounding box (Dahua covers/windows are rectangular).
    """
    pts = shape.get("points")
    if pts:
        xs = [float(p[0]) for p in pts]
        ys = [float(p[1]) for p in pts]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    else:
        x0, y0 = float(shape.get("x", 0.0)), float(shape.get("y", 0.0))
        x1, y1 = x0 + float(shape.get("w", 0.0)), y0 + float(shape.get("h", 0.0))

    def _g(v: float) -> int:
        return max(0, min(grid, round(v * grid)))

    return _g(x0), _g(y0), _g(x1), _g(y1)


def _rtsp_url(host: str, creds: Credentials, channel: int, subtype: int) -> str:
    """Dahua/CP-Plus RTSP: ``/cam/realmonitor?channel=<n>&subtype=<0 main|1 sub>``."""
    from urllib.parse import quote

    user = quote(creds.username or "", safe="")
    pw = quote(creds.password or "", safe="")
    auth = f"{user}:{pw}@" if creds.username else ""
    return f"rtsp://{auth}{host}:{creds.rtsp_port}/cam/realmonitor?channel={channel}&subtype={subtype}"


def _to_dahua_time(iso: str | None) -> str | None:
    """Normalise an ISO-8601 time to Dahua's ``YYYY-MM-DD HH:MM:SS`` (space-separated, UTC).

    Dahua ``mediaFileFind`` conditions + the ``/cam/playback`` RTSP ``starttime``/
    ``endtime`` both use this human form (URL-encoded on the RTSP query). Returns None on
    unparseable input."""
    if not iso:
        return None
    from datetime import datetime, timezone

    try:
        s = str(iso).strip().replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, TypeError):
        return None


def _to_dahua_rtsp_time(iso: str | None) -> str | None:
    """Dahua RTSP playback ``starttime``/``endtime`` use ``YYYY_MM_DD_HH_MM_SS``."""
    human = _to_dahua_time(iso)
    if not human:
        return None
    # 2026-07-09 10:00:00 → 2026_07_09_10_00_00
    return human.replace("-", "_").replace(" ", "_").replace(":", "_")


def _parse_dahua_find_items(body: str, channel: int) -> list[dict[str, Any]]:
    """Parse Dahua ``findNextFile`` ``key=value`` text → one dict per ``items[i]``.

    Dahua returns ``items[0].StartTime=2026-07-09 10:00:00`` / ``items[0].EndTime=...`` /
    ``items[0].FilePath=/mnt/...`` (one line per field). We group by the ``items[<i>]``
    index and emit start/end/file_path per file. Namespace-agnostic + defensive.
    """
    kv = _http.parse_cgi_kv(body)
    by_index: dict[int, dict[str, str]] = {}
    for key, value in kv.items():
        if not key.startswith("items["):
            continue
        try:
            idx = int(key[len("items["):].split("]", 1)[0])
        except (ValueError, IndexError):
            continue
        field = key.split(".", 1)[1] if "." in key else key
        by_index.setdefault(idx, {})[field] = value
    out: list[dict[str, Any]] = []
    for idx in sorted(by_index):
        fields = by_index[idx]
        out.append(
            {
                "channel": channel,
                "start_time": fields.get("StartTime"),
                "end_time": fields.get("EndTime"),
                "file_path": fields.get("FilePath"),
            }
        )
    return out


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
            if cmd.action == "zoom":
                # Zoom-only: pick ZoomTele (in) / ZoomWide (out) by sign of cmd.zoom.
                code = _PTZ_CONTINUOUS_CODES.get(("zoom", 1 if cmd.zoom >= 0 else -1))
                if not code:
                    return None
                url = (
                    f"{base}/cgi-bin/ptz.cgi?action=start&channel={channel}"
                    f"&code={code}&arg1=0&arg2={speed}&arg3=0"
                )
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
                # Dahua preset ids are numeric slots (arg2). The caller supplies the slot in
                # ``preset_token``; if omitted, pick the next free slot from getPtzPresetInfo.
                pid = cmd.preset_token or str(await self._next_preset_id(base, channel, creds))
                url = (
                    f"{base}/cgi-bin/ptz.cgi?action=start&channel={channel}"
                    f"&code=SetPreset&arg1=0&arg2={pid}&arg3=0"
                )
                await _http.request_strict("GET", url, creds.username, creds.password, verify_tls=creds.verify_tls)
                return str(pid)
            if cmd.action == "delete_preset":
                url = (
                    f"{base}/cgi-bin/ptz.cgi?action=start&channel={channel}"
                    f"&code=ClearPreset&arg1=0&arg2={cmd.preset_token}&arg3=0"
                )
                await _http.request_strict("GET", url, creds.username, creds.password, verify_tls=creds.verify_tls)
                return None
            if cmd.action == "get_presets":
                # configManager getPtzPresetInfo → parse ``preset[N].Name=...`` kv lines.
                body = await _http.get_text(
                    f"{base}/cgi-bin/ptz.cgi?action=getPresets&channel={channel}",
                    creds.username, creds.password,
                )
                return self._parse_presets(body or "")
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

    @staticmethod
    def _parse_presets(body: str) -> list[dict]:
        """Parse Dahua getPresets kv output (``presets[N].Index=..`` / ``.Name=..``).

        # LIVE-VALIDATE: the exact kv keys vary by model/firmware; parsed defensively.
        """
        by_idx: dict[str, dict] = {}
        for line in body.splitlines():
            line = line.strip()
            if "=" not in line or "[" not in line:
                continue
            key, _, val = line.partition("=")
            # e.g. presets[0].Index / presets[0].Name
            try:
                idx = key[key.index("[") + 1 : key.index("]")]
            except ValueError:
                continue
            entry = by_idx.setdefault(idx, {})
            if key.endswith(".Index"):
                entry["token"] = val.strip()
            elif key.endswith(".Name"):
                entry["name"] = val.strip()
        out = []
        for idx, entry in sorted(by_idx.items(), key=lambda kv: kv[0]):
            token = entry.get("token") or idx
            out.append({"token": str(token), "name": entry.get("name") or f"preset {token}"})
        return out

    async def _next_preset_id(self, base: str, channel: int, creds: Credentials) -> int:
        """Pick the next free Dahua preset slot (1..255) from the current preset list."""
        try:
            body = await _http.get_text(
                f"{base}/cgi-bin/ptz.cgi?action=getPresets&channel={channel}",
                creds.username, creds.password,
            )
            used = set()
            for p in self._parse_presets(body or ""):
                try:
                    used.add(int(p["token"]))
                except (KeyError, TypeError, ValueError):
                    continue
            for candidate in range(1, 256):
                if candidate not in used:
                    return candidate
        except Exception:  # noqa: BLE001
            pass
        return 1

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
        if section == "privacy_masks":
            return await self._configure_privacy_masks(base, creds, payload)
        if section == "motion_zones":
            return await self._configure_motion_zones(base, creds, payload)
        raise DriverError(f"unsupported CP-Plus config section: {section}")

    # ── privacy / motion region push (Dahua configManager CGI) ────────────────
    async def _configure_privacy_masks(
        self, base: str, creds: Credentials, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Push privacy masks (Dahua "covers") via ``configManager.cgi?name=VideoWidget``.

        Dahua covers are axis-aligned rectangles on an 8192x8192 grid. Normalized rects
        map directly; polygons collapse to their bounding box. Read = getConfig.

        # LIVE-VALIDATE: the exact Covers[ch][n] key path (VideoWidget vs Privacy) + the
        # 8192 grid vary by model/firmware — confirm on a real CP-Plus/Dahua device.
        """
        ch = int((payload or {}).get("channel", 0))
        shapes = _region_shapes(payload, "privacy_masks")
        if shapes:
            params = [f"VideoWidget[{ch}].Covers.Enable=true"]
            for i, s in enumerate(shapes):
                x0, y0, x1, y1 = _shape_bbox_grid(s, _DAHUA_GRID)
                p = f"VideoWidget[{ch}].Covers[{i}]"
                params += [f"{p}.EncodeBlend=true", f"{p}.Rect[0]={x0}", f"{p}.Rect[1]={y0}", f"{p}.Rect[2]={x1}", f"{p}.Rect[3]={y1}"]
            url = f"{base}/cgi-bin/configManager.cgi?action=setConfig&" + "&".join(params)
            try:
                await _http.request_strict("GET", url, creds.username, creds.password, verify_tls=creds.verify_tls)
            except _http.BrandHTTPError as exc:
                raise DriverError(f"CP-Plus privacy-mask write failed: {exc}") from None
        body = await _http.get_text(
            f"{base}/cgi-bin/configManager.cgi?action=getConfig&name=VideoWidget", creds.username, creds.password
        )
        return {"applied": bool(shapes), "count": len(shapes), **_http.parse_cgi_kv(body or "")}

    async def _configure_motion_zones(
        self, base: str, creds: Credentials, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Push motion regions via ``configManager.cgi?name=MotionDetect``.

        Dahua motion detection uses a per-region cell bitmask (``Region[i]`` = a row of
        column-bits over a 22x18 / 32x24 grid). We enable detection + set the region's
        bounding window as a best-effort; full per-cell bitmask packing is deferred.

        # LIVE-VALIDATE: MotionDetect[ch].Region bitmask packing (row-major hex per row)
        # vs the window form + grid dimensions vary by model — confirm on a real device.
        """
        ch = int((payload or {}).get("channel", 0))
        shapes = _region_shapes(payload, "motion_zones")
        if shapes:
            params = [f"MotionDetect[{ch}].Enable=true", f"MotionDetect[{ch}].DetectVersion=V3.0"]
            for i, s in enumerate(shapes):
                x0, y0, x1, y1 = _shape_bbox_grid(s, _DAHUA_GRID)
                p = f"MotionDetect[{ch}].Window[{i}]"
                params += [f"{p}.Id={i}", f"{p}.Name=Zone{i}", f"{p}.Threshold=5", f"{p}.Sensitive=3",
                           f"{p}.Rect[0]={x0}", f"{p}.Rect[1]={y0}", f"{p}.Rect[2]={x1}", f"{p}.Rect[3]={y1}"]
            url = f"{base}/cgi-bin/configManager.cgi?action=setConfig&" + "&".join(params)
            try:
                await _http.request_strict("GET", url, creds.username, creds.password, verify_tls=creds.verify_tls)
            except _http.BrandHTTPError as exc:
                raise DriverError(f"CP-Plus motion-region write failed: {exc}") from None
        body = await _http.get_text(
            f"{base}/cgi-bin/configManager.cgi?action=getConfig&name=MotionDetect", creds.username, creds.password
        )
        return {"applied": bool(shapes), "count": len(shapes), **_http.parse_cgi_kv(body or "")}

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
        """CP-Plus/Dahua NVR footage search via the ``mediaFileFind`` CGI lifecycle.

        Dahua CGI exposes a stateful find: ``factory.create`` → ``findFile`` (a
        ``condition`` with the channel + time window) → repeated ``findNextFile`` → the
        ``close``. Each ``findNextFile`` response is ``key=value`` text with
        ``items[i].StartTime`` / ``items[i].EndTime`` / ``items[i].FilePath``. We create
        one finder, page results, parse the items, and always close the finder. Never
        raises — ``[]`` on unreachable / no matches.

        # LIVE-VALIDATE: the ``mediaFileFind`` CGI object lifecycle + condition param
        # names (``condition.Channel`` / ``condition.StartTime`` / ``condition.EndTime``)
        # + item key layout (``items[0].StartTime``) follow the Dahua HTTP-API spec but
        # vary by CP-Plus firmware. Confirm the full create→find→next→close flow against
        # a real CP-Plus NVR.
        """
        from urllib.parse import quote as _q

        base = self._base(host, creds)
        ch = channel or 1
        s = _to_dahua_time(start_time) or _to_dahua_time("1970-01-01T00:00:00Z")
        e = _to_dahua_time(end_time) or _to_dahua_time("2038-01-01T00:00:00Z")

        # 1) create a finder object → ``result=<objectId>``.
        create_body = await _http.get_text(
            f"{base}/cgi-bin/mediaFileFind.cgi?action=factory.create",
            creds.username, creds.password,
        )
        finder = _http.parse_cgi_kv(create_body or "").get("result")
        if not finder:
            return []

        out: list[dict[str, Any]] = []
        try:
            # 2) start the find with the channel + time-window condition.
            find_url = (
                f"{base}/cgi-bin/mediaFileFind.cgi?action=findFile&object={finder}"
                f"&condition.Channel={ch}"
                f"&condition.StartTime={_q(s, safe='')}"
                f"&condition.EndTime={_q(e, safe='')}"
            )
            started = await _http.get_text(find_url, creds.username, creds.password)
            if started is None:
                return []
            # 3) page results (findNextFile count=100) until exhausted / a page is empty.
            for _page in range(20):  # bound: 20 * 100 = 2000 files max
                page_body = await _http.get_text(
                    f"{base}/cgi-bin/mediaFileFind.cgi?action=findNextFile"
                    f"&object={finder}&count=100",
                    creds.username, creds.password,
                )
                items = _parse_dahua_find_items(page_body or "", ch)
                out.extend(items)
                found = _http.parse_cgi_kv(page_body or "").get("found")
                try:
                    if not items or (found is not None and int(found) < 100):
                        break
                except ValueError:
                    break
        finally:
            # 4) always close the finder object (best-effort).
            await _http.get_text(
                f"{base}/cgi-bin/mediaFileFind.cgi?action=close&object={finder}",
                creds.username, creds.password,
            )
            await _http.get_text(
                f"{base}/cgi-bin/mediaFileFind.cgi?action=destroy&object={finder}",
                creds.username, creds.password,
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
        """Build the Dahua/CP-Plus RTSP playback URI for a channel + [start, end] window.

        Dahua serves time-addressed playback at
        ``rtsp://host:554/cam/playback?channel=<n>&starttime=<t>&endtime=<t>`` where the
        times are URL-encoded ``YYYY_MM_DD_HH_MM_SS`` (Dahua's RTSP time form). Creds are
        percent-encoded + injected. Returns ``None`` when the window is missing. Never raises.

        # LIVE-VALIDATE: the ``/cam/playback`` path + ``starttime``/``endtime`` param
        # names + the ``YYYY_MM_DD_HH_MM_SS`` time form follow the Dahua RTSP-playback
        # spec; confirm against the owner's real CP-Plus NVR.
        """
        from urllib.parse import quote

        ch = channel or 1
        st = _to_dahua_rtsp_time(start_time)
        et = _to_dahua_rtsp_time(end_time)
        if not st or not et:
            return None
        user = quote(creds.username or "", safe="")
        pw = quote(creds.password or "", safe="")
        auth = f"{user}:{pw}@" if creds.username else ""
        return (
            f"rtsp://{auth}{host}:{creds.rtsp_port}/cam/playback"
            f"?channel={ch}&starttime={st}&endtime={et}"
        )
