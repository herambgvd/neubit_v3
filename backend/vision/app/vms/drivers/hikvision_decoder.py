"""HikvisionDecoder — Hikvision hardware video-decoder driver (ISAPI, HTTP Digest).

A Hikvision decoder (DS-6900UDI / DS-6400HDI-T families) exposes the ISAPI REST surface
(XML over HTTP Digest), the same auth + transport the ``HikvisionDriver`` camera driver
uses. This driver drives the decoder's video-WALL + dynamic-decoding endpoints so the wall
service can push a camera's RTSP onto a decoder output cell.

ISAPI decoder endpoint map (all HTTP Digest) — from Hikvision's published ISAPI-VideoWall
+ dynamic-channel spec:
  * probe / identity   GET  ``/ISAPI/System/deviceInfo``                    → model/firmware/serial.
  * output count       GET  ``/ISAPI/System/Video/outputs``                 → decode-output channels.
  * output layout      PUT  ``/ISAPI/System/Video/outputs/channels/<ch>/window``
                       (a ``<VideoOutputWindow>`` with the ``<layout>`` grid: 1/4/9/16).
  * display a stream   PUT  ``/ISAPI/ContentMgmt/dynamicChannels/<ch>``     ← the dynamic-decode
                       "decode this RTSP" call: a ``<DynamicChannel>`` carrying the source
                       ``<srcUrl>`` (rtsp), targeting output channel ``<ch>`` + window ``<cell>``.
  * clear an output    PUT  ``/ISAPI/ContentMgmt/dynamicChannels/<ch>`` (empty ``<srcUrl>``) /
                       DELETE the dynamic channel.
  * tour               PUT  ``/ISAPI/ContentMgmt/dynamicChannels/<ch>`` with a wall-plan /
                       polling loop (brand "video wall plan").

# LIVE-VALIDATE: the ISAPI decoder endpoints + XML body shapes below follow Hikvision's
# published ISAPI-VideoWall + dynamic-decoding spec, but exact paths (``dynamicChannels`` vs
# ``ContentMgmt/DynamicCap`` vs ``videoWall/wallWindows``), the window-index math and the
# ``<DynamicChannel>`` schema vary by decoder model + firmware. Every on-wire push call is
# marked ``# LIVE-VALIDATE`` — confirm against a real Hik decoder appliance.
"""

from __future__ import annotations

import logging
from xml.sax.saxutils import escape

from . import _http
from .decoder_base import (
    DecoderCredentials,
    DecoderDriver,
    DecoderInfo,
    DecoderResult,
    _tcp_reachable,
)

log = logging.getLogger("vision.drivers.hikvision_decoder")

# Hik decoders accept the split-screen mode as a "1/4/9/16" window count.
_VALID_GRIDS = {1, 4, 9, 16}


