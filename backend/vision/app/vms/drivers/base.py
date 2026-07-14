"""Camera/NVR driver abstraction — the VMS multi-brand seam.

This mirrors the access service's ``ControllerConnector`` pattern
(``backend/access/app/connectors/base.py``): the onboarding + config service layer
depends ONLY on this interface, and ``factory.get_driver(brand)`` picks the
concrete class. Adding a brand (Dahua, Uniview, …) = one module + one factory line,
no service changes.

Where the access seam talks to access-controllers (DDS/ESSL) over OData/SignalR,
this seam talks to CAMERAS and NVRs over ONVIF SOAP / Hikvision ISAPI / Dahua CGI /
brand REST. The default ``OnvifDriver`` is a faithful port of gvd_nvr's
``backend/app/cameras/onvif_service.py`` + ``onvif_event_service.py`` and covers
most devices via ONVIF Profile S (live) / G (recording/playback) / T (H.265).

Design discipline (same as the access connectors):
  * **All methods async.** Blocking SDK work (python-onvif ``zeep``) is offloaded to
    threads with ``asyncio.to_thread`` inside the concrete driver.
  * **Graceful on unreachable host.** ``discover`` / ``enumerate_channels`` /
    ``get_capabilities`` return ``[]`` / empty on failure (never raise); ``probe``
    returns ``DeviceInfo(reachable=False, error=...)``; ``get_stream_uris`` returns
    ``StreamUris()`` with ``None`` fields; ``get_snapshot`` returns ``None``. Only
    ``ptz`` / ``configure`` raise ``DriverError`` on failure (they are explicit
    operator actions where a silent no-op would be misleading).
  * **Typed DTOs** (dataclasses) cross the seam — the onboarding layer persists them
    into the Camera/NVR/MediaProfile ORM rows. The driver NEVER touches the DB or the
    encryption key; the service decrypts creds first and hands the driver a
    plaintext ``Credentials`` in-memory only.

The interface is the SUBSET P1 (onboarding + capability detect + config + PTZ)
needs, plus the event-topic map + subscribe primitive (control-side; high-throughput
event INGESTION at scale lives in the Go ``nvr`` service, P5). Playback/footage
methods are declared as documented stubs (P4).
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable


# ── Credentials ────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Credentials:
    """Decrypted device credentials, in-memory only.

    The service decrypts ``onvif_enc_pass`` / ``enc_creds`` (via ``vms.crypto``)
    before constructing a driver call — the driver receives plaintext and never
    persists it. ``port`` is the device's HTTP/ONVIF service port (RTSP port is
    separate and usually 554).
    """

    username: str = "admin"
    password: str = "admin"
    port: int = 80
    rtsp_port: int = 554
    verify_tls: bool = False


# ── DTOs the onboarding layer persists ──────────────────────────────────────────
@dataclass
class Discovered:
    """One device found on the LAN by ``discover`` (pre-onboarding candidate).

    ``auth_required`` is set when the host answers ONVIF SOAP but rejects the probe
    credentials — the UI shows it as "unverified" so the operator supplies real creds
    (ported from gvd_nvr ``onvif_service.discover`` enrichment).
    """

    ip: str
    port: int = 80
    xaddr: str | None = None
    name: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    firmware: str | None = None
    serial_number: str | None = None
    mac: str | None = None
    brand: str = "onvif"
    auth_required: bool = False
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class DeviceInfo:
    """Result of ``probe`` — reachability + identity + coarse capability flags.

    ``reachable=False`` + ``error`` is the graceful-failure shape (never an
    exception). ``channel_count`` is best-effort (0 = unknown / single-channel).
    """

    reachable: bool
    manufacturer: str | None = None
    model: str | None = None
    firmware: str | None = None
    serial_number: str | None = None
    hardware_id: str | None = None
    mac: str | None = None
    channel_count: int = 0
    has_ptz: bool = False
    has_imaging: bool = False
    has_events: bool = False
    has_analytics: bool = False
    has_audio: bool = False
    error: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class StreamInfo:
    """One media stream (main/sub/third) of a channel — maps to a MediaProfile row."""

    profile_token: str | None = None
    stream_url: str | None = None
    resolution: str | None = None
    fps: int | None = None
    codec: str | None = None
    bitrate: int | None = None


@dataclass
class Channel:
    """One physical channel of a device (a single camera, or one NVR input).

    A standalone camera returns a single channel; an NVR/multi-channel encoder
    returns one per input. ``main``/``sub`` map to MediaProfile rows; the onboarding
    layer creates one Camera per channel with ``onvif_profile_token = main.profile_token``.
    """

    channel: int
    name: str
    source_token: str | None = None
    channel_number: int | None = None  # brand/device channel id when known
    main: StreamInfo | None = None
    sub: StreamInfo | None = None
    snapshot_url: str | None = None
    ptz_capable: bool = False
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class StreamUris:
    """Main + sub RTSP URIs for a single channel/profile (credentials injected)."""

    main: str | None = None
    sub: str | None = None
    codec: str | None = None
    media_version: int | None = None  # 1 = ONVIF Media (Profile S), 2 = Media2 (Profile T)


@dataclass
class TalkTarget:
    """Two-way-audio (backchannel) target the frontend needs to start talking (G6).

    ONVIF two-way audio is a BACKCHANNEL: the client sends an audio track TO the
    camera's RTSP endpoint (a ``SETUP`` with ``Require: www.onvif.org/ver20/backchannel``
    + ``PLAY`` that reverses the media direction, or the brand's own push endpoint).
    Realistically the browser can't speak raw RTSP, so the practical flow is
    WHIP-into-MediaMTX (the browser publishes mic audio to a MediaMTX path that the
    media-plane forwards to the camera backchannel) — but the on-wire push to a real
    speaker is brand-specific and unverified (# LIVE-VALIDATE).

    This DTO is what the driver resolves for the talk-session issuer:
      * ``supported`` — the device has a detected backchannel (speaker).
      * ``kind``      — ``rtsp_backchannel`` (ONVIF), ``http_push`` (brand REST), or
                        ``whip`` (browser→MediaMTX→camera). Advises the frontend.
      * ``url``       — the backchannel RTSP / brand push URL (creds injected) when
                        the driver can build one; None when it's a WHIP-to-media flow.
      * ``codec``     — the audio codec the device expects (e.g. ``PCMU``/``AAC``);
                        the frontend/media-plane transcodes the mic to it.
    """

    supported: bool = False
    kind: str = "rtsp_backchannel"
    url: str | None = None
    codec: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class FleetOpResult:
    """Result of a device / fleet-management operation (G7).

    The uniform shape every fleet op (reboot / set_ntp / set_password / restore_config)
    returns so the service + bulk fan-out can report per-camera outcome without brand
    branching. ``ok`` is the operator-visible success; ``detail`` a short human message;
    ``supported`` distinguishes "the brand can't do this" (graceful degrade → ok=False,
    supported=False) from "the op ran but failed" (ok=False, supported=True). ``data``
    carries any op-specific echo (e.g. the NTP server accepted, the firmware version).
    """

    ok: bool = False
    supported: bool = True
    detail: str | None = None
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class StreamCodecProfile:
    """One media profile's current video codec — result of ``get_stream_codecs`` (G8).

    Reports what the device is CURRENTLY encoding a given stream in, so the policy can
    decide whether a sub-stream needs pushing to H.264 (skip if already H.264). ``role``
    is the driver's best-effort classification (``main`` | ``sub`` | ``third``) so the
    caller can target the web (sub) stream without knowing the brand's channel math.
    ``codec`` is UPPER-CASE normalized (``H264`` | ``H265`` | ``MJPEG`` | ...); ``None``
    when the device didn't report one. ``token`` is the brand handle used to set the
    codec (ONVIF VideoEncoderConfiguration token / Hik stream id / Dahua channel index)."""

    role: str  # main | sub | third
    codec: str | None = None
    token: str | None = None
    resolution: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class ConfigBackup:
    """Result of ``backup_config`` (G7) — a device configuration blob for archival/restore.

    ``blob`` is the raw device config bytes (brand-specific: Hik ISAPI
    ``configurationData`` is a binary blob, Dahua ``configFileExport`` a backup file,
    ONVIF ``GetSystemBackup`` a set of backup files). ``content_type`` +
    ``filename`` advise the download response. ``supported=False`` (empty blob) when the
    brand has no config-backup surface — graceful, never raises.
    """

    supported: bool = False
    blob: bytes | None = None
    content_type: str = "application/octet-stream"
    filename: str = "config.bin"
    detail: str | None = None


@dataclass
class Capabilities:
    """Detected capability matrix — persisted to ``Camera.onvif_capabilities`` /
    ``NVR.capabilities``. Brand-neutral booleans + a verbatim ``raw`` blob."""

    ptz: bool = False
    imaging: bool = False
    events: bool = False
    analytics: bool = False
    audio: bool = False
    io: bool = False
    recording_search: bool = False  # ONVIF Profile G / brand footage search (playback)
    backchannel: bool = False       # two-way audio
    media2: bool = False            # ONVIF Media2 / Profile T (H.265)
    services: list[str] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)


# ── PTZ command ─────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class PtzCommand:
    """A single PTZ action dispatched through ``CameraDriver.ptz``.

    ``action`` is one of:
      * ``continuous`` — pan/tilt/zoom velocity move (use ``pan``/``tilt``/``zoom``/``speed``).
      * ``zoom``       — zoom-only velocity move (``zoom`` = direction/speed; in > 0, out < 0).
      * ``focus``      — focus continuous move (Imaging service; ``zoom`` = focus velocity).
        Graceful ``DriverError`` on brands without a focus surface.
      * ``stop``       — halt motion.
      * ``relative``   — relative move (``pan``/``tilt``/``zoom`` = deltas).
      * ``absolute``   — absolute move (``pan``/``tilt``/``zoom`` = target positions).
      * ``goto_preset`` — recall ``preset_token``.
      * ``set_preset``  — store current position as ``preset_name`` (returns token).
      * ``delete_preset`` — remove ``preset_token``.
      * ``get_presets`` — list presets (returned via ``ptz`` result).
    """

    action: str
    pan: float = 0.0
    tilt: float = 0.0
    zoom: float = 0.0
    speed: float = 0.5
    preset_token: str | None = None
    preset_name: str | None = None
    profile_token: str | None = None


# ── Event callback (control-side subscribe) ─────────────────────────────────────
@dataclass(frozen=True)
class DeviceEvent:
    """One real-time device event surfaced by ``subscribe_events`` (control-side).

    Brand-neutral shape the ingestion layer normalizes + publishes on NATS:
      * ``event_type`` — mapped NVR event type (motion_detected, camera_tamper, …).
      * ``severity``   — info | warning | alarm | critical.
      * ``title``      — human label from the topic map.
      * ``raw_topic``  — the verbatim device topic (ONVIF ``tns1:...``) for audit.
      * ``metadata``   — extracted key/value SimpleItems + source ref.
      * ``occurred_at``— ISO-8601 string (best-effort; None → now).
    """

    event_type: str
    severity: str
    title: str
    raw_topic: str
    metadata: dict[str, Any] = field(default_factory=dict)
    occurred_at: str | None = None


# The async callback the driver invokes for each real-time event.
EventCallback = Callable[[DeviceEvent], Awaitable[None]]


class DriverError(Exception):
    """Raised by explicit operator actions (``ptz`` / ``configure``) on failure.

    Read/detect methods (discover/probe/channels/capabilities/stream/snapshot)
    degrade gracefully and do NOT raise this — they return empty/None instead.
    """


class CameraDriver(abc.ABC):
    """Brand-agnostic camera/NVR driver. Constructed per-call by
    ``factory.get_driver(brand)``; stateless — every method takes ``host`` +
    ``Credentials`` so one instance serves many devices of the same brand."""

    #: The brand key this driver serves (e.g. "onvif", "hikvision"). Set by subclasses.
    brand: str = "generic"

    # ── discovery ────────────────────────────────────────────────────────────
    @abc.abstractmethod
    async def discover(
        self, network: str | None = None, *, creds: Credentials | None = None, timeout: int = 5
    ) -> list[Discovered]:
        """Discover devices on the LAN. ``network`` = CIDR to scan (None = auto).
        MUST NOT raise — return ``[]`` on failure."""

    # ── probe / identity ─────────────────────────────────────────────────────
    @abc.abstractmethod
    async def probe(self, host: str, creds: Credentials) -> DeviceInfo:
        """Probe reachability + identity + coarse capability flags. MUST NOT raise —
        return ``DeviceInfo(reachable=False, error=...)`` on any failure."""

    # ── channel enumeration (multi-channel NVR / encoder support) ─────────────
    @abc.abstractmethod
    async def enumerate_channels(self, host: str, creds: Credentials) -> list[Channel]:
        """Enumerate physical channels (one per camera / NVR input) with main + sub
        stream info. Standalone camera → single channel. MUST NOT raise — ``[]`` on
        failure."""

    # ── stream URIs ──────────────────────────────────────────────────────────
    @abc.abstractmethod
    async def get_stream_uris(
        self, host: str, creds: Credentials, *, profile: str | None = None
    ) -> StreamUris:
        """Return main + sub RTSP URIs (credentials percent-encoded + injected).
        ``profile`` = an ONVIF profile token / brand channel id (None = first channel).
        MUST NOT raise — return ``StreamUris()`` (None fields) on failure."""

    # ── capability detection ─────────────────────────────────────────────────
    @abc.abstractmethod
    async def get_capabilities(self, host: str, creds: Credentials) -> Capabilities:
        """Detect the capability matrix (ptz/imaging/events/analytics/audio/io/…).
        MUST NOT raise — return ``Capabilities()`` (all False) on failure."""

    # ── snapshot ─────────────────────────────────────────────────────────────
    @abc.abstractmethod
    async def get_snapshot(
        self, host: str, creds: Credentials, *, profile: str | None = None
    ) -> bytes | None:
        """Fetch a single JPEG frame. MUST NOT raise — return ``None`` on failure."""

    # ── PTZ (explicit operator action — MAY raise DriverError) ────────────────
    @abc.abstractmethod
    async def ptz(self, host: str, creds: Credentials, cmd: PtzCommand) -> Any:
        """Dispatch a PTZ command. Returns preset list for ``get_presets`` / a new
        token for ``set_preset`` / ``None`` otherwise. Raises ``DriverError`` on
        failure (an operator action, not a background detect)."""

    # ── configuration (explicit operator action — MAY raise DriverError) ──────
    @abc.abstractmethod
    async def configure(
        self, host: str, creds: Credentials, section: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Read (empty payload) or write a config ``section`` (imaging / io /
        motion_config / privacy_masks / ntp / …). Returns the resulting/current
        settings dict. Raises ``DriverError`` on write failure or unsupported section."""

    # ── event topic map (control-side; ingestion worker = Go nvr P5) ──────────
    @abc.abstractmethod
    def event_topic_map(self) -> dict[str, tuple[str, str, str]]:
        """Return the brand's device-topic → (event_type, severity, title) map.
        Ported from gvd_nvr ``onvif_event_service._TOPIC_MAP`` for ONVIF."""

    async def subscribe_events(self, host: str, creds: Credentials, callback: EventCallback) -> None:
        """Open the device's real-time event stream (ONVIF PullPoint / brand alarm
        stream) and invoke ``callback`` per mapped event. Runs until cancelled;
        reconnects internally. Default = not implemented (P5 in Go nvr for scale;
        the ONVIF driver provides a working control-side implementation)."""
        raise NotImplementedError(f"{self.brand}: subscribe_events not implemented")

    async def stop_events(self) -> None:
        """Ask an active ``subscribe_events`` loop to stop (best-effort)."""
        return None

    # ── two-way audio / backchannel talk target (G6) ──────────────────────────
    async def talk_target(
        self, host: str, creds: Credentials, *, profile: str | None = None
    ) -> TalkTarget:
        """Resolve the two-way-audio (backchannel) target for this device.

        Returns a ``TalkTarget`` describing how the caller opens a talk stream to the
        camera's speaker. The DEFAULT builds the ONVIF backchannel RTSP URL from the
        camera's main stream URI (same RTSP path with the backchannel Require header
        applied by the media-plane) IF the driver's ``get_capabilities`` reported
        ``backchannel``; a driver with a brand push API overrides this.

        MUST NOT raise — return ``TalkTarget(supported=False)`` when the device has no
        backchannel / is unreachable. The actual on-wire push to a real speaker is
        # LIVE-VALIDATE (brand-specific). This is the control-side capability + target
        resolver; the media-plane / browser does the real bidirectional push."""
        try:
            caps = await self.get_capabilities(host, creds)
        except Exception:  # noqa: BLE001 — graceful: unknown → unsupported
            return TalkTarget(supported=False)
        if not caps.backchannel:
            return TalkTarget(supported=False)
        uris = await self.get_stream_uris(host, creds, profile=profile)
        return TalkTarget(
            supported=True,
            kind="rtsp_backchannel",
            url=uris.main or uris.sub,
            codec=None,  # device-specific; resolved on the wire (# LIVE-VALIDATE)
            extra={"require": "www.onvif.org/ver20/backchannel"},
        )

    # ── NVR footage / playback extraction (P4-B) ──────────────────────────────
    async def search_recordings(
        self,
        host: str,
        creds: Credentials,
        *,
        channel: int | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
    ) -> list[dict[str, Any]]:
        """Search on-device / NVR recordings for a channel + time range. Returns
        ``[{start_time, end_time, ...}]`` (ISO-8601 strings; brand-specific extras like
        ``recording_token`` / ``track_id`` / ``file_path`` may be included). P4-B
        (footage extraction across onboarded NVRs). MUST NOT raise — ``[]`` when
        unsupported / unreachable."""
        return []

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
        """Build an RTSP replay URI for a channel + time-window (or an ONVIF Profile-G
        ``recording_token``). Returns the RTSP-with-time URL the browser-facing plane
        (MediaMTX path / server-side proxy) plays. P4-B. MUST NOT raise — ``None`` when
        unsupported / unreachable."""
        return None

    # ── device / fleet management (G7) ────────────────────────────────────────
    #
    # Fleet ops are EXPLICIT operator actions, but — unlike ``ptz``/``configure`` — they
    # degrade GRACEFULLY per brand rather than raising: a device that can't be reached, or
    # a brand with no surface for the op, returns ``FleetOpResult(ok=False, supported=...)``
    # so the bulk fan-out can report a per-camera outcome without a partial-failure
    # exception aborting the batch. The concrete drivers build the real brand request
    # faithfully (Hik ISAPI, Dahua CGI, ONVIF SOAP); the actual on-device effect is
    # ``# LIVE-VALIDATE`` (no live devices in dev). Defaults here = "unsupported".

    async def get_device_info(self, host: str, creds: Credentials) -> DeviceInfo:
        """Fleet identity read — model / firmware / serial for the device-management panel.

        DEFAULT delegates to ``probe`` (which every driver implements) so firmware +
        identity are available brand-agnostically. MUST NOT raise — graceful
        ``DeviceInfo(reachable=False, ...)`` via ``probe``."""
        try:
            return await self.probe(host, creds)
        except Exception as exc:  # noqa: BLE001 — read must never raise
            return DeviceInfo(reachable=False, error=str(exc))

    async def reboot(self, host: str, creds: Credentials) -> FleetOpResult:
        """Reboot the device (Hik ISAPI ``PUT /ISAPI/System/reboot`` / ONVIF
        ``SystemReboot`` / Dahua ``magicBox.cgi?action=reboot``). MUST NOT raise —
        ``FleetOpResult(ok=False, supported=False)`` when unsupported/unreachable.
        # LIVE-VALIDATE: real reboot effect."""
        return FleetOpResult(ok=False, supported=False, detail=f"{self.brand}: reboot not supported")

    async def set_ntp(self, host: str, creds: Credentials, server: str) -> FleetOpResult:
        """Point the device time-sync at ``server`` (NTP host). Hik ISAPI
        ``PUT /ISAPI/System/time/ntpServers`` / ONVIF ``SetNTP`` / Dahua ``configManager
        setConfig&name=NTP``. MUST NOT raise. # LIVE-VALIDATE."""
        return FleetOpResult(ok=False, supported=False, detail=f"{self.brand}: set_ntp not supported")

    async def set_password(
        self, host: str, creds: Credentials, *, user: str, new_password: str
    ) -> FleetOpResult:
        """Change the password of device account ``user`` (Hik ISAPI
        ``PUT /ISAPI/Security/users/{id}`` / ONVIF ``SetUser`` / Dahua
        ``userManager.cgi?action=modifyPassword``). MUST NOT raise — graceful. The bulk
        password op fans this out across a fleet. # LIVE-VALIDATE: user-id resolution +
        auth-after-change."""
        return FleetOpResult(ok=False, supported=False, detail=f"{self.brand}: set_password not supported")

    async def backup_config(self, host: str, creds: Credentials) -> ConfigBackup:
        """Export the device configuration as a blob (Hik ISAPI
        ``GET /ISAPI/System/configurationData`` / Dahua ``configFileExport`` / ONVIF
        ``GetSystemBackup``). MUST NOT raise — ``ConfigBackup(supported=False)`` on
        failure/unsupported. # LIVE-VALIDATE."""
        return ConfigBackup(supported=False, detail=f"{self.brand}: config backup not supported")

    async def restore_config(self, host: str, creds: Credentials, blob: bytes) -> FleetOpResult:
        """Restore a previously-exported config ``blob`` (Hik ISAPI
        ``PUT /ISAPI/System/configurationData`` / Dahua ``configFileImport`` / ONVIF
        ``RestoreSystem``). MUST NOT raise. # LIVE-VALIDATE: restore reboots the device."""
        return FleetOpResult(ok=False, supported=False, detail=f"{self.brand}: config restore not supported")

    # ── stream codec policy (G8 — zero-transcode live view) ───────────────────
    #
    # Browsers (Chrome WebRTC) can't decode H.265, so an H.265 sub-stream forces a
    # CPU-heavy transcode. Cameras/NVRs support per-stream codecs — the fix is to force
    # the SUB (web-viewing) stream to H.264 AT THE DEVICE so live plays with zero
    # transcode, while the MAIN stream stays H.265 (recording, storage-efficient). These
    # two methods are the driver seam for that policy; concrete drivers build the real
    # brand request (ONVIF SetVideoEncoderConfiguration / Hik ISAPI videoCodecType /
    # Dahua ExtraFormat Compression). Graceful per brand + the on-device effect is
    # ``# LIVE-VALIDATE`` (many NVRs reject per-channel codec changes over ONVIF and need
    # their own web UI / brand API — reported honestly by the driver).

    async def get_stream_codecs(self, host: str, creds: Credentials) -> list[StreamCodecProfile]:
        """Probe each media profile's CURRENT video codec (main/sub/…) so the policy can
        show H.264-web ✓ vs H.265 and SKIP a device already on H.264. MUST NOT raise —
        ``[]`` on unreachable / unsupported. Default = ``[]`` (a driver with no probe
        surface). The ONVIF/Hik/Dahua drivers override with a real read."""
        return []

    async def set_stream_codec(
        self, host: str, creds: Credentials, *, profile: str = "sub", codec: str = "h264"
    ) -> FleetOpResult:
        """Force the ``profile`` stream ("sub" = web-viewing) to ``codec`` ("h264") at the
        device — the zero-transcode-live-view enforcement. ``profile`` is a role key
        (``main`` | ``sub`` | ``third``); the driver resolves it to the brand's stream
        handle. Graceful (``FleetOpResult`` {ok, supported, detail}) — ``supported=False``
        when the brand has no codec-set surface, ``ok=False, supported=True`` when the op
        ran but the device rejected it (common on NVRs — # LIVE-VALIDATE). Default =
        unsupported; ONVIF/Hik/Dahua override."""
        return FleetOpResult(
            ok=False, supported=False, detail=f"{self.brand}: set_stream_codec not supported"
        )

    async def aclose(self) -> None:
        """Release any held resources (HTTP client). Best-effort."""
        return None
