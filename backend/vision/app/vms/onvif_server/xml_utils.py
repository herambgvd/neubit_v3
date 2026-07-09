"""Shared ONVIF SOAP namespace constants + lxml helpers (P6-C).

Ported from gvd_nvr ``onvif_device/handlers/_common.py`` — the namespace table + the
envelope/body/add-text builders + the request-field extractors. Adapted to the v3
tenant-scoped server (no module-level device creds — the creds live per-tenant in the
``OnvifServerConfig`` row, resolved by the SOAP auth path).
"""

from __future__ import annotations

import re
from typing import Any, Optional

from lxml import etree

# ── Namespace constants ─────────────────────────────────────────────────────
NS_SOAP = "http://www.w3.org/2003/05/soap-envelope"
NS_WSSE = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
NS_WSU = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"
NS_WSA = "http://www.w3.org/2005/08/addressing"
NS_TDS = "http://www.onvif.org/ver10/device/wsdl"
NS_TRT = "http://www.onvif.org/ver10/media/wsdl"
NS_TR2 = "http://www.onvif.org/ver20/media/wsdl"
NS_TRC = "http://www.onvif.org/ver10/recording/wsdl"
NS_TSE = "http://www.onvif.org/ver10/search/wsdl"
NS_TRP = "http://www.onvif.org/ver10/replay/wsdl"
NS_TEV = "http://www.onvif.org/ver10/events/wsdl"
NS_TT = "http://www.onvif.org/ver10/schema"


def _qn(ns: str, tag: str) -> str:
    return "{%s}%s" % (ns, tag)


def soap_envelope() -> etree.Element:
    return etree.Element(
        _qn(NS_SOAP, "Envelope"),
        nsmap={
            "soap": NS_SOAP,
            "tt": NS_TT,
            "tds": NS_TDS,
            "trt": NS_TRT,
            "tr2": NS_TR2,
            "trc": NS_TRC,
            "tse": NS_TSE,
            "trp": NS_TRP,
            "tev": NS_TEV,
            "wsa": NS_WSA,
        },
    )


def soap_body(envelope: etree.Element) -> etree.Element:
    return etree.SubElement(envelope, _qn(NS_SOAP, "Body"))


def add_text(parent: etree.Element, ns: str, tag: str, text: Any) -> etree.Element:
    el = etree.SubElement(parent, _qn(ns, tag))
    el.text = "" if text is None else str(text)
    return el


def _parse(xml_bytes: bytes | str) -> Optional[etree._Element]:
    """Tolerant parse — strips leading whitespace/BOM that some clients emit."""
    try:
        if isinstance(xml_bytes, (bytes, bytearray)):
            return etree.fromstring(bytes(xml_bytes).lstrip())
        return etree.fromstring(xml_bytes.lstrip())
    except Exception:  # noqa: BLE001
        return None


def extract_action(body_bytes: bytes, soapaction_header: str | None) -> str:
    """The ONVIF operation name: the SOAPAction header, else the first Body child tag."""
    if soapaction_header:
        action = soapaction_header.strip().strip('"')
        if action:
            return action
    root = _parse(body_bytes)
    if root is not None:
        body = root.find(_qn(NS_SOAP, "Body"))
        if body is not None and len(body) > 0:
            return body[0].tag
    return ""


def extract_field(xml_bytes: bytes, field: str) -> Optional[str]:
    """First matching descendant element's text (namespace-agnostic)."""
    root = _parse(xml_bytes)
    if root is None:
        return None
    el = root.find(".//" + field)
    if el is None:
        el = root.find(".//{*}" + field)
    return el.text if el is not None else None


def extract_profile_token(xml_bytes: bytes) -> Optional[str]:
    return extract_field(xml_bytes, "ProfileToken")


def extract_recording_token(xml_bytes: bytes) -> Optional[str]:
    return extract_field(xml_bytes, "RecordingToken")


def parse_time(text: Optional[str]):
    """ISO-8601 (with Z or offset) → aware-UTC datetime, or None."""
    from datetime import datetime, timezone

    if not text:
        return None
    t = text.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(t)
    except ValueError:
        t2 = re.sub(r"\.\d+", "", t)
        try:
            dt = datetime.fromisoformat(t2)
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def extract_time_range(xml_bytes: bytes):
    """(StartPoint/StartTime, EndPoint/EndTime) from a Find/Replay request body."""
    root = _parse(xml_bytes)
    if root is None:
        return None, None
    def _first(*tags):
        for tag in tags:
            el = root.find(".//{*}" + tag)
            if el is None:
                el = root.find(".//" + tag)
            if el is not None and el.text:
                return el
        return None

    start = end = None
    s_el = _first("StartPoint", "StartTime")
    if s_el is not None:
        start = parse_time(s_el.text)
    e_el = _first("EndPoint", "EndTime")
    if e_el is not None:
        end = parse_time(e_el.text)
    return start, end


def parse_resolution(res: Optional[str]) -> tuple[int, int]:
    if not res:
        return 1920, 1080
    try:
        parts = str(res).lower().split("x")
        if len(parts) == 2:
            return int(parts[0]), int(parts[1])
    except Exception:  # noqa: BLE001
        pass
    return 1920, 1080


def serialize(envelope: etree.Element) -> bytes:
    return etree.tostring(
        envelope, pretty_print=True, xml_declaration=True, encoding="UTF-8"
    )
