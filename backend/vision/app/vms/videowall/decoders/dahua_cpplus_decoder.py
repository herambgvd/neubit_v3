"""DahuaCpPlusDecoder — Dahua / CP-Plus hardware video-decoder driver (CGI, HTTP Digest).

CP-Plus is a Dahua OEM, so one Dahua driver covers both — the same as the ``CpPlusDriver``
camera driver. A Dahua decoder (NVD / M70 families) exposes the HTTP-CGI surface
(``/cgi-bin/*.cgi`` with ``key=value`` text over HTTP Digest), the same auth + transport the
camera driver uses. This driver drives the decoder's DECODE + split-window CGI so the wall
service can push a camera's RTSP onto a decoder output cell.

CGI decoder endpoint map (all HTTP Digest) — from Dahua's published HTTP-API-decoder spec:
  * probe / identity   GET ``/cgi-bin/magicBox.cgi?action=getSystemInfo``     → serial/deviceType.
                       GET ``/cgi-bin/magicBox.cgi?action=getSoftwareVersion`` → firmware.
  * output count       GET ``/cgi-bin/magicBox.cgi?action=getProductDefinition`` (MaxOutputChannels).
  * output layout      GET ``/cgi-bin/configManager.cgi?action=setConfig&VideoWidget[<ch>].SplitMode=<mode>``
                       (split mode 1/4/9/16 on decode output ``<ch>``).
  * display a stream   GET ``/cgi-bin/decoder.cgi?action=makeConnect&channel=<cell>&url=<rtsp>``
                       — the "decode this RTSP onto this window" call (Dahua decode connect).
  * clear an output    GET ``/cgi-bin/decoder.cgi?action=closeConnect&channel=<cell>``.
  * tour               GET ``/cgi-bin/decoder.cgi?action=setTour...`` (brand decode-tour).

# LIVE-VALIDATE: the CGI decoder endpoints + params below follow Dahua's published
# HTTP-API-decoder spec, but exact actions (``makeConnect`` vs ``decoder.cgi?action=setConfig``
# vs ``displaySource.cgi``), the channel/window indexing and the ``VideoWidget`` split-config
# key vary by decoder model + firmware. Every on-wire push call is marked ``# LIVE-VALIDATE``
# — confirm against a real Dahua / CP-Plus decoder appliance.
"""

from __future__ import annotations

import logging
from urllib.parse import quote

from . import _http
from .decoder_base import (
    DecoderCredentials,
    DecoderDriver,
    DecoderInfo,
    DecoderResult,
    _tcp_reachable,
)

log = logging.getLogger("vision.drivers.dahua_cpplus_decoder")

# Dahua split-mode CGI value per cell count.
_GRID_SPLIT = {1: 1, 4: 4, 9: 9, 16: 16}


