"""Thin async client for the Go ``nvr`` data-plane (service-to-service, D8 split).

vision (Python control) calls the Go ``nvr`` (data) over the INTERNAL docker
network — ``VE_NVR_URL`` (default ``http://nvr:8000``) — to bring a MediaMTX path
up/down. We forward the CALLER's JWT as the ``Authorization: Bearer`` so nvr
authorizes the ensure/drop with the caller's own ``vms.*`` / wildcard grants (no
separate service credential — same shared-JWT contract both kernels honour).

Graceful: an unreachable nvr / a MediaMTX upstream error surfaces as
``NvrUnavailable`` → the router maps it to a clean **502**, never a 500.

Endpoints (JWT-gated on the nvr side):
  * ``POST /api/v1/nvr/streams/ensure {camera_id, rtsp_url, profile}``
      → ``{name, node, hls_url, webrtc_url, rtsp_url, ready, readers}``
  * ``DELETE /api/v1/nvr/streams/{camera_id}/{profile}``
"""

from __future__ import annotations

import logging
import os

import httpx

log = logging.getLogger("vision.nvr_client")

_DEFAULT_URL = "http://nvr:8000"
_DEFAULT_TIMEOUT = 15.0


class NvrUnavailable(Exception):
    """The nvr data-plane could not provision/tear-down the stream (→ 502)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def nvr_base_url() -> str:
    return (os.environ.get("VE_NVR_URL") or _DEFAULT_URL).rstrip("/")


class NvrClient:
    """Async REST client for the nvr streams API. One per request (cheap)."""

    def __init__(self, *, bearer: str | None, base_url: str | None = None) -> None:
        self._base = (base_url or nvr_base_url()).rstrip("/")
        self._headers = {"Authorization": f"Bearer {bearer}"} if bearer else {}

    async def ensure_stream(
        self, *, camera_id: str, rtsp_url: str, profile: str
    ) -> dict:
        """POST /streams/ensure → the playable URLs. Raises ``NvrUnavailable``."""
        url = f"{self._base}/api/v1/nvr/streams/ensure"
        payload = {"camera_id": camera_id, "rtsp_url": rtsp_url, "profile": profile}
        try:
            async with httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT) as client:
                resp = await client.post(url, json=payload, headers=self._headers)
        except httpx.HTTPError as exc:
            log.info("nvr ensure unreachable (%s): %s", url, exc)
            raise NvrUnavailable(f"nvr data-plane unreachable: {exc}") from exc
        if resp.status_code >= 400:
            detail = _err_detail(resp)
            log.info("nvr ensure %s → %s: %s", camera_id, resp.status_code, detail)
            raise NvrUnavailable(f"nvr could not ensure stream: {detail}")
        try:
            return resp.json()
        except ValueError as exc:
            raise NvrUnavailable("nvr returned a non-JSON ensure response") from exc

    async def drop_stream(self, *, camera_id: str, profile: str) -> bool:
        """DELETE /streams/{camera_id}/{profile}. Best-effort — never raises."""
        url = f"{self._base}/api/v1/nvr/streams/{camera_id}/{profile}"
        try:
            async with httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT) as client:
                resp = await client.delete(url, headers=self._headers)
            return resp.status_code < 400
        except httpx.HTTPError as exc:
            log.info("nvr drop best-effort failed (%s): %s", url, exc)
            return False


def _err_detail(resp: httpx.Response) -> str:
    try:
        body = resp.json()
        if isinstance(body, dict):
            err = body.get("error")
            if isinstance(err, dict) and err.get("message"):
                return str(err["message"])
        return str(body)[:200]
    except ValueError:
        return (resp.text or "")[:200]
