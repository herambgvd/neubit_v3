"""Decoder-driver factory — pick a ``DecoderDriver`` by ``brand`` (VW-B).

The seam that makes decoder brands pluggable, mirroring ``factory.get_driver`` for cameras.
The wall service only ever calls ``get_decoder_driver(brand)`` and gets back something
implementing ``DecoderDriver``; adding a brand = a module + one mapping entry.

Unlike the camera factory (which falls back to ONVIF for unknown brands — a near-universal
baseline), decoders have NO universal protocol, so an unknown/empty brand returns ``None``
(graceful degrade — the wall service logs + skips the push, never crashing the wall).

Aliases fold vendor spellings + Dahua-lineage OEMs onto their driver:
  * ``dahua`` / ``cpplus`` / ``cp-plus`` → DahuaCpPlusDecoder (CP-Plus is a Dahua OEM).
  * ``hik`` → HikvisionDecoder.
"""

from __future__ import annotations

from .dahua_cpplus_decoder import DahuaCpPlusDecoder
from .decoder_base import DecoderDriver
from .hikvision_decoder import HikvisionDecoder

# brand key → decoder driver class.
_REGISTRY: dict[str, type[DecoderDriver]] = {
    "hikvision": HikvisionDecoder,
    "hik": HikvisionDecoder,
    "dahua_cpplus": DahuaCpPlusDecoder,
    "dahua": DahuaCpPlusDecoder,
    "cpplus": DahuaCpPlusDecoder,
    "cp-plus": DahuaCpPlusDecoder,
}


def get_decoder_driver(brand: str | None) -> DecoderDriver | None:
    """Return a decoder-driver instance for ``brand`` (case-insensitive), or ``None`` for
    an unknown/empty brand — the wall service treats ``None`` as "no decoder push"
    (graceful degrade). Drivers are stateless — a fresh instance per call is cheap."""
    if not brand:
        return None
    key = brand.strip().lower()
    driver_cls = _REGISTRY.get(key)
    return driver_cls() if driver_cls else None


def supported_decoder_brands() -> list[str]:
    """List the registered brand keys (for the decoder-registration UI dropdown)."""
    return sorted(_REGISTRY)