class DahuaCpPlusDecoder(DecoderDriver):
    """Dahua / CP-Plus HTTP-CGI hardware-decoder driver (HTTP Digest). All actions
    degrade gracefully (never raise) — a best-effort wall push must not break wall
    state."""

    brand = "dahua_cpplus"

    def _base(self, host: str, creds: DecoderCredentials) -> str:
        scheme = "https" if creds.verify_tls else "http"
        return f"{scheme}://{host}:{creds.port}"

    # ── probe / identity ─────────────────────────────────────────────────────
    async def probe(self, host: str, creds: DecoderCredentials) -> DecoderInfo:
        """GET magicBox.cgi?action=getSystemInfo → identity. Never raises."""
        if not await _tcp_reachable(host, creds.port):
            return DecoderInfo(reachable=False, error="decoder host unreachable (TCP)")
        base = self._base(host, creds)
        body = await _http.get_text(
            f"{base}/cgi-bin/magicBox.cgi?action=getSystemInfo",
            creds.username,
            creds.password,
            verify_tls=creds.verify_tls,
        )
        if body is None:
            return DecoderInfo(
                reachable=False, error="CGI getSystemInfo unreachable or auth failed"
            )
        kv = _http.parse_cgi_kv(body)
        info = DecoderInfo(
            reachable=True,
            manufacturer="Dahua",
            model=kv.get("deviceType"),
            serial_number=kv.get("serialNumber"),
            raw={"systemInfo_len": len(body)},
        )
        ver = await _http.get_text(
            f"{base}/cgi-bin/magicBox.cgi?action=getSoftwareVersion",
            creds.username,
            creds.password,
            verify_tls=creds.verify_tls,
        )
        if ver:
            info.firmware = _http.parse_cgi_kv(ver).get("version")
        prod = await _http.get_text(
            f"{base}/cgi-bin/magicBox.cgi?action=getProductDefinition",
            creds.username,
            creds.password,
            verify_tls=creds.verify_tls,
        )
        if prod:
            pkv = _http.parse_cgi_kv(prod)
            for key in ("MaxOutputChannels", "table.ProductDefinition.MaxOutputChannels"):
                if key in pkv:
                    try:
                        info.channel_count = int(pkv[key])
                    except (TypeError, ValueError):
                        pass
                    break
        return info

    # ── output layout (split-screen) ─────────────────────────────────────────
    async def set_layout(
        self, host: str, creds: DecoderCredentials, channel: int, grid: int
    ) -> DecoderResult:
        """GET configManager.cgi?action=setConfig&VideoWidget[<ch>].SplitMode=<n> —
        set the split-window count on decode output ``channel``. Never raises."""
        split = _GRID_SPLIT.get(grid)
        if split is None:
            return DecoderResult(ok=False, error=f"unsupported grid {grid} (want 1|4|9|16)")
        if not await _tcp_reachable(host, creds.port):
            return DecoderResult(ok=False, error="decoder host unreachable (TCP)")
        url = (
            f"{self._base(host, creds)}/cgi-bin/configManager.cgi?action=setConfig"
            f"&VideoWidget[{int(channel)}].SplitMode={int(split)}"
        )
        # LIVE-VALIDATE: real Dahua decoder split-mode CGI call on the wire.
        return await self._get_strict(url, creds, action="set_layout")

    # ── display a stream on an output cell ───────────────────────────────────
    async def display(
        self, host: str, creds: DecoderCredentials, channel: int, cell: int, rtsp_uri: str
    ) -> DecoderResult:
        """GET decoder.cgi?action=makeConnect&channel=<cell>&url=<rtsp> — decode
        ``rtsp_uri`` onto window ``cell`` of decode output ``channel``. Never raises.

        Dahua's decode-connect indexes the target window by a flat channel id; we combine
        the output ``channel`` + ``cell`` window as ``channel*100 + cell`` (LIVE-VALIDATE
        the exact target-window addressing on the real appliance)."""
        if not rtsp_uri:
            return DecoderResult(ok=False, error="empty rtsp_uri")
        if not await _tcp_reachable(host, creds.port):
            return DecoderResult(ok=False, error="decoder host unreachable (TCP)")
        target = int(channel) * 100 + int(cell)
        url = (
            f"{self._base(host, creds)}/cgi-bin/decoder.cgi?action=makeConnect"
            f"&channel={target}&url={quote(rtsp_uri, safe='')}"
        )
        # LIVE-VALIDATE: real Dahua decoder makeConnect (RTSP → output window) on the wire.
        return await self._get_strict(url, creds, action="display")

    # ── clear an output ──────────────────────────────────────────────────────
    async def clear(
        self, host: str, creds: DecoderCredentials, channel: int, cell: int | None = None
    ) -> DecoderResult:
        """GET decoder.cgi?action=closeConnect&channel=<target> — stop decoding on window
        ``cell`` (or the whole output when None). Never raises."""
        if not await _tcp_reachable(host, creds.port):
            return DecoderResult(ok=False, error="decoder host unreachable (TCP)")
        if cell is None:
            # Whole-output clear — Dahua closes all windows on the output channel.
            url = (
                f"{self._base(host, creds)}/cgi-bin/decoder.cgi?action=closeConnect"
                f"&channel={int(channel)}&all=true"
            )
        else:
            target = int(channel) * 100 + int(cell)
            url = (
                f"{self._base(host, creds)}/cgi-bin/decoder.cgi?action=closeConnect"
                f"&channel={target}"
            )
        # LIVE-VALIDATE: real Dahua decoder closeConnect call on the wire.
        return await self._get_strict(url, creds, action="clear")

    # ── tour ─────────────────────────────────────────────────────────────────
    async def start_tour(
        self,
        host: str,
        creds: DecoderCredentials,
        channel: int,
        uris: list[str],
        dwell: int = 10,
    ) -> DecoderResult:
        """GET decoder.cgi?action=setTour&channel=<ch>&... — cycle ``uris`` on output
        ``channel`` at ``dwell`` seconds. Never raises."""
        if not uris:
            return DecoderResult(ok=False, error="empty tour uri list")
        if not await _tcp_reachable(host, creds.port):
            return DecoderResult(ok=False, error="decoder host unreachable (TCP)")
        params = [
            f"action=setTour",
            f"channel={int(channel)}",
            f"interval={int(dwell)}",
        ]
        for i, u in enumerate(uris):
            params.append(f"url[{i}]={quote(u, safe='')}")
        url = f"{self._base(host, creds)}/cgi-bin/decoder.cgi?" + "&".join(params)
        # LIVE-VALIDATE: real Dahua decoder decode-tour CGI call on the wire.
        return await self._get_strict(url, creds, action="start_tour")

    # ── shared write path ─────────────────────────────────────────────────────
    async def _get_strict(
        self, url: str, creds: DecoderCredentials, *, action: str
    ) -> DecoderResult:
        """Digest-authed CGI GET → ``DecoderResult`` (graceful; never raises).

        Dahua CGI write actions are GET requests answering ``OK`` on success."""
        try:
            body = await _http.request_strict(
                "GET", url, creds.username, creds.password, verify_tls=creds.verify_tls
            )
            return DecoderResult(ok=True, detail=(body or "")[:200])
        except _http.BrandHTTPError as exc:
            log.info("Dahua decoder %s failed (%s): %s", action, url, exc)
            return DecoderResult(ok=False, error=f"Dahua decoder {action} failed: {exc}")
        except Exception as exc:  # noqa: BLE001
            log.info("Dahua decoder %s error (%s): %s", action, url, exc)
            return DecoderResult(ok=False, error=f"Dahua decoder {action} error: {exc}")
