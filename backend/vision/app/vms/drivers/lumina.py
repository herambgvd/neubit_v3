"""LuminaDriver — faithful port of neubit_v2's REAL Lumina HTTP-API integration.

Lumina is NOT ONVIF here — neubit_v2 ships a dedicated Lumina HTTP client. This driver
ports that integration verbatim (logic-faithful), adapted to the ``CameraDriver``
interface. It is NOT an ONVIF subclass.

Ported from neubit_v2:
  * ``backend/vision/app/integrations/lumina/plugin.py`` — the vision-side HTTP plugin
    (the surface that maps 1:1 onto CameraDriver): ``test_connection`` (GET
    ``/api/v1/system/info``, DigestAuth) → ``probe``; ``fetch_capabilities`` (GET
    ``/api/v1/media/profiles`` + ``/api/v1/ptz/capabilities``) → ``get_capabilities`` +
    ``enumerate_channels`` + ``get_stream_uris``; ``snapshot`` (GET
    ``/api/v1/media/snapshot?channel=``) → ``get_snapshot``; ``ptz`` (POST
    ``/api/v1/ptz/control`` JSON) → ``ptz``. Base ``http://{ip}:{port}``, all
    ``httpx.DigestAuth``.
  * ``backend/platform/app/integrations/lumina/client.py`` + ``wrappers.py`` +
    ``capabilities.py`` — the richer ``/API/...`` JSON-envelope control surface
    (``/API/Web/Login`` + CSRF, ``/API/ChannelConfig/Color/*`` imaging, PBKDF2
    secondary-auth reboot). The vision plugin surface is the primary port; the
    ``/API/...`` control paths are referenced in ``configure`` where the platform
    client is the source of truth.
  * ``backend/platform/app/integrations/lumina/formats/cap/motion.json`` — the
    device-level motion event → mapped into ``event_topic_map()``. The AI-analytics
    formats (``frs`` face-recognition, ``lp`` license-plate, ``fd`` face-detect,
    ``sod`` smart-object, ``lcd`` line-crossing) are OUT of VMS scope (no AI) — noted
    as a future AI event source, NOT wired here.

Same discipline as the other drivers: async, ``httpx.DigestAuth``, graceful on
unreachable host (read methods return empty/None; ``ptz``/``configure`` raise
``DriverError``). Creds arrive decrypted in-memory only.

LIVE-VALIDATE: the vision plugin's REST endpoints (``/api/v1/system/info``,
``/api/v1/media/profiles``, ``/api/v1/ptz/capabilities``, ``/api/v1/media/snapshot``,
``/api/v1/ptz/control``) come straight from v2's plugin but were themselves
"mirrored from v1" and may not be exercised against every Lumina firmware. The
``/API/...`` control surface (client.py) is the more-battle-tested one. Confirm which
endpoint family the owner's real Lumina devices expose — see ``# LIVE-VALIDATE:`` markers.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

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

log = logging.getLogger("vision.drivers.lumina")

DEFAULT_TIMEOUT = 10.0

# Lumina RTSP is not returned by /system/info; the plugin surfaces rtsp_url per media
# profile. When absent, fall back to Lumina's documented RTSP path convention.
# LIVE-VALIDATE: confirm the RTSP path template on the owner's Lumina device.
_LUMINA_RTSP_TEMPLATE = "rtsp://{auth}{host}:{rtsp_port}/live/ch{channel}/{stream}"


def _auth(creds: Credentials) -> httpx.DigestAuth:
    return httpx.DigestAuth(creds.username or "admin", creds.password or "")


def _base(host: str, creds: Credentials) -> str:
    scheme = "https" if creds.verify_tls else "http"
    return f"{scheme}://{host}:{creds.port}"


def _rtsp_from_profile(host: str, creds: Credentials, channel: int, stream: str, rtsp_path: str | None) -> str | None:
    """Prefer the device-reported rtsp_url; else build from the path convention."""
    from urllib.parse import quote

    if rtsp_path:
        # Device gave an explicit RTSP url — inject creds if it lacks them.
        if "://" in rtsp_path and "@" not in rtsp_path.split("://", 1)[1].split("/")[0] and creds.username:
            proto, rest = rtsp_path.split("://", 1)
            return f"{proto}://{quote(creds.username, safe='')}:{quote(creds.password or '', safe='')}@{rest}"
        return rtsp_path
    user = quote(creds.username or "", safe="")
    pw = quote(creds.password or "", safe="")
    auth = f"{user}:{pw}@" if creds.username else ""
    return _LUMINA_RTSP_TEMPLATE.format(auth=auth, host=host, rtsp_port=creds.rtsp_port, channel=channel, stream=stream)


class LuminaDriver(CameraDriver):
    """Lumina HTTP-API driver (ported from neubit_v2). NOT ONVIF."""

    brand = "lumina"

    async def _get_json(self, url: str, creds: Credentials) -> tuple[int, dict[str, Any]]:
        """GET → (status, json) with DigestAuth. Never raises — (0, {}) on transport error."""
        try:
            async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, verify=creds.verify_tls) as c:
                r = await c.get(url, auth=_auth(creds))
            try:
                return r.status_code, (r.json() if r.status_code == 200 else {})
            except Exception:  # noqa: BLE001
                return r.status_code, {}
        except Exception as exc:  # noqa: BLE001
            log.debug("Lumina GET %s failed: %s", url, exc)
            return 0, {}

    # ── discovery ────────────────────────────────────────────────────────────
    async def discover(
        self, network: str | None = None, *, creds: Credentials | None = None, timeout: int = 5
    ) -> list[Discovered]:
        """Lumina has no documented LAN-broadcast discovery in the v2 integration.
        Fall back to ONVIF WS-Discovery / subnet-scan (many Lumina devices also answer
        ONVIF), tagging results ``brand='lumina'``. Never raises.

        # LIVE-VALIDATE: v2 had NO Lumina discovery — this uses the ONVIF path as a
        # best-effort. Confirm whether Lumina devices appear via ONVIF on the owner's LAN
        # (if not, onboard by IP manually and probe over the HTTP API).
        """
        from .onvif import OnvifDriver

        found = await OnvifDriver().discover(network, creds=creds, timeout=timeout)
        for d in found:
            d.brand = "lumina"
        return found

    # ── probe / identity (v2 plugin.test_connection + /system/info) ───────────
    async def probe(self, host: str, creds: Credentials) -> DeviceInfo:
        """GET /api/v1/system/info (DigestAuth). Ported from v2 ``plugin.test_connection``
        + the ``fetch_capabilities`` system-info read. Never raises."""
        status, info = await self._get_json(f"{_base(host, creds)}/api/v1/system/info", creds)
        if status != 200:
            return DeviceInfo(
                reachable=False,
                error=f"Lumina /api/v1/system/info returned {status or 'no response'}",
            )
        return DeviceInfo(
            reachable=True,
            manufacturer=info.get("manufacturer") or "Lumina",
            model=info.get("model") or info.get("device_model"),
            firmware=info.get("firmware") or info.get("firmware_version"),
            serial_number=info.get("serial") or info.get("serial_number"),
            mac=info.get("mac") or info.get("mac_address"),
            channel_count=int(info.get("channels", 0) or 0),
            raw=info,
        )

    # ── capabilities (v2 plugin.fetch_capabilities) ───────────────────────────
    async def _fetch_capabilities(self, host: str, creds: Credentials) -> dict[str, Any]:
        """Port of v2 ``plugin.fetch_capabilities`` — returns the canonical envelope
        ``{service_capabilities, ptz_capabilities, media_profiles}``. Never raises."""
        services = {"device": True, "media": True, "ptz": False, "brand_api": True}
        ptz_caps = {"supported": False, "presets": False, "preset_count": 0}
        media_profiles: list[dict[str, Any]] = []
        base = _base(host, creds)

        _status, _info = await self._get_json(f"{base}/api/v1/system/info", creds)

        status, profiles = await self._get_json(f"{base}/api/v1/media/profiles", creds)
        if status == 200:
            for p in profiles.get("profiles", []):
                media_profiles.append(
                    {
                        "name": p.get("name", "main"),
                        "token": p.get("token"),
                        "stream_type": p.get("stream_type", "main"),
                        "resolution": p.get("resolution", "Unknown"),
                        "codec": (p.get("codec") or "H264").upper(),
                        "fps": int(p.get("fps", 25)),
                        "bitrate": p.get("bitrate"),
                        "rtsp_path": p.get("rtsp_url"),
                        "audio_available": bool(p.get("audio")),
                    }
                )

        status, ptz_data = await self._get_json(f"{base}/api/v1/ptz/capabilities", creds)
        if status == 200:
            services["ptz"] = bool(ptz_data.get("supported"))
            ptz_caps.update(
                {
                    "supported": bool(ptz_data.get("supported")),
                    "presets": bool(ptz_data.get("presets")),
                    "preset_count": int(ptz_data.get("preset_count", 0)),
                    "absolute": bool(ptz_data.get("absolute")),
                    "continuous": bool(ptz_data.get("continuous")),
                }
            )

        return {"service_capabilities": services, "ptz_capabilities": ptz_caps, "media_profiles": media_profiles}

    async def get_capabilities(self, host: str, creds: Credentials) -> Capabilities:
        """Map the v2 capability envelope → the driver ``Capabilities`` matrix. Never raises."""
        env = await self._fetch_capabilities(host, creds)
        svc = env["service_capabilities"]
        profiles = env["media_profiles"]
        return Capabilities(
            ptz=bool(svc.get("ptz")),
            imaging=True,  # Lumina exposes /API/ChannelConfig/Color/* (platform client) — LIVE-VALIDATE.
            events=True,  # motion via device event stream (see event_topic_map) — LIVE-VALIDATE.
            audio=any(p.get("audio_available") for p in profiles),
            services=["lumina_brand_api"],
            raw=env,
        )

    # ── channel enumeration (media profiles → channels) ───────────────────────
    async def enumerate_channels(self, host: str, creds: Credentials) -> list[Channel]:
        """Group Lumina media profiles into channels (main/sub by ``stream_type``).
        Ported from v2 ``fetch_capabilities`` media_profiles. Standalone camera → 1
        channel; if the device reports a channel count > profiles, synthesize channels
        with the RTSP template. Never raises.

        # LIVE-VALIDATE: v2's plugin returned a flat profile list with no channel index —
        # this treats each stream_type as main/sub of a single channel. Confirm how a
        # multi-channel Lumina NVR groups profiles (per-channel token prefix?).
        """
        env = await self._fetch_capabilities(host, creds)
        profiles = env["media_profiles"]
        if not profiles:
            # No profiles → fall back to a single channel via the RTSP template if reachable.
            info = await self.probe(host, creds)
            if not info.reachable:
                return []
            return [
                Channel(
                    channel=1,
                    name="Channel 1",
                    channel_number=1,
                    main=StreamInfo(stream_url=_rtsp_from_profile(host, creds, 1, "main", None)),
                    sub=StreamInfo(stream_url=_rtsp_from_profile(host, creds, 1, "sub", None)),
                    snapshot_url=f"{_base(host, creds)}/api/v1/media/snapshot?channel=1",
                )
            ]

        main = next((p for p in profiles if p.get("stream_type") == "main"), profiles[0])
        sub = next((p for p in profiles if p.get("stream_type") == "sub"), None)

        def _si(p: dict[str, Any] | None, stream: str) -> StreamInfo | None:
            if not p:
                return None
            return StreamInfo(
                profile_token=p.get("token"),
                stream_url=_rtsp_from_profile(host, creds, 1, stream, p.get("rtsp_path")),
                resolution=p.get("resolution") if p.get("resolution") != "Unknown" else None,
                fps=p.get("fps"),
                codec=p.get("codec"),
                bitrate=p.get("bitrate"),
            )

        return [
            Channel(
                channel=1,
                name=main.get("name") or "Channel 1",
                channel_number=1,
                main=_si(main, "main"),
                sub=_si(sub, "sub"),
                snapshot_url=f"{_base(host, creds)}/api/v1/media/snapshot?channel=1",
                ptz_capable=bool(env["service_capabilities"].get("ptz")),
            )
        ]

    # ── stream URIs ──────────────────────────────────────────────────────────
    async def get_stream_uris(
        self, host: str, creds: Credentials, *, profile: str | None = None
    ) -> StreamUris:
        """Return main + sub RTSP from Lumina media profiles (v2 rtsp_url) or template.
        Never raises."""
        env = await self._fetch_capabilities(host, creds)
        profiles = env["media_profiles"]
        main = next((p for p in profiles if p.get("stream_type") == "main"), profiles[0] if profiles else None)
        sub = next((p for p in profiles if p.get("stream_type") == "sub"), None)
        return StreamUris(
            main=_rtsp_from_profile(host, creds, 1, "main", main.get("rtsp_path") if main else None),
            sub=_rtsp_from_profile(host, creds, 1, "sub", sub.get("rtsp_path") if sub else None),
            codec=(main.get("codec") if main else None),
            media_version=1,
        )

    # ── snapshot (v2 plugin.snapshot) ─────────────────────────────────────────
    async def get_snapshot(
        self, host: str, creds: Credentials, *, profile: str | None = None
    ) -> bytes | None:
        """GET /api/v1/media/snapshot?channel=<n> (DigestAuth). Ported from v2
        ``plugin.snapshot``. Never raises."""
        try:
            channel = int(profile) if profile else 1
        except (TypeError, ValueError):
            channel = 1
        try:
            async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, verify=creds.verify_tls) as c:
                r = await c.get(
                    f"{_base(host, creds)}/api/v1/media/snapshot",
                    params={"channel": channel},
                    auth=_auth(creds),
                )
            if r.status_code == 200 and r.content:
                return r.content
            return None
        except Exception as exc:  # noqa: BLE001
            log.debug("Lumina snapshot failed for %s: %s", host, exc)
            return None

    # ── PTZ (v2 plugin.ptz — POST /api/v1/ptz/control) ────────────────────────
    async def ptz(self, host: str, creds: Credentials, cmd: PtzCommand) -> Any:
        """POST /api/v1/ptz/control (JSON body). Ported from v2 ``plugin.ptz``. Raises
        ``DriverError`` on failure. Maps the driver's PtzCommand → v2's action strings:
        ``continuous``→``continuous_move``, ``absolute``→``absolute_move``,
        ``goto_preset``→``preset_goto``, ``stop``→``stop``.

        # LIVE-VALIDATE: v2's plugin used action strings ``continuous_move`` /
        # ``absolute_move`` / ``preset_goto`` / ``stop`` with pan/tilt/zoom/speed floats.
        # The platform ``wrappers.ptz`` used a DIFFERENT surface (``CH<N>`` + ``up/down/
        # left/right/preset`` on ``/API/ChannelConfig/PTZ/Set``). Confirm which the
        # owner's device speaks.
        """
        action_map = {
            "continuous": "continuous_move",
            "relative": "continuous_move",
            "absolute": "absolute_move",
            "stop": "stop",
            "goto_preset": "preset_goto",
        }
        v2_action = action_map.get(cmd.action)
        if not v2_action:
            raise DriverError(f"Lumina PTZ action not supported: {cmd.action}")

        channel = int(cmd.profile_token) if (cmd.profile_token or "").isdigit() else 1
        body: dict[str, Any] = {"channel": channel, "action": v2_action}
        if v2_action in ("absolute_move", "continuous_move"):
            body.update({"pan": cmd.pan, "tilt": cmd.tilt, "zoom": cmd.zoom, "speed": cmd.speed})
        elif v2_action == "preset_goto":
            body.update({"preset_token": cmd.preset_token, "speed": cmd.speed})

        try:
            async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, verify=creds.verify_tls) as c:
                r = await c.post(f"{_base(host, creds)}/api/v1/ptz/control", json=body, auth=_auth(creds))
            if r.status_code >= 400:
                raise DriverError(f"Lumina PTZ {cmd.action} HTTP {r.status_code}: {r.text[:200]}")
            return None
        except DriverError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise DriverError(f"Lumina PTZ {cmd.action} failed for {host}: {exc}") from None

    # ── configuration (v2 platform wrappers /API/ChannelConfig/*) ─────────────
    async def configure(
        self, host: str, creds: Credentials, section: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Read/write config via Lumina's ``/API/...`` JSON-envelope control surface
        (platform ``client.py`` + ``wrappers.py`` + ``capabilities.py``). Raises
        ``DriverError`` on failure.

        Sections (v2 platform ``CAPABILITY_MAP`` → wrappers):
          * ``imaging`` — ``/API/ChannelConfig/Color/Get`` | ``/Color/Set``.
          * ``osd``     — ``/API/ChannelConfig/OSD/Get`` | ``/OSD/Set``.

        The v2 control surface authenticates via ``/API/Web/Login`` + CSRF header (see
        ``client.py``). This driver uses the simpler DigestAuth POST — sufficient for the
        Color/OSD reads/writes; the full Login+CSRF+PBKDF2 flow (needed only for
        privileged ops like reboot) is deferred until a real device is available.

        # LIVE-VALIDATE: whether Color/OSD accept DigestAuth directly or REQUIRE the
        # /API/Web/Login session + X-csrftoken (client.py). If they require the session,
        # port the full LuminaClient.call() login flow here.
        """
        section_paths = {
            "imaging": ("/API/ChannelConfig/Color/Get", "/API/ChannelConfig/Color/Set"),
            "osd": ("/API/ChannelConfig/OSD/Get", "/API/ChannelConfig/OSD/Set"),
        }
        if section not in section_paths:
            raise DriverError(f"unsupported Lumina config section: {section}")
        get_path, set_path = section_paths[section]
        channel = payload.pop("channel", "CH1") if payload else "CH1"
        ch_str = channel if str(channel).upper().startswith("CH") else f"CH{channel}"

        try:
            async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, verify=creds.verify_tls) as c:
                if payload:
                    body = {"version": "1.0", "data": {"channel": ch_str, **payload}}
                    w = await c.post(f"{_base(host, creds)}{set_path}", json=body, auth=_auth(creds))
                    if w.status_code >= 400:
                        raise DriverError(f"Lumina {section} write HTTP {w.status_code}: {w.text[:200]}")
                rbody = {"version": "1.0", "data": {"channel": ch_str}}
                r = await c.post(f"{_base(host, creds)}{get_path}", json=rbody, auth=_auth(creds))
                try:
                    return r.json() if r.status_code == 200 else {"status": r.status_code}
                except Exception:  # noqa: BLE001
                    return {"raw": r.text}
        except DriverError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise DriverError(f"Lumina configure({section}) failed for {host}: {exc}") from None

    # ── event topic map (device-level motion only; AI formats out of scope) ───
    def event_topic_map(self) -> dict[str, tuple[str, str, str]]:
        """Lumina device-event type → (event_type, severity, title).

        Ported the DEVICE-LEVEL motion event from v2
        ``formats/cap/motion.json`` (``alarm_type: "motion"``, ``type: "motion"``,
        ``from: "camera"``). Lumina's alarm push uses a JSON ``event_info.type`` string.

        ⚠️ The other v2 Lumina formats — ``frs`` (face-recognition), ``lp``
        (license-plate), ``fd`` (face-detect), ``sod`` (smart-object), ``lcd``
        (line-crossing) — are AI-ANALYTICS events and are OUT of VMS scope (no AI in the
        VMS). They are a FUTURE AI event source (a separate analytics pipeline), NOT
        wired into the VMS driver. Only the device-level motion event belongs here.

        # LIVE-VALIDATE: the exact ``event_info.type`` string(s) Lumina emits for motion
        # + which push transport (webhook/poll) delivers them. Ingestion is P5 (Go nvr).
        """
        return {
            "motion": ("motion_detected", "alarm", "Motion detected"),
            "Motion Detection": ("motion_detected", "alarm", "Motion detected"),
        }

    # ── NVR footage / playback (P4-B — delegate to ONVIF Profile G) ───────────
    async def search_recordings(
        self,
        host: str,
        creds: Credentials,
        *,
        channel: int | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
    ) -> list[dict[str, Any]]:
        """Lumina footage search. v2's Lumina integration had NO recording-search API,
        so we delegate to ONVIF Profile G (many Lumina devices also answer ONVIF).
        Never raises — ``[]`` when ONVIF-G is unavailable.

        # LIVE-VALIDATE: v2 had NO Lumina recording search — this uses the ONVIF-G path
        # as a best-effort. Confirm whether the owner's Lumina NVR exposes ONVIF Profile G
        # (recording search); if not, footage extraction needs a Lumina-native API port.
        """
        from .onvif import OnvifDriver

        return await OnvifDriver().search_recordings(
            host, creds, channel=channel, start_time=start_time, end_time=end_time
        )

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
        """Lumina replay URI — delegate to ONVIF Profile G GetReplayUri (v2 had no
        Lumina-native playback API). Never raises — ``None`` when unavailable.

        # LIVE-VALIDATE: as above — confirm ONVIF-G replay on the owner's Lumina device.
        """
        from .onvif import OnvifDriver

        return await OnvifDriver().get_playback_uri(
            host, creds, channel=channel, start_time=start_time, end_time=end_time,
            recording_token=recording_token,
        )
