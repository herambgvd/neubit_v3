"""Hardware video-decoder driver abstraction — the Video Wall decoder-push seam (VW-B).

This mirrors the camera ``CameraDriver`` seam (``drivers/base.py``): the wall service
depends ONLY on this interface, and ``decoder_factory.get_decoder_driver(brand)`` picks the
concrete class. Adding a decoder brand = one module + one factory line, no service changes.

Where ``CameraDriver`` talks to CAMERAS/NVRs to onboard + stream, ``DecoderDriver`` talks to
a physical VIDEO DECODER appliance (Hikvision ISAPI dynamic-decoding / Dahua-CP-Plus CGI)
whose HDMI/BNC outputs each drive a control-room screen. The wall pushes a camera's RTSP
onto a decoder output cell so the physical wall shows the camera — not just a browser kiosk.

Design discipline (identical to the camera drivers):
  * **All methods async.** HTTP work is offloaded via the shared ``_http`` digest helpers.
  * **Graceful on unreachable / missing credential.** ``probe`` returns
    ``DecoderInfo(reachable=False, error=...)``; ``set_layout`` / ``display`` / ``clear`` /
    ``start_tour`` return ``DecoderResult(ok=False, error=...)`` — they NEVER raise, so a
    dead decoder or a bad credential degrades gracefully and never breaks the wall-state
    write/broadcast (best-effort push). A fast ``_tcp_reachable`` pre-gate avoids a slow
    SDK/HTTP hang against a down appliance, exactly like ``OnvifDriver``.
  * **Plaintext creds cross the seam in-memory only.** The service decrypts
    ``VideoDecoder.enc_password`` (``common.crypto``) and hands the driver a
    ``DecoderCredentials`` — the driver NEVER touches the DB or the encryption key.

LIVE-VALIDATE: the concrete drivers build the real brand ISAPI/CGI requests faithfully to
the documented Hik/Dahua decode-push API, but the exact on-wire endpoints + body shapes
vary by firmware/model. Every actual push call is marked ``# LIVE-VALIDATE`` — confirm
against a real decoder appliance.
"""

from __future__ import annotations

import abc
import asyncio
from dataclasses import dataclass, field
from typing import Any


# ── Credentials ────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class DecoderCredentials:
    """Decrypted decoder-management credentials, in-memory only.

    The service decrypts ``VideoDecoder.enc_password`` (via ``common.crypto``) before
    constructing a driver call — the driver receives plaintext and never persists it.
    ``port`` is the decoder's HTTP/ISAPI/CGI management port.
    """

    username: str = "admin"
    password: str = ""
    port: int = 80
    verify_tls: bool = False


# ── DTOs ─────────────────────────────────────────────────────────────────────
@dataclass
class DecoderInfo:
    """Result of ``probe`` — reachability + identity (graceful-failure shape).

    ``reachable=False`` + ``error`` is the graceful shape (never an exception).
    """

    reachable: bool
    manufacturer: str | None = None
    model: str | None = None
    firmware: str | None = None
    serial_number: str | None = None
    channel_count: int = 0
    error: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class DecoderResult:
    """Result of an action (``set_layout`` / ``display`` / ``clear`` / ``start_tour``).

    ``ok=False`` + ``error`` is the graceful shape — actions never raise so a best-effort
    decoder push can NEVER break the wall-state write/broadcast. ``detail`` carries the
    brand response body (audit / debug).
    """

    ok: bool
    error: str | None = None
    detail: str | None = None


# ── fast reachability pre-gate ────────────────────────────────────────────────
async def _tcp_reachable(host: str, port: int, timeout: float = 2.0) -> bool:
    """Fast TCP pre-check before a (potentially slow) decoder HTTP/SDK call.

    Mirrors ``OnvifDriver._tcp_reachable``: an unreachable decoder host would otherwise
    hang the wall push on a long HTTP connect timeout. Gate every push on a 2s TCP
    connect first — down → return the graceful failure immediately; up → proceed."""
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


class DecoderDriver(abc.ABC):
    """Brand-agnostic hardware video-decoder driver. Constructed per-call by
    ``decoder_factory.get_decoder_driver(brand)``; stateless — every method takes
    ``host`` + ``DecoderCredentials`` so one instance serves many appliances of the
    same brand. ALL methods degrade gracefully (never raise)."""

    #: The brand key this driver serves (e.g. "hikvision", "dahua_cpplus").
    brand: str = "generic"

    # ── probe / reachability ─────────────────────────────────────────────────
    @abc.abstractmethod
    async def probe(self, host: str, creds: DecoderCredentials) -> DecoderInfo:
        """Probe reachability + identity. MUST NOT raise — return
        ``DecoderInfo(reachable=False, error=...)`` on any failure."""

    # ── output layout (split-screen on a decoder output) ─────────────────────
    @abc.abstractmethod
    async def set_layout(
        self, host: str, creds: DecoderCredentials, channel: int, grid: int
    ) -> DecoderResult:
        """Set the split-screen layout of decoder output ``channel`` (grid = 1|4|9|16
        cells). MUST NOT raise — return ``DecoderResult(ok=False, error=...)`` on
        failure."""

    # ── display a stream on an output cell ───────────────────────────────────
    @abc.abstractmethod
    async def display(
        self, host: str, creds: DecoderCredentials, channel: int, cell: int, rtsp_uri: str
    ) -> DecoderResult:
        """Show ``rtsp_uri`` on cell ``cell`` of decoder output ``channel`` (the core
        wall decoder-push action). MUST NOT raise — return
        ``DecoderResult(ok=False, error=...)`` on failure."""

    # ── clear an output ──────────────────────────────────────────────────────
    @abc.abstractmethod
    async def clear(
        self, host: str, creds: DecoderCredentials, channel: int, cell: int | None = None
    ) -> DecoderResult:
        """Clear cell ``cell`` (or the whole output when ``cell`` is None) of decoder
        output ``channel``. MUST NOT raise — ``DecoderResult(ok=False, error=...)`` on
        failure."""

    # ── tour (cycle a sequence of RTSP sources on one output) ────────────────
    async def start_tour(
        self,
        host: str,
        creds: DecoderCredentials,
        channel: int,
        uris: list[str],
        dwell: int = 10,
    ) -> DecoderResult:
        """Cycle ``uris`` on decoder output ``channel`` with a ``dwell``-second interval
        (brand tour/plan). Optional — default = not supported (graceful). MUST NOT raise."""
        return DecoderResult(ok=False, error=f"{self.brand}: start_tour not supported")