class HikvisionDecoder(DecoderDriver):
    """Hikvision ISAPI hardware-decoder driver (HTTP Digest). All actions degrade
    gracefully (never raise) — a best-effort wall push must not break wall state."""

    brand = "hikvision"

    def _base(self, host: str, creds: DecoderCredentials) -> str:
        scheme = "https" if creds.verify_tls else "http"
        return f"{scheme}://{host}:{creds.port}"

    # ── probe / identity ─────────────────────────────────────────────────────
    async def probe(self, host: str, creds: DecoderCredentials) -> DecoderInfo:
        """GET /ISAPI/System/deviceInfo → identity. Never raises."""
        if not await _tcp_reachable(host, creds.port):
            return DecoderInfo(reachable=False, error="decoder host unreachable (TCP)")
        body = await _http.get_text(
            f"{self._base(host, creds)}/ISAPI/System/deviceInfo",
            creds.username,
            creds.password,
            verify_tls=creds.verify_tls,
        )
        if body is None:
            return DecoderInfo(
                reachable=False, error="ISAPI deviceInfo unreachable or auth failed"
            )
        info = DecoderInfo(
            reachable=True,
            manufacturer="Hikvision",
            model=_http.xml_text(body, "model"),
            firmware=_http.xml_text(body, "firmwareVersion"),
            serial_number=_http.xml_text(body, "serialNumber"),
            raw={"deviceInfo_len": len(body)},
        )
        # Best-effort output-channel count (decode outputs).
        outputs = await _http.get_text(
            f"{self._base(host, creds)}/ISAPI/System/Video/outputs",
            creds.username,
            creds.password,
            verify_tls=creds.verify_tls,
        )
        if outputs:
            info.channel_count = len(_http.xml_findall(outputs, "VideoOutputChannel"))
        return info

    # ── output layout (split-screen) ─────────────────────────────────────────
    async def set_layout(
        self, host: str, creds: DecoderCredentials, channel: int, grid: int
    ) -> DecoderResult:
        """PUT /ISAPI/System/Video/outputs/channels/<ch>/window — set the split-screen
        window count (grid = 1|4|9|16). Never raises."""
        if grid not in _VALID_GRIDS:
            return DecoderResult(ok=False, error=f"unsupported grid {grid} (want 1|4|9|16)")
        if not await _tcp_reachable(host, creds.port):
            return DecoderResult(ok=False, error="decoder host unreachable (TCP)")
        # <VideoOutputWindow><layout>4</layout></VideoOutputWindow>
        payload = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<VideoOutputWindow xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0">'
            f"<layout>{int(grid)}</layout>"
            "</VideoOutputWindow>"
        )
        url = f"{self._base(host, creds)}/ISAPI/System/Video/outputs/channels/{int(channel)}/window"
        # LIVE-VALIDATE: real Hik decoder split-window ISAPI call on the wire.
        return await self._put_strict(url, creds, payload, action="set_layout")

    # ── display a stream on an output cell ───────────────────────────────────
    async def display(
        self, host: str, creds: DecoderCredentials, channel: int, cell: int, rtsp_uri: str
    ) -> DecoderResult:
        """PUT /ISAPI/ContentMgmt/dynamicChannels/<ch> — decode ``rtsp_uri`` onto window
        ``cell`` of decoder output ``channel`` (dynamic-decoding). Never raises."""
        if not rtsp_uri:
            return DecoderResult(ok=False, error="empty rtsp_uri")
        if not await _tcp_reachable(host, creds.port):
            return DecoderResult(ok=False, error="decoder host unreachable (TCP)")
        # <DynamicChannel><id>ch</id><window>cell</window><srcUrl>rtsp://…</srcUrl>
        #   <protocolType>RTSP</protocolType></DynamicChannel>
        payload = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<DynamicChannel xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0">'
            f"<id>{int(channel)}</id>"
            f"<window>{int(cell)}</window>"
            f"<srcUrl>{escape(rtsp_uri)}</srcUrl>"
            "<protocolType>RTSP</protocolType>"
            "<streamType>main</streamType>"
            "</DynamicChannel>"
        )
        url = f"{self._base(host, creds)}/ISAPI/ContentMgmt/dynamicChannels/{int(channel)}"
        # LIVE-VALIDATE: real Hik decoder dynamic-decode push (RTSP → output window) on the wire.
        return await self._put_strict(url, creds, payload, action="display")

    # ── clear an output ──────────────────────────────────────────────────────
    async def clear(
        self, host: str, creds: DecoderCredentials, channel: int, cell: int | None = None
    ) -> DecoderResult:
        """PUT /ISAPI/ContentMgmt/dynamicChannels/<ch> with an empty ``<srcUrl>`` — stop
        decoding on window ``cell`` (or the whole output when None). Never raises."""
        if not await _tcp_reachable(host, creds.port):
            return DecoderResult(ok=False, error="decoder host unreachable (TCP)")
        window = "" if cell is None else f"<window>{int(cell)}</window>"
        payload = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<DynamicChannel xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0">'
            f"<id>{int(channel)}</id>"
            f"{window}"
            "<srcUrl></srcUrl>"
            "</DynamicChannel>"
        )
        url = f"{self._base(host, creds)}/ISAPI/ContentMgmt/dynamicChannels/{int(channel)}"
        # LIVE-VALIDATE: real Hik decoder stop-decoding call on the wire.
        return await self._put_strict(url, creds, payload, action="clear")

    # ── tour ─────────────────────────────────────────────────────────────────
    async def start_tour(
        self,
        host: str,
        creds: DecoderCredentials,
        channel: int,
        uris: list[str],
        dwell: int = 10,
    ) -> DecoderResult:
        """PUT a wall-plan cycling ``uris`` on output ``channel`` at ``dwell`` seconds.
        Hik exposes this as a "video wall plan / auto-switch". Never raises."""
        if not uris:
            return DecoderResult(ok=False, error="empty tour uri list")
        if not await _tcp_reachable(host, creds.port):
            return DecoderResult(ok=False, error="decoder host unreachable (TCP)")
        items = "".join(
            f"<PlanItem><window>{i}</window><srcUrl>{escape(u)}</srcUrl>"
            f"<dwellTime>{int(dwell)}</dwellTime></PlanItem>"
            for i, u in enumerate(uris)
        )
        payload = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<VideoWallPlan xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0">'
            f"<id>{int(channel)}</id>"
            "<enabled>true</enabled>"
            f"{items}"
            "</VideoWallPlan>"
        )
        url = f"{self._base(host, creds)}/ISAPI/ContentMgmt/dynamicChannels/{int(channel)}/plan"
        # LIVE-VALIDATE: real Hik decoder wall-plan / auto-switch call on the wire.
        return await self._put_strict(url, creds, payload, action="start_tour")

    # ── shared write path ─────────────────────────────────────────────────────
    async def _put_strict(
        self, url: str, creds: DecoderCredentials, payload: str, *, action: str
    ) -> DecoderResult:
        """Digest-authed ISAPI PUT → ``DecoderResult`` (graceful; never raises)."""
        try:
            body = await _http.request_strict(
                "PUT",
                url,
                creds.username,
                creds.password,
                content=payload,
                headers={"Content-Type": "application/xml"},
                verify_tls=creds.verify_tls,
            )
            return DecoderResult(ok=True, detail=(body or "")[:200])
        except _http.BrandHTTPError as exc:
            log.info("Hik decoder %s failed (%s): %s", action, url, exc)
            return DecoderResult(ok=False, error=f"Hik decoder {action} failed: {exc}")
        except Exception as exc:  # noqa: BLE001
            log.info("Hik decoder %s error (%s): %s", action, url, exc)
            return DecoderResult(ok=False, error=f"Hik decoder {action} error: {exc}")
