"""Shared HTTP helpers for brand REST/CGI drivers (Hikvision ISAPI, Dahua CGI).

Both Hikvision (ISAPI) and Dahua/CP-Plus (HTTP-CGI) authenticate with HTTP Digest
and return small XML (ISAPI) or key=value text (Dahua CGI) bodies. This module
centralizes the graceful, digest-authed request pattern so the brand drivers stay
declarative (endpoint map + parser), mirroring how the access DDS connector keeps
its ``_client``/``_auth`` plumbing in one place.

Everything degrades gracefully: ``get_text`` / ``get_bytes`` return ``None`` on any
transport/HTTP error (the caller decides whether that means "empty" or "unreachable").
``BrandHTTPError`` is only raised by the explicit ``request_strict`` path used for
operator write actions (PTZ / configure) where a silent failure would mislead.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

log = logging.getLogger("vision.drivers.http")

DEFAULT_TIMEOUT = 8.0


class BrandHTTPError(Exception):
    """Raised by ``request_strict`` when a brand endpoint returns >= 400 (write path)."""

    def __init__(self, status_code: int, body_text: str) -> None:
        self.status_code = status_code
        self.body_text = body_text
        super().__init__(f"brand HTTP {status_code}: {body_text[:200]}")


def _auth(username: str, password: str) -> httpx.DigestAuth:
    """HTTP Digest auth — the scheme both Hikvision ISAPI and Dahua CGI use.
    (Both also accept Basic, but Digest is the vendor default + safer.)"""
    return httpx.DigestAuth(username or "admin", password or "")


async def get_text(
    url: str, username: str, password: str, *, verify_tls: bool = False, timeout: float = DEFAULT_TIMEOUT
) -> str | None:
    """GET → response text, or ``None`` on any failure (unreachable/4xx/5xx). Never raises."""
    try:
        async with httpx.AsyncClient(timeout=timeout, verify=verify_tls) as client:
            r = await client.get(url, auth=_auth(username, password))
        if r.status_code >= 400:
            log.debug("GET %s → HTTP %s", url, r.status_code)
            return None
        return r.text
    except Exception as exc:  # noqa: BLE001
        log.debug("GET %s failed: %s", url, exc)
        return None


async def get_bytes(
    url: str, username: str, password: str, *, verify_tls: bool = False, timeout: float = DEFAULT_TIMEOUT
) -> bytes | None:
    """GET → response bytes (e.g. a JPEG snapshot), or ``None`` on failure. Never raises."""
    try:
        async with httpx.AsyncClient(timeout=timeout, verify=verify_tls) as client:
            r = await client.get(url, auth=_auth(username, password))
        if r.status_code == 200 and r.content:
            return r.content
        return None
    except Exception as exc:  # noqa: BLE001
        log.debug("GET(bytes) %s failed: %s", url, exc)
        return None


async def post_text(
    url: str,
    username: str,
    password: str,
    *,
    content: str | bytes | None = None,
    headers: dict[str, str] | None = None,
    verify_tls: bool = False,
    timeout: float = DEFAULT_TIMEOUT,
) -> str | None:
    """POST → response text, or ``None`` on any failure (unreachable/4xx/5xx). Never raises.

    The graceful counterpart to ``request_strict`` for READ-style POSTs (e.g. the
    Hikvision ISAPI ``ContentMgmt/search`` footage query, which POSTs a search body but
    is a read). Digest-authed like the GET helpers."""
    try:
        async with httpx.AsyncClient(timeout=timeout, verify=verify_tls) as client:
            r = await client.post(url, auth=_auth(username, password), content=content, headers=headers)
        if r.status_code >= 400:
            log.debug("POST %s → HTTP %s", url, r.status_code)
            return None
        return r.text
    except Exception as exc:  # noqa: BLE001
        log.debug("POST %s failed: %s", url, exc)
        return None


async def request_strict(
    method: str,
    url: str,
    username: str,
    password: str,
    *,
    content: str | bytes | None = None,
    headers: dict[str, str] | None = None,
    verify_tls: bool = False,
    timeout: float = DEFAULT_TIMEOUT,
) -> str:
    """Digest-authed request for operator WRITE actions (PTZ / configure). Raises
    ``BrandHTTPError`` on >= 400 or transport failure (explicit action must surface)."""
    try:
        async with httpx.AsyncClient(timeout=timeout, verify=verify_tls) as client:
            r = await client.request(method, url, auth=_auth(username, password), content=content, headers=headers)
        if r.status_code >= 400:
            raise BrandHTTPError(r.status_code, r.text)
        return r.text
    except BrandHTTPError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise BrandHTTPError(502, f"request failed: {exc}") from None


# ── Tiny stdlib XML/text parsers (avoid a lxml dep; ISAPI + CGI bodies are small) ──
def xml_text(body: str, *local_names: str) -> str | None:
    """Return the text of the first element whose *local* tag name matches any of
    ``local_names`` (namespace-agnostic — ISAPI uses a default xmlns). ``None`` if
    absent or unparseable. Never raises."""
    import xml.etree.ElementTree as ET

    try:
        root = ET.fromstring(body)
    except Exception:  # noqa: BLE001
        return None
    wanted = {n.lower() for n in local_names}
    for el in root.iter():
        tag = el.tag.rsplit("}", 1)[-1].lower()  # strip {namespace}
        if tag in wanted and el.text and el.text.strip():
            return el.text.strip()
    return None


def xml_findall(body: str, local_name: str) -> list[Any]:
    """Return all elements whose local tag name == ``local_name`` (namespace-agnostic).
    Empty list on failure. Never raises."""
    import xml.etree.ElementTree as ET

    try:
        root = ET.fromstring(body)
    except Exception:  # noqa: BLE001
        return []
    want = local_name.lower()
    return [el for el in root.iter() if el.tag.rsplit("}", 1)[-1].lower() == want]


def el_text(element: Any, *local_names: str) -> str | None:
    """Text of a child element (by local name) within a parsed XML element. Never raises."""
    wanted = {n.lower() for n in local_names}
    try:
        for child in element.iter():
            tag = child.tag.rsplit("}", 1)[-1].lower()
            if tag in wanted and child.text and child.text.strip():
                return child.text.strip()
    except Exception:  # noqa: BLE001
        return None
    return None


def parse_cgi_kv(body: str) -> dict[str, str]:
    """Parse a Dahua/CP-Plus CGI ``key=value`` (one per line) body into a flat dict.
    Dahua nests with dotted/bracketed keys (``table.General.MachineName=...``) —
    kept verbatim as flat keys. Never raises."""
    out: dict[str, str] = {}
    for line in (body or "").splitlines():
        line = line.strip()
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip()
    return out
