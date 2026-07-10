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

    async def aclose(self) -> None:
        """Release any held resources (HTTP client). Best-effort."""
        return None
