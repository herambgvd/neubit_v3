"""Driver factory — pick a ``CameraDriver`` by ``brand``.

This is the seam that makes camera/NVR brands pluggable, exactly mirroring the access
service's ``connectors/factory.get_connector``. The onboarding + config service layer
only ever calls ``get_driver(brand)`` and gets back something implementing
``CameraDriver``; adding a brand = a module + one mapping entry, no service changes.

Unknown / empty brand → ``OnvifDriver`` (the default). ONVIF Profile S is a near-universal
baseline, so falling back to it (rather than raising) is the right behaviour for a camera
of unknown make — most devices answer ONVIF. This differs from the access factory (which
raises for unknown controller brands) because there is a sensible universal default here.

Aliases fold vendor spellings + Dahua-lineage OEMs onto their driver:
  * ``dahua`` → CpPlusDriver (CP-Plus is Dahua-lineage; same HTTP-CGI protocol).
  * ``hik`` → HikvisionDriver.

``lumina`` → LuminaDriver, a faithful port of neubit_v2's dedicated Lumina HTTP-API
integration (NOT an ONVIF subclass — Lumina has its own REST/JSON surface).
"""

from __future__ import annotations

from .base import CameraDriver
from .cpplus import CpPlusDriver
from .hikvision import HikvisionDriver
from .lumina import LuminaDriver
from .onvif import OnvifDriver

# brand key → driver class. ``onvif`` is the universal default.
_REGISTRY: dict[str, type[CameraDriver]] = {
    "onvif": OnvifDriver,
    "hikvision": HikvisionDriver,
    "hik": HikvisionDriver,
    "cpplus": CpPlusDriver,
    "cp-plus": CpPlusDriver,
    "dahua": CpPlusDriver,  # Dahua-lineage → same CGI protocol as CP-Plus.
    "lumina": LuminaDriver,
}


def get_driver(brand: str | None) -> CameraDriver:
    """Return a driver instance for ``brand`` (case-insensitive). Unknown/empty →
    ``OnvifDriver`` (ONVIF is the universal fallback). Drivers are stateless — every
    method takes ``host`` + ``Credentials`` — so a fresh instance per call is cheap."""
    key = (brand or "onvif").strip().lower()
    driver_cls = _REGISTRY.get(key, OnvifDriver)
    return driver_cls()


def supported_brands() -> list[str]:
    """List the registered brand keys (for the onboarding UI's brand dropdown)."""
    return sorted(_REGISTRY)
